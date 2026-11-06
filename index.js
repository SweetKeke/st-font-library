/* SillyTavern Font Library — v1.3.0 */
const EXT_KEY = 'kk_font_library_v1';
const DB_NAME = 'kk-st-font-library';
const STORE = 'fonts';
const STYLE_ID = 'kk-font-library-applied';
const PANEL_ID = 'kk-font-library-panel';
const PREVIEW_SAMPLES = {
  'zh-CN': '月光落在旧日的信纸上。她轻声问：“你还记得吗？”',
  ja: '窓辺に月の光が差す。「あの手紙、まだ覚えてる？」',
  en: '“Still awake?” The quick brown fox jumps over the lazy dog!',
  ko: '창가에 달빛이 비쳤다. “그 편지, 아직 기억해?”',
};
const DEFAULTS = { entries: [], activeId: '', enabled: true, weight: 400, adjustBody: false, scope: 'chat', pageSize: 10 };
let settings, save;
let currentPage = 1;
let storageKey;
let shared = false;
const api = '/api/plugins/st-font-library';
async function serverRequest(path, options) {
  const response = await fetch(api + path, {cache:'no-store', ...options});
  if (!response.ok) throw new Error('酒馆字体库请求失败（' + response.status + '），请刷新重试。');
  return response;
}
async function changeEntry(path, body) {
  return serverRequest(path, {method:'POST', headers:window.SillyTavern.getContext().getRequestHeaders(), body:JSON.stringify(body)});
}
async function uploadEntry(entry, file) {
  const meta = new TextEncoder().encode(JSON.stringify(entry));
  const size = new DataView(new ArrayBuffer(4));
  size.setUint32(0,meta.length);
  const headers = {...window.SillyTavern.getContext().getRequestHeaders(), 'Content-Type':'application/octet-stream'};
  const body = new Blob([size, meta, ...(file ? [file] : [])]);
  return (await serverRequest('/add', {method:'POST',headers,body})).json();
}
async function readShared(){
  const entries = await (await serverRequest('/list')).json();
  if (!Array.isArray(entries)) throw new Error('酒馆字体库未启动。');
  return {...DEFAULTS,...JSON.parse(localStorage.getItem(storageKey+':prefs') || '{}'),entries};
}
let activeFace;
let activeFamily;
let onlineBase;
let currentToken = 0;
const byId = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const uuid = () => (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const quoteCss = (s) => `"${String(s).replace(/[\\"\n\r\f]/g, '')}"`;
const info = (m, error = false) => { const el = byId('kkfl-status'); if (el) { el.textContent=m; el.classList.toggle('error', error); } if (error) console.error('[Font Library]', m); };

function getDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbAct(mode, key, value, checkOnly = false) {
  const db = await getDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let req;
      if (mode === 'readonly') req = checkOnly ? store.getKey(key) : store.get(key);
      else if (Array.isArray(key)) key.forEach(id => store.delete(id));
      else if (value === undefined) store.delete(key);
      else store.put(value, key);
      tx.oncomplete = () => resolve(req?.result);
      tx.onabort = () => reject(tx.error || new Error('字体数据库操作已取消'));
    });
  } finally { db.close(); }
}
const validWeight = (v) => Math.max(100, Math.min(900, Math.round(Number(v || 400) / 100) * 100));
function update(fn) { fn(); save(); renderList(); }
function parseCssLink(input) {
  let value = input.trim();
  const match = value.match(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/i);
  if (match) value = match[1];
  if (!/^https?:\/\//i.test(value)) throw new Error('请输入 http(s) CSS 链接，或包含 @import 的代码。');
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('仅支持 HTTP(S) 链接。');
  return u.href;
}
function validFamily(v) {
  const family = v.trim();
  if (!family || family.length > 120) throw new Error('请填写字体的 CSS font-family 名称（最多 120 字）。');
  return family;
}
// Inspect only the table directory and name table. WOFF2 has a shared
// compressed stream, so use its filename without unpacking the whole font.
async function localName(file) {
  const fallback = file.name.replace(/\.[^.]+$/, '').trim() || '本地字体';
  try {
    const header = new DataView(await file.slice(0, 44).arrayBuffer());
    const signature = header.getUint32(0);
    if (![0x774f4646, 0x00010000, 0x4f54544f].includes(signature)) return fallback;
    const woff = signature === 0x774f4646;
    const count = header.getUint16(woff ? 12 : 4);
    const start = woff ? 44 : 12, stride = woff ? 20 : 16;
    const directory = new DataView(await file.slice(start, start + count * stride).arrayBuffer());
    for (let i = 0; i < directory.byteLength; i += stride) {
      if (directory.getUint32(i) !== 0x6e616d65) continue;
      const offset = directory.getUint32(i + (woff ? 4 : 8));
      const length = directory.getUint32(i + (woff ? 8 : 12));
      const original = woff ? directory.getUint32(i + 12) : length;
      if (original > 1024 * 1024 || length > original || offset + length > file.size) break;
      const table = file.slice(offset, offset + length);
      const bytes = original === length ? await table.arrayBuffer() :
        await new Response(table.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
      const names = new DataView(bytes);
      let best = '', score = 0;
      for (let j = 0; j < names.getUint16(2); j++) {
        const pos = 6 + j * 12, platform = names.getUint16(pos), id = names.getUint16(pos + 6);
        if (![0, 3].includes(platform) || ![1, 4, 16].includes(id)) continue;
        const rank = (names.getUint16(pos + 4) % 1024 === 4 ? 10 : 0) + (id === 16 ? 3 : id === 1 ? 2 : 1);
        if (rank <= score) continue;
        const data = new Uint8Array(bytes, names.getUint16(4) + names.getUint16(pos + 10), names.getUint16(pos + 8));
        const value = new TextDecoder('utf-16be').decode(data).trim();
        if (value) { best = value; score = rank; }
      }
      return best || fallback;
    }
  } catch { /* Optional metadata; the filename is always usable. */ }
  return fallback;
}
async function onlineFamily(url) {
  const candidate = new URL(url).searchParams.get('family')?.split(/[:|]/)[0];
  try {
    const response = await fetch(url, {credentials:'omit', signal:AbortSignal.timeout(7000)});
    if (response.ok) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await response.text());
      for (const rule of sheet.cssRules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const family = rule.style.fontFamily.replace(/^(['"])(.*)\1$/, '$2');
        if (family) return family;
      }
    }
  } catch { /* Some font hosts block cross-origin stylesheet inspection. */ }
  if (candidate) return candidate;
  throw new Error('无法从这个链接读取字体名。请在“CSS 字体名”中填入字体网站提供的 font-family。');
}
function weightStyle(item, value) {
  const target = validWeight(value);
  // Online families may provide real weights: prefer them unless simulation was requested.
  if (!item || item.variable || (item.type === 'remote' && !item.simulate && !onlineBase)) return {weight:target, stroke:0, alpha:100};
  const base = validWeight(item.fileWeight || onlineBase || 400);
  const delta = (target - base) / 100;
  return {weight:base, stroke:Math.max(0, delta) * 0.012, alpha:100 + Math.min(0, delta) * 6};
}
function cssSelectors(scope) {
  if (scope === 'global') return [
    'body', 'body button', 'body input:not([type="checkbox"]):not([type="radio"])',
    'body textarea', 'body select', 'body .mes_text', 'body .mes_text *:not(i):not(svg):not(path)',
    'body .mes .name_text', 'body .mes .timestamp', 'body #chat',
    'body #chat .mes .mes_block', 'body .drawer-content', 'body .menu_button'
  ];
  return ['#chat .mes_text', '#chat .mes_text *:not(i):not(svg):not(path)', '#chat .mes .name_text'];
}
function injectCSS(family) {
  const selectors = cssSelectors(settings.scope);
  const item = settings.entries.find(entry => entry.id === settings.activeId);
  const {weight, stroke, alpha} = weightStyle(item, settings.weight);
  const declaration = `font-family: ${quoteCss(family)}, sans-serif !important;`;
  // Explicitly exclude this extension's configuration controls from global styling.
  let rules = selectors.map(s => `${s}:not(#${PANEL_ID}):not(#${PANEL_ID} *) { ${declaration} }`).join('\n');
  if (settings.adjustBody) {
    let bodyStyle = `font-weight: ${weight};`;
    if (stroke) bodyStyle += ` -webkit-text-stroke-width: ${stroke}em;`;
    if (alpha < 100) bodyStyle += ` -webkit-text-fill-color: color-mix(in srgb, currentColor ${alpha}%, transparent);`;
    rules += `\n@layer kkflDefaults { :where(#chat .mes_text) { ${bodyStyle} } }`;
  }
  const node = byId(STYLE_ID) || Object.assign(document.createElement('style'), { id: STYLE_ID });
  node.textContent = rules;
  if (!node.isConnected) document.head.append(node);
}
function clearApplied() {
  ++currentToken;
  byId(STYLE_ID)?.remove();
  byId('kkfl-remote-style')?.remove();
  if (activeFace) document.fonts.delete(activeFace);
  activeFace = undefined;
  activeFamily = undefined;
  onlineBase = undefined;
}
async function apply() {
  clearApplied();
  const token = currentToken;
  if (!settings.enabled || !settings.activeId) { setActiveLabel(); return; }
  const item = settings.entries.find(x => x.id === settings.activeId);
  if (!item) { setActiveLabel(); return; }
  let family;
  if (item.type === 'remote') {
    family = item.family;
    const link = document.createElement('link');
    link.id = 'kkfl-remote-style';
    link.rel = 'stylesheet';
    link.href = item.url;
    link.onload = () => {
      if (token !== currentToken) return;
      const weights = new Set();
      for (const face of document.fonts) {
        if (face.family.replace(/^['"]|['"]$/g, '').toLowerCase() !== family.toLowerCase()) continue;
        weights.add(face.weight === 'normal' ? '400' : face.weight === 'bold' ? '700' : face.weight);
      }
      const [weight] = weights;
      if (weights.size === 1 && /^\d+$/.test(weight)) {
        onlineBase = Number(weight);
        injectCSS(family);
        updatePreview();
      }
    };
    document.head.append(link);
  } else {
    const file = shared ? await (await serverRequest('/font/'+encodeURIComponent(item.id))).blob() : await dbAct('readonly', item.id);
    if (token !== currentToken) return;
    if (!file) { info(`找不到本地字体「${item.name}」。可能是在另一台设备或浏览器添加的，请重新上传。`, true); setActiveLabel(); return; }
    const url = URL.createObjectURL(file);
    family = `kkfl-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    try {
      const face = new FontFace(family, `url(${quoteCss(url)})`, { weight: item.variable ? '100 900' : String(validWeight(item.fileWeight || 400)), style: 'normal' });
      await face.load();
      if (token !== currentToken) return;
      document.fonts.add(face);
      activeFace = face;
    } catch (error) {
      if (token === currentToken) info(`字体文件加载失败：${error.message}`, true);
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (token !== currentToken) return;
  activeFamily = family;
  injectCSS(family);
  setActiveLabel();
}
function setActiveLabel() {
  const item = settings.entries.find(x => x.id === settings.activeId);
  const el = byId('kkfl-current');
  if (el) el.textContent = settings.enabled && item ? `正在使用：${item.name}` : '正在使用：原有字体';
  const b = byId('kkfl-toggle');
  if (b) b.checked = Boolean(settings.enabled);
}
function renderList() {
  const list = byId('kkfl-list');
  if (!list) return;
  const pageSize = Math.max(1, Math.min(100, Number(settings.pageSize) || 10));
  const totalPages = Math.max(1, Math.ceil(settings.entries.length / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * pageSize;
  list.replaceChildren();
  list.scrollTop = 0;
  if (!settings.entries.length) { const blank = document.createElement('p'); blank.className='kkfl-muted'; blank.textContent='字体库为空，先在下方添加字体。'; list.append(blank); }
  for (const entry of settings.entries.slice(start, start + pageSize)) {
    const row = document.createElement('div'); row.className='kkfl-entry';
    const radio = document.createElement('input'); radio.type='radio'; radio.name='kkfl-selected'; radio.checked=entry.id===settings.activeId; radio.setAttribute('aria-label', `选择 ${entry.name}`);
    radio.addEventListener('change', () => { settings.activeId=entry.id; save(); apply().catch(e => info(e.message, true)); renderList(); });
    const label = document.createElement('div'); label.className='kkfl-entry-info';
    const title = document.createElement('strong'); title.textContent=entry.name;
    const detail = document.createElement('small'); detail.textContent=entry.type==='remote' ? `在线 CSS · ${entry.family}` : `本地文件 · ${entry.filename} ${entry.variable?'· 可变字重':''}`;
    title.title = entry.name;
    detail.title = detail.textContent;
    label.append(title, detail);
    const rename = document.createElement('button'); rename.type='button'; rename.textContent='改名'; rename.addEventListener('click', async () => {
      const v = prompt('新的显示名称', entry.name);
      if (v===null) return;
      if (!v.trim()) return info('名称不能为空。', true);
      const name=v.trim().slice(0,100);
      if (shared) {try {await changeEntry('/rename/'+entry.id,{name});}catch(e){return info(e.message,true);}}
      update(() => { entry.name=name; }); setActiveLabel();
    });
    const del = document.createElement('button'); del.type='button'; del.textContent='删除'; del.addEventListener('click', async () => {
      if (!confirm(`删除字体「${entry.name}」？`)) return;
      if (shared) {try {await changeEntry('/remove/'+entry.id,{});}catch(e){return info(e.message,true);}}
      else if (entry.type==='local') { try { await dbAct('readwrite', entry.id); } catch (e) { info('删除本地文件失败：'+e.message, true); return; } }
      const wasActive = settings.activeId === entry.id;
      update(() => { settings.entries=settings.entries.filter(x=>x.id!==entry.id); if(settings.activeId===entry.id) settings.activeId=''; });
      if (wasActive) apply().catch(e=>info(e.message,true));
    });
    rename.classList.add('menu_button');
    del.classList.add('menu_button');
    row.append(radio,label,rename,del); list.append(row);
  }
  const pageInput = byId('kkfl-page-size');
  if (pageInput && document.activeElement !== pageInput) pageInput.value = String(pageSize);
  const pageIndicator = byId('kkfl-page-indicator');
  if (pageIndicator) pageIndicator.textContent = currentPage + ' / ' + totalPages;
  const prev = byId('kkfl-page-prev');
  const next = byId('kkfl-page-next');
  if (prev) prev.disabled = currentPage <= 1;
  if (next) next.disabled = currentPage >= totalPages;
  const current = byId('kkfl-current'); if (current) setActiveLabel();
  byId('kkfl-migrate').hidden = !shared || !JSON.parse(localStorage.getItem(storageKey) || '{}').entries?.length;
  const w = byId('kkfl-weight'); if (w) w.value=String(settings.weight);
  byId('kkfl-adjust-body').checked = Boolean(settings.adjustBody);
  const out = byId('kkfl-weight-label'); if(out) out.textContent=String(settings.weight);
  const scope = byId('kkfl-scope'); if (scope) scope.value=settings.scope;
  updatePreview();
}
function updatePreview(value = settings.weight) {
  const el=byId('kkfl-preview'); if(!el) return;
  const item=settings.entries.find(x=>x.id===settings.activeId);
  const {weight, stroke, alpha} = weightStyle(item, value);
  el.style.webkitTextStrokeWidth = settings.enabled && stroke ? stroke + 'em' : '';
  el.style.webkitTextFillColor = settings.enabled && alpha < 100 ? `color-mix(in srgb, currentColor ${alpha}%, transparent)` : '';
  if(!item || !settings.enabled) { el.style.fontFamily=''; el.style.fontWeight=''; return; }
  el.style.fontFamily=quoteCss(item.type==='remote'?item.family:`kkfl-${item.id.replace(/[^a-zA-Z0-9_-]/g,'')}`);
  el.style.fontWeight=String(weight);
}
function makeEl(tag, id, text, attrs={}) {
  const e=document.createElement(tag); if(id)e.id=id;if(text!==undefined&&text!==null)e.textContent=text;
  Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v)); return e;
}
function createUI() {
  const host=document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if(!host) return false;
  if(byId(PANEL_ID)) return true;
  const root=makeEl('div',PANEL_ID); root.className='kkfl-root';
  root.innerHTML=`
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>字体收藏夹 · Font Library</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content kkfl-content">
        <button id="kkfl-migrate" type="button" hidden>导入此浏览器已有收藏</button>
        <div class="kkfl-top"><span id="kkfl-current"></span></div>
        <label><input id="kkfl-toggle" type="checkbox" /> 启用字体覆盖</label>
        <label for="kkfl-scope">字体应用范围</label><select id="kkfl-scope"><option value="chat">仅聊天正文与角色名</option><option value="global">主要酒馆界面和聊天内容</option></select>
        <label><input id="kkfl-adjust-body" type="checkbox" /> 将预览字重用于聊天正文</label>
        <label for="kkfl-weight">预览字重 <output id="kkfl-weight-label">400</output></label>
        <input type="range" id="kkfl-weight" min="100" max="900" step="100" value="400" />
        <div class="kkfl-muted">静态字体用描边模拟加粗，较轻的档位会淡化文字。拖动时可在下方预览。</div>
        <div class="kkfl-preview-box">
          <select id="kkfl-preview-language" aria-label="预览语言" title="预览语言">
            <option value="zh-CN">中文</option><option value="ja">日本語</option>
            <option value="en">English</option><option value="ko">한국어</option>
            <option value="all">多语对照</option>
          </select>
          <div id="kkfl-preview" class="kkfl-preview"></div>
        </div>
        <div class="kkfl-title kkfl-list-title">已添加字体</div><div id="kkfl-list"></div>
        <div class="kkfl-pagination">
          <label for="kkfl-page-size">每页显示</label>
          <input id="kkfl-page-size" type="number" min="1" max="100" step="1" value="10" aria-label="每页字体数量" />
          <span>条</span>
          <span class="kkfl-page-spacer"></span>
          <button type="button" id="kkfl-page-prev" class="menu_button" aria-label="上一页" title="上一页">‹</button>
          <span id="kkfl-page-indicator" aria-live="polite">1 / 1</span>
          <button type="button" id="kkfl-page-next" class="menu_button" aria-label="下一页" title="下一页">›</button>
        </div>
        <div class="kkfl-form"><div class="kkfl-title">添加在线 CSS 字体</div>
          <label for="kkfl-remote-name">收藏名称（选填）</label><input id="kkfl-remote-name" type="text" placeholder="默认使用识别出的字体名" />
          <label for="kkfl-remote-family">CSS 字体名（选填）</label><input id="kkfl-remote-family" type="text" placeholder="留空时从 CSS 链接识别" />
          <label><input id="kkfl-remote-sim" type="checkbox" /> 为单字重在线字体模拟粗细（以 400 为基准）</label>
          <label for="kkfl-remote-url">CSS 地址或整段 @import</label><textarea id="kkfl-remote-url" rows="2" placeholder='@import url("https://fontsapi.zeoseven.com/937/main/result.css");'></textarea>
          <button type="button" id="kkfl-add-remote">添加在线字体</button>
        </div>
        <div class="kkfl-form"><div class="kkfl-title">添加本地字体文件</div>
          <label for="kkfl-local-name">收藏名称（选填）</label><input id="kkfl-local-name" type="text" placeholder="自动使用字体内置名称或文件名" />
          <label for="kkfl-local-file">字体文件</label><div class="kkfl-file-picker"><input id="kkfl-local-file" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" hidden /><button type="button" id="kkfl-choose-local" class="menu_button">选择字体文件</button><span id="kkfl-local-filename" class="kkfl-muted">未选择文件</span></div>
          <label class="kkfl-check"><input type="checkbox" id="kkfl-local-variable" /> 这是可变字体（支持 100–900 字重）</label>
          <label for="kkfl-file-weight">普通字体文件的原始字重</label><select id="kkfl-file-weight"><option value="400">400 常规</option><option value="100">100</option><option value="200">200</option><option value="300">300</option><option value="500">500</option><option value="600">600</option><option value="700">700 粗体</option><option value="800">800</option><option value="900">900</option></select>
          <button type="button" id="kkfl-add-local">添加本地字体</button>
        </div><div id="kkfl-status" role="status" aria-live="polite"></div>
      </div>
    </div>`;
  host.append(root);
  const language = byId('kkfl-preview-language');
  const preview = byId('kkfl-preview');
  function showSample() {
    const codes = language.value === 'all' ? Object.keys(PREVIEW_SAMPLES) : [language.value];
    const lines = codes.map(code => {
      const line = document.createElement('div');
      line.lang = code;
      line.textContent = PREVIEW_SAMPLES[code];
      return line;
    });
    preview.replaceChildren(...lines, document.createTextNode('0123456789'));
  }
  language.addEventListener('change', showSample);
  showSample();
  byId('kkfl-migrate').addEventListener('click',async()=>{
    root.inert=true;
    try {
      const old=JSON.parse(localStorage.getItem(storageKey) || '{}');
      const missing=[];
      for (const entry of old.entries || []) {
        if(settings.entries.some(x=>x.id===entry.id))continue;
        const file = entry.type==='local' ? await dbAct('readonly',entry.id) : null;
        if(entry.type==='local' && !file){missing.push(entry.name);continue;}
        settings.entries.push(await uploadEntry(entry,file));
      }
      if(!settings.activeId && settings.entries.some(x=>x.id===old.activeId)){
        settings.activeId=old.activeId;save();await apply();
      }
      info(missing.length ? '其余已导入。本浏览器缺少文件：'+missing.join('、') : '已有收藏已合并到酒馆字体库。');
    } catch(e){info(e.message,true);}finally{renderList();root.inert=false;}
  });
  byId('kkfl-page-size').addEventListener('change', e => {
    const n = Math.round(Number(e.target.value));
    settings.pageSize = Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 10;
    currentPage = 1;
    e.target.value = String(settings.pageSize);
    save();
    renderList();
  });
  byId('kkfl-page-prev').addEventListener('click', () => { currentPage--; renderList(); });
  byId('kkfl-page-next').addEventListener('click', () => { currentPage++; renderList(); });
  byId('kkfl-toggle').addEventListener('change',e=>{settings.enabled=e.target.checked;save();apply().catch(e=>info(e.message,true));renderList();});
  byId('kkfl-adjust-body').addEventListener('change', e => {
    settings.adjustBody = e.target.checked;
    if (activeFamily) injectCSS(activeFamily);
    save();
  });
  byId('kkfl-weight').addEventListener('input',e=>{
    const weight = validWeight(e.target.value);
    byId('kkfl-weight-label').textContent = weight;
    updatePreview(weight);
  });
  byId('kkfl-weight').addEventListener('change',e=>{
    settings.weight = validWeight(e.target.value);
    if (activeFamily && settings.adjustBody) injectCSS(activeFamily);
    save();
  });
  byId('kkfl-scope').addEventListener('change',e=>{
    settings.scope = e.target.value;
    if (activeFamily) injectCSS(activeFamily);
    save();
  });
  byId('kkfl-add-remote').addEventListener('click',async ()=>{
    root.inert = true;
    try {
      const url=parseCssLink(byId('kkfl-remote-url').value);
      const family=validFamily(byId('kkfl-remote-family').value.trim() || await onlineFamily(url));
      const name=byId('kkfl-remote-name').value.trim() || family;
      const item={id:uuid(),name:name.slice(0,100),family,url,type:'remote',simulate:byId('kkfl-remote-sim').checked};
      if(shared)await uploadEntry(item);
      settings.entries.push(item); settings.activeId=item.id; settings.enabled=true;save();renderList();
      apply().then(()=>info('已添加在线字体。如果显示未变化，请确认 CSS 的真实 font-family 名称。')).catch(e=>info(e.message,true));
      byId('kkfl-remote-name').value='';byId('kkfl-remote-family').value='';byId('kkfl-remote-url').value='';
    } catch(e) {info(e.message,true);} finally { root.inert = false; }
  });
  byId('kkfl-choose-local').addEventListener('click', () => byId('kkfl-local-file').click());
  byId('kkfl-local-file').addEventListener('change', e => {
    byId('kkfl-local-filename').textContent = e.target.files?.[0]?.name || '未选择文件';
  });
  byId('kkfl-add-local').addEventListener('click',async()=>{
    const button=byId('kkfl-add-local');
    try {
      const file=byId('kkfl-local-file').files?.[0];if(!file)throw new Error('请选择字体文件。');
      if(!/\.(woff2?|ttf|otf)$/i.test(file.name))throw new Error('只支持 woff2 / woff / ttf / otf 文件。');
      if(file.size>25*1024*1024)throw new Error('单个字体文件大小上限为 25 MB。');
      button.disabled=true;
      root.inert = true;
      const name=byId('kkfl-local-name').value.trim() || await localName(file);
      const id=uuid();
      const item={id,type:'local',name:name.slice(0,100),filename:file.name,variable:byId('kkfl-local-variable').checked,fileWeight:validWeight(byId('kkfl-file-weight').value)};
      if(shared)await uploadEntry(item,file);
      else await dbAct('readwrite',id,file);
      settings.entries.push(item);
      settings.activeId=id;settings.enabled=true;save();renderList();await apply();
      info(`已添加本地字体「${name}」。`);byId('kkfl-local-name').value='';byId('kkfl-local-file').value='';byId('kkfl-local-filename').textContent='未选择文件';
    }catch(e){info(e.message,true);}finally{button.disabled=false;root.inert=false;}
  });
  renderList();
  return true;
}
async function boot() {
  if(!window.SillyTavern?.getContext) { console.warn('[Font Library] SillyTavern context unavailable'); return; }
  const ctx=window.SillyTavern.getContext();
  const {getCurrentUserHandle} = await import('/scripts/user.js');
  storageKey = EXT_KEY + ':' + getCurrentUserHandle();
  const legacy = ctx.extensionSettings[EXT_KEY];
  const saved = localStorage.getItem(storageKey);
  settings = saved ? JSON.parse(saved) : structuredClone(legacy ?? DEFAULTS);
  for (const [k,v] of Object.entries(DEFAULTS)) if (!(k in settings)) settings[k]=structuredClone(v);
  if(!Array.isArray(settings.entries))settings.entries=[];
  if(!['chat','global'].includes(settings.scope))settings.scope='chat';
  settings.pageSize = Math.max(1, Math.min(100, Math.round(Number(settings.pageSize) || 10)));
  save = () => {
    if(shared){
      const {entries,...prefs}=settings;
      localStorage.setItem(storageKey+':prefs', JSON.stringify(prefs));
    }else localStorage.setItem(storageKey, JSON.stringify(settings));
  };
  if (legacy) {
    save();
    // A different browser may own the only copy of an old local font.
    // Leave its migration record intact until opened in the owning browser.
    const localEntries = (legacy.entries || []).filter(entry => entry.type === 'local');
    const hasFiles = await Promise.all(localEntries.map(entry => dbAct('readonly', entry.id, undefined, true).then(Boolean)));
    if (hasFiles.every(Boolean)) {
      delete ctx.extensionSettings[EXT_KEY];
      ctx.saveSettingsDebounced();
    }
  }
  try {
    settings = await readShared();
    settings.pageSize = Math.max(1, Math.min(100, Math.round(Number(settings.pageSize) || 10)));
    shared = true;
  }catch(e){console.warn('[Font Library]',e.message);}
  await apply().catch(e=>console.error('[Font Library]', e));
  if(createUI())return;
  const observer=new MutationObserver(()=>{if(createUI()) observer.disconnect();});
  observer.observe(document.body,{childList:true,subtree:true});
  setTimeout(()=>observer.disconnect(),30000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
