/* SillyTavern Font Library — v1.6.0 */
const EXT_KEY = 'kk_font_library_v1';
// Keep in sync with manifest.json.
const VERSION = '1.6.0';
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
const DEFAULTS = { entries: [], activeId: '', enabled: true, weight: 400, weightScope: 'off', scope: 'chat', pageSize: 10, previewBoldMode: 'stroke' };
let settings, save;
let currentPage = 1;
let storageKey;
let activeFace;
let activeFamily;
let onlineBase;
let onlineWeights = [];
let onlineVariable = false;
let currentToken = 0;
const byId = (id) => document.getElementById(id);
const uuid = () => (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const quoteCss = (s) => `"${String(s).replace(/[\\"\n\r\f]/g, '')}"`;
const info = (m, error = false) => { const el = byId('kkfl-status'); if (el) { el.textContent=m; el.classList.toggle('error', error); } if (error) console.error('[Font Library]', m); };
const EXTENSION_ID = 'third-party/st-font-library';
const EXTENSION_NAME = 'st-font-library';
const UPDATE_CACHE_KEY = 'kkfl-update-check';
async function extensionTarget() {
  const { extensionTypes } = await import('/scripts/extensions.js');
  const type = extensionTypes[EXTENSION_ID];
  if (!['local', 'global'].includes(type)) throw new Error('未能识别字体库的安装位置，请通过「管理扩展程序」更新。');
  return { extensionName: EXTENSION_NAME, global: type === 'global' };
}
async function extensionRequest(path, payload) {
  const response = await fetch('/api/extensions/' + path, {
    method: 'POST',
    headers: window.SillyTavern.getContext().getRequestHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('更新请求失败（HTTP ' + response.status + '）。请检查酒馆终端日志。');
  return response.json();
}
function setUpdateBadge(visible) {
  const badge = byId('kkfl-update-badge');
  if (badge) badge.hidden = !visible;
}
// Quiet check on load: the hint sits next to the update button, never a popup.
async function checkForUpdates() {
  try {
    const cached = sessionStorage.getItem(UPDATE_CACHE_KEY);
    if (cached) {
      const { at, stale } = JSON.parse(cached);
      if (Date.now() - at < 10 * 60 * 1000) { setUpdateBadge(Boolean(stale)); return; }
    }
    const version = await extensionRequest('version', await extensionTarget());
    const stale = Boolean(version.currentCommitHash) && !version.isUpToDate;
    sessionStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ at: Date.now(), stale }));
    setUpdateBadge(stale);
  } catch (error) {
    console.debug('[Font Library] 检查更新失败：', error.message);
  }
}

let dbPromise;
function getDb() {
  // Keep one connection: opening IndexedDB per operation made bulk import slow.
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgraded the schema: drop the handle so the next call reopens.
        db.onversionchange = () => { db.close(); dbPromise = undefined; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    }).catch(error => { dbPromise = undefined; throw error; });
  }
  return dbPromise;
}
async function dbAct(mode, key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    let req;
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      if (mode === 'readonly') req = store.get(key);
      else if (Array.isArray(key)) key.forEach(id => store.delete(id));
      else if (value === undefined) store.delete(key);
      else store.put(value, key);
      tx.oncomplete = () => resolve(req?.result);
      tx.onabort = () => reject(tx.error || new Error('字体数据库操作已取消'));
    } catch (error) {
      // A cached connection can be closed by the browser; reopen on the next call.
      dbPromise = undefined;
      reject(error);
    }
  });
}
const validWeight = (v) => {
  const weight = Number(v);
  return Number.isFinite(weight) ? Math.max(100, Math.min(900, Math.round(weight))) : 400;
};
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
// Use actual weight faces whenever they are available; unknown online families
// also stay native rather than risking a false single-weight classification.
function usesSimulatedWeight(item) {
  return Boolean(item && !item.variable &&
    (item.type === 'local' || (item.type === 'remote' && Number.isFinite(onlineBase))));
}
function weightStyle(item, value) {
  const target = validWeight(value);
  if (!usesSimulatedWeight(item)) {
    // The font ships real faces: use the closest one instead of faking the weight.
    if (item && item.type === 'remote' && onlineWeights.length > 1) {
      let best = onlineWeights[0];
      for (const candidate of onlineWeights) {
        const delta = Math.abs(candidate - target);
        const bestDelta = Math.abs(best - target);
        // Ties go to the heavier face, so the middle of the slider does not feel light.
        if (delta < bestDelta || (delta === bestDelta && candidate > best)) best = candidate;
      }
      return {weight: best, stroke: 0, alpha: 100};
    }
    return {weight: target, stroke: 0, alpha: 100};
  }
  const base = validWeight(item.type === 'remote' ? onlineBase : (item.fileWeight || 400));
  if (target === base) return {weight: base, stroke: 0, alpha: 100};
  if (target > base) {
    // Browsers cannot synthesise weight upward without a bold face, so stretch the
    // outline across the whole remaining range instead of saturating near the start.
    const span = Math.max(100, 900 - base);
    const amount = Math.min(1, (target - base) / span);
    // A 700-weight face has far less room to grow than a 400 one, so scale the outline
    // by that range. Linear growth keeps the low half soft instead of turning muddy.
    const maxStroke = 0.06 * Math.min(1, span / 500);
    return {weight: base, stroke: maxStroke * amount, alpha: 100};
  }
  // Nothing can thin a glyph in CSS, so fade it instead and spread that over the
  // lower half of the slider so every step is visible.
  const span = Math.max(100, base - 100);
  const amount = Math.min(1, (base - target) / span);
  return {weight: base, stroke: 0, alpha: 100 - 45 * amount};
}
function detectFamilyFaces(family) {
  const wanted = family.replace(/^['"]|['"]$/g, '').toLowerCase();
  const weights = new Set();
  let variable = false;
  for (const face of document.fonts) {
    if (face.family.replace(/^['"]|['"]$/g, '').toLowerCase() !== wanted) continue;
    const raw = String(face.weight).trim().toLowerCase();
    if (raw === 'normal') { weights.add(400); continue; }
    if (raw === 'bold') { weights.add(700); continue; }
    const parts = raw.split(/\s+/).map(Number);
    if (parts.length > 1 && parts.every(Number.isFinite)) { variable = true; continue; }
    if (Number.isFinite(parts[0])) weights.add(parts[0]);
  }
  return {weights: [...weights].sort((a, b) => a - b), variable};
}

function updateBoldModeControls() {
  const row = byId('kkfl-bold-mode-row');
  if (!row) return;
  const item = settings.entries.find(x => x.id === settings.activeId);
  row.hidden = !settings.enabled || !usesSimulatedWeight(item);
}
function updateWeightHint() {
  const el = byId('kkfl-weight-hint');
  if (!el) return;
  const item = settings.entries.find(entry => entry.id === settings.activeId);
  if (!item || !settings.enabled) { el.textContent = ''; return; }
  if (item.type === 'local' && item.variable) { el.textContent = '可变字体：100–900 为真实字重轴'; return; }
  if (item.type === 'remote' && onlineVariable) { el.textContent = '可变字体：粗细为真实字重轴'; return; }
  if (item.type === 'remote' && onlineWeights.length > 1) {
    el.textContent = `该字体提供 ${onlineWeights.join(' / ')}，已使用真实字重`;
    return;
  }
  const base = validWeight(item.type === 'remote' ? onlineBase : (item.fileWeight || 400));
  el.textContent = `单字重（${base}）：粗细为描边 / 淡化模拟`;
}

function updateWeightMarker() {
  const mark = byId('kkfl-weight-mark');
  const chip = byId('kkfl-weight-chip');
  if (!mark || !chip) return;
  const item = settings.entries.find(entry => entry.id === settings.activeId);
  if (!item || !settings.enabled) {
    mark.hidden = true;
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  if (item.type === 'local' && item.variable) {
    mark.hidden = true;
    chip.textContent = '可变 100–900';
    return;
  }
  if (item.type === 'remote' && onlineVariable) {
    mark.hidden = true;
    chip.textContent = '可变字重';
    return;
  }
  if (item.type === 'remote' && onlineWeights.length > 1) {
    mark.hidden = true;
    chip.textContent = '多字重';
    return;
  }
  const base = validWeight(item.type === 'remote' ? (Number.isFinite(onlineBase) ? onlineBase : 400) : (item.fileWeight || 400));
  mark.hidden = false;
  mark.style.setProperty('--kkfl-p', String((base - 100) / 800));
  mark.style.left = '';
  chip.textContent = `原字重 ${base}`;
}
function updateWeightScopeNote() {
  const el = byId('kkfl-weight-scope-note');
  if (!el) return;
  const mode = settings.weightScope;
  el.classList.toggle('warn', mode === 'global');
  el.textContent = mode === 'global'
    ? '描边模拟会覆盖全站文字，可能明显增加渲染开销；卡的话切回「聊天正文」。'
    : mode === 'chat'
      ? '只在聊天正文描边，开销较小。'
      : '不应用字重，没有额外渲染开销。';
}
function updateScopeNote() {
  const el = byId('kkfl-scope-note');
  if (!el) return;
  const mode = settings.scope;
  el.classList.toggle('warn', mode === 'all');
  el.textContent = mode === 'all'
    ? '强制覆盖所有元素（图标与代码块除外）；可能影响其它扩展排版，与同类插件同权重、谁后加载谁生效。'
    : mode === 'global'
      ? '跟随酒馆默认字；插件自带字体保持原样。'
      : '只影响聊天正文与角色名。';
}
function cssSelectors(scope) {
  if (scope === 'all') return ['*'];
  if (scope === 'global') {
    // Only touch what inherits from the tavern: <body> itself plus the --mainFontFamily
    // variable. Anything that declares its own font-family keeps it.
    return ['body'];
  }
  return ['#chat .mes_text', '#chat .mes_text *:not(i):not(svg):not(path)', '#chat .mes .name_text'];
}
function injectCSS(family) {
  const selectors = cssSelectors(settings.scope);
  const item = settings.entries.find(entry => entry.id === settings.activeId);
  const {weight, stroke, alpha} = weightStyle(item, settings.weight);
  const familyList = `${quoteCss(family)}, sans-serif`;
  const declaration = `font-family: ${familyList} !important;`;
  // Icon fonts also live on buttons, divs and spans, not just <i> elements.
  // Let their own styles select the font, including inherited icon children.
  const iconSelector = [
    'i', 'svg', 'path', '.fa', '.fas', '.far', '.fab', '.fal', '.fad', '.fat',
    '[class^="fa-"]', '[class*=" fa-"]', '[class^="fa "]',
    '.material-icons', '.material-icons-outlined', '.material-icons-round',
    '.material-icons-sharp', '.material-icons-two-tone',
    '.material-symbols-outlined', '.material-symbols-rounded', '.material-symbols-sharp',
    '.iconfont', '[data-icon]',
  ].join(', ');
  const codeSelector = 'code, kbd, samp, pre, .hljs';
  const codeExcluded = settings.scope === 'all' ? `, ${codeSelector}, ${codeSelector} *` : '';
  const excluded = `:not(#${PANEL_ID}, #${PANEL_ID} *, :is(${iconSelector}), :is(${iconSelector}) *${codeExcluded})`;
  let rules = selectors.map(s => `${s}${excluded} { ${declaration} }`).join('\n');
  // Widgets such as the prompt list (<ul id="completion_prompt_manager_list"
  // class="text_pole">) read their font from --mainFontFamily instead of
  // inheriting it, so overriding body alone leaves whole panels on the theme font.
  if (settings.scope !== 'chat') {
    rules += `\n:root, body { --mainFontFamily: ${familyList} !important; }`;
  }
  if (settings.weightScope === 'global') {
    // Same treatment as the chat body, but on every element the font covers.
    const weightRules = [`font-weight: ${weight} !important;`];
    if (stroke) weightRules.push(`-webkit-text-stroke-width: ${stroke}em;`);
    if (alpha < 100) weightRules.push(`-webkit-text-fill-color: color-mix(in srgb, currentColor ${alpha}%, transparent);`);
    rules += '\n' + cssSelectors('global').map(s => `${s}${excluded} { ${weightRules.join(' ')} }`).join('\n');
  } else if (settings.weightScope === 'chat') {
    let bodyStyle = `font-weight: ${weight};`;
    if (stroke) bodyStyle += ` -webkit-text-stroke-width: ${stroke}em;`;
    if (alpha < 100) bodyStyle += ` -webkit-text-fill-color: color-mix(in srgb, currentColor ${alpha}%, transparent);`;
    rules += `\n@layer kkflDefaults { :where(#chat .mes_text) { ${bodyStyle} } }`;
  }
  // The panel inherits stroke/fill from <body> in global mode; keep its own text crisp.
  rules += `\n#${PANEL_ID} { -webkit-text-stroke-width: 0; -webkit-text-fill-color: currentColor; }`;
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
  onlineWeights = [];
  onlineVariable = false;
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
      const faces = detectFamilyFaces(family);
      onlineVariable = faces.variable;
      onlineWeights = faces.weights;
      onlineBase = faces.variable || faces.weights.length !== 1 ? undefined : faces.weights[0];
      injectCSS(family);
      updateBoldModeControls();
      updatePreview();
      updateWeightHint();
      updateWeightMarker();
    };
    document.head.append(link);
  } else {
    const file = await dbAct('readonly', item.id);
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
  updateBoldModeControls();
  updateWeightHint();
  updateWeightMarker();
  updateWeightScopeNote();
  updateScopeNote();
}
function setActiveLabel() {
  const item = settings.entries.find(x => x.id === settings.activeId);
  const el = byId('kkfl-current');
  if (el) {
    const name = document.createElement('span');
    name.className = 'kkfl-current-name';
    name.textContent = settings.enabled && item ? item.name : '原有字体';
    // The label stays in the UI font; only the selected font's name previews the loaded face.
    if (settings.enabled && item && activeFamily) {
      name.style.fontFamily = quoteCss(activeFamily) + ', sans-serif';
    }
    el.replaceChildren(document.createTextNode('正在使用：'), name);
  }
  const b = byId('kkfl-toggle');
  if (b) b.checked = Boolean(settings.enabled);
}
function renderList() {
  const list = byId('kkfl-list');
  if (!list) return;
  updateBoldModeControls();
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
      update(() => { entry.name=name; }); setActiveLabel();
    });
    const del = document.createElement('button'); del.type='button'; del.textContent='删除'; del.addEventListener('click', async () => {
      if (!confirm(`删除字体「${entry.name}」？`)) return;
      if (entry.type==='local') { try { await dbAct('readwrite', entry.id); } catch (e) { info('删除本地文件失败：'+e.message, true); return; } }
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
  const w = byId('kkfl-weight'); if (w) w.value=String(settings.weight);
  const weightScope = byId('kkfl-weight-scope'); if (weightScope) weightScope.value = settings.weightScope;
  const out = byId('kkfl-weight-label'); if(out) out.textContent=String(settings.weight);
  const scope = byId('kkfl-scope'); if (scope) scope.value=settings.scope;
  updatePreview();
  updateWeightHint();
  updateWeightMarker();
  updateWeightScopeNote();
  updateScopeNote();
}
function updatePreview(value = settings.weight) {
  const el = byId('kkfl-preview'); if (!el) return;
  const item = settings.entries.find(x => x.id === settings.activeId);
  const {weight, stroke, alpha} = weightStyle(item, value);
  // The native synthesis experiment applies to preview only.
  // Chat CSS and the existing weightStyle() logic remain unchanged.
  const isStatic = usesSimulatedWeight(item);
  const nativeBold = settings.enabled && isStatic && settings.previewBoldMode === 'native' &&
    validWeight(value) > weight;
  el.style.filter = '';
  // Never clear these: both properties inherit, so an empty inline value falls back to
  // whatever the last committed weight left on <body>, which made the preview invert
  // while dragging and only snap back on release.
  el.style.webkitTextStrokeWidth = settings.enabled && !nativeBold && stroke ? stroke + 'em' : '0';
  el.style.webkitTextFillColor = settings.enabled && !nativeBold && alpha < 100
    ? `color-mix(in srgb, currentColor ${alpha}%, transparent)` : 'currentColor';
  el.style.fontSynthesisWeight = nativeBold ? 'auto' : '';
  if (!item || !settings.enabled) {
    el.style.fontFamily = '';
    el.style.fontWeight = '';
    return;
  }
  el.style.fontFamily = quoteCss(item.type === 'remote' ? item.family :
    `kkfl-${item.id.replace(/[^a-zA-Z0-9_-]/g,'')}`);
  el.style.fontWeight = String(nativeBold ? validWeight(value) : weight);
}

const EXPORT_APP = 'st-font-library';
const EXPORT_SCHEMA = 1;

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取字体文件失败'));
    reader.readAsDataURL(blob);
  });
}

async function exportCollection() {
  const entries = [];
  const missing = [];
  for (const entry of settings.entries) {
    if (entry.type !== 'local') { entries.push(entry); continue; }
    const file = await dbAct('readonly', entry.id);
    if (!file) { missing.push(entry.name); continue; }
    entries.push({...entry, data: await readBlobAsDataUrl(file)});
  }
  const payload = {
    app: EXPORT_APP,
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    entries,
    prefs: {
      activeId: settings.activeId,
      enabled: settings.enabled,
      weight: settings.weight,
      weightScope: settings.weightScope,
      scope: settings.scope,
      pageSize: settings.pageSize,
      previewBoldMode: settings.previewBoldMode,
    },
  };
  const blob = new Blob([JSON.stringify(payload)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `st-font-library-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  info(`已导出 ${entries.length} 个收藏${missing.length ? '，跳过缺少文件的：' + missing.join('、') : ''}。`, missing.length > 0);
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = String(dataUrl).split(',');
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type: /data:([^;]+)/.exec(meta || '')?.[1] || 'application/octet-stream'});
}

function entrySignature(entry) {
  return entry.type === 'remote' ? `remote|${entry.family}|${entry.url}` : `local|${entry.filename}|${entry.name}`;
}

async function importCollection(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error('不是有效的 JSON 文件。');
  }
  if (!payload || payload.app !== EXPORT_APP || !Array.isArray(payload.entries)) {
    throw new Error('这不是字体收藏夹导出的备份文件。');
  }
  const known = new Set(settings.entries.map(entry => entry.id));
  const signatures = new Set(settings.entries.map(entrySignature));
  let added = 0;
  for (const raw of payload.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type === 'remote' ? 'remote' : raw.type === 'local' ? 'local' : '';
    if (!type || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    if (type === 'remote' && (!raw.url || !raw.family)) continue;
    if (type === 'local' && !raw.data) continue;
    const entry = {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
      type,
      name: raw.name.trim().slice(0, 100),
      ...(type === 'remote'
        ? {url: raw.url, family: raw.family}
        : {filename: String(raw.filename || 'font'), variable: Boolean(raw.variable), fileWeight: validWeight(raw.fileWeight || 400)}),
    };
    if (known.has(entry.id) || signatures.has(entrySignature(entry))) continue;
    if (type === 'local') {
      try { await dbAct('readwrite', entry.id, dataUrlToBlob(raw.data)); }
      catch { continue; }
    }
    settings.entries.push(entry);
    known.add(entry.id);
    signatures.add(entrySignature(entry));
    added++;
  }
  const prefs = payload.prefs && typeof payload.prefs === 'object' ? payload.prefs : {};
  if (typeof prefs.enabled === 'boolean') settings.enabled = prefs.enabled;
  if (prefs.weight !== undefined) settings.weight = validWeight(prefs.weight);
  if (['off', 'chat', 'global'].includes(prefs.weightScope)) settings.weightScope = prefs.weightScope;
  if (['chat', 'global'].includes(prefs.scope)) settings.scope = prefs.scope;
  if (prefs.pageSize !== undefined) settings.pageSize = Math.max(1, Math.min(100, Math.round(Number(prefs.pageSize) || 10)));
  if (['stroke', 'native'].includes(prefs.previewBoldMode)) settings.previewBoldMode = prefs.previewBoldMode;
  if (typeof prefs.activeId === 'string' && settings.entries.some(entry => entry.id === prefs.activeId)) {
    settings.activeId = prefs.activeId;
  }
  if (!settings.activeId && settings.entries.length) settings.activeId = settings.entries[0].id;
  save();
  renderList();
  await apply();
  info(added ? `已导入 ${added} 个收藏。` : '没有新的收藏可导入（可能已经存在）。');
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
        <div class="kkfl-update-row"><span class="kkfl-update-label">字体库管理<small id="kkfl-version" class="kkfl-version" title="当前安装的字体库版本"></small></span><span class="kkfl-update-side"><span id="kkfl-update-badge" class="kkfl-update-badge" hidden>有新版本</span><button id="kkfl-update-extension" type="button" class="menu_button" title="检查并更新字体库插件"><i class="fa-solid fa-rotate" aria-hidden="true"></i> 更新插件</button></span></div>
        <div class="kkfl-io-row"><button id="kkfl-export" type="button" class="menu_button">导出收藏</button><button id="kkfl-import" type="button" class="menu_button">导入收藏</button><input id="kkfl-import-file" type="file" accept=".json,application/json" hidden /></div>
        <div class="kkfl-top"><span id="kkfl-current"></span></div>
        <label><input id="kkfl-toggle" type="checkbox" /> 启用字体覆盖</label>
        <label for="kkfl-scope">字体应用范围</label><select id="kkfl-scope"><option value="chat">仅聊天正文与角色名</option><option value="global">主要酒馆界面和聊天内容</option><option value="all">全覆盖（强制插件自带字体）</option></select>
        <div id="kkfl-scope-note" class="kkfl-muted kkfl-scope-note"></div>
        <label for="kkfl-weight-scope">字重应用范围</label><select id="kkfl-weight-scope"><option value="off">仅预览</option><option value="chat">聊天正文</option><option value="global">整个界面（全局）</option></select>
        <div id="kkfl-weight-scope-note" class="kkfl-muted kkfl-scope-note"></div>
        <label for="kkfl-weight">预览字重 <output id="kkfl-weight-label">400</output><span id="kkfl-weight-chip" class="kkfl-weight-chip" hidden></span></label>
        <div class="kkfl-range-wrap"><span id="kkfl-weight-mark" class="kkfl-weight-mark" hidden></span><input type="range" id="kkfl-weight" min="100" max="900" step="1" value="400" /></div>
        <div id="kkfl-weight-hint" class="kkfl-muted"></div>
        <div class="kkfl-muted">静态字体用描边模拟加粗，变细则用淡化近似；滑块覆盖整个区间，拖动即可在下方预览。</div>
        <div class="kkfl-bold-mode-row" id="kkfl-bold-mode-row" hidden>
          <label for="kkfl-preview-bold-mode">单字重模拟加粗（仅预览）</label>
          <select id="kkfl-preview-bold-mode" aria-label="预览加粗方式">
            <option value="stroke">CSS 描边</option>
            <option value="native">浏览器原生合成</option>
          </select>
        </div>
        <div class="kkfl-preview-box">
          <div id="kkfl-preview" class="kkfl-preview"></div>
        </div>
        <div class="kkfl-preview-controls">
          <select id="kkfl-preview-language" aria-label="预览语言" title="预览语言">
            <option value="zh-CN">中文</option><option value="ja">日本語</option>
            <option value="en">English</option><option value="ko">한국어</option>
            <option value="all">多语对照</option>
          </select>
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
          <label for="kkfl-remote-url">CSS 地址或整段 @import</label><textarea id="kkfl-remote-url" rows="2" placeholder='@import url("https://fontsapi.zeoseven.com/937/main/result.css");'></textarea>
          <button type="button" id="kkfl-add-remote">添加在线字体</button>
        </div>
        <div class="kkfl-form"><div class="kkfl-title">添加本地字体文件</div>
          <label for="kkfl-local-name">收藏名称（选填）</label><input id="kkfl-local-name" type="text" placeholder="自动使用字体内置名称或文件名" />
          <label for="kkfl-local-file">字体文件</label><div class="kkfl-file-picker"><input id="kkfl-local-file" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" hidden /><button type="button" id="kkfl-choose-local" class="menu_button">选择字体文件</button><span id="kkfl-local-filename" class="kkfl-muted">未选择文件</span></div>
          <label class="kkfl-check"><input type="checkbox" id="kkfl-local-variable" /> 这是可变字体（支持 100–900 字重）</label>
          <label for="kkfl-file-weight">普通字体文件的原始字重</label><select id="kkfl-file-weight"><option value="400">400 常规</option><option value="100">100</option><option value="200">200</option><option value="300">300</option><option value="500">500</option><option value="600">600</option><option value="700">700 粗体</option><option value="800">800</option><option value="900">900</option></select>
          <button type="button" id="kkfl-add-local" disabled>添加本地字体</button>
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
  byId('kkfl-export').addEventListener('click', () => { exportCollection().catch(error => info('导出失败：' + error.message, true)); });
  byId('kkfl-import').addEventListener('click', () => byId('kkfl-import-file').click());
  byId('kkfl-import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { await importCollection(file); } catch (error) { info('导入失败：' + error.message, true); }
  });
  byId('kkfl-update-extension').addEventListener('click', async () => {
    const button = byId('kkfl-update-extension');
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = '检查更新中…';
    try {
      const target = await extensionTarget();
      const version = await extensionRequest('version', target);
      if (!version.currentCommitHash) throw new Error('此插件不是通过 Git 安装，无法直接更新。');
      if (version.isUpToDate) {
        setUpdateBadge(false);
        sessionStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({ at: Date.now(), stale: false }));
        info('字体库已经是最新版本。');
        return;
      }
      button.textContent = '正在更新…';
      const result = await extensionRequest('update', target);
      if (result.isUpToDate) {
        setUpdateBadge(false);
        info('字体库已经是最新版本。');
        return;
      }
      sessionStorage.removeItem(UPDATE_CACHE_KEY);
      setUpdateBadge(false);
      info('字体库已更新至 ' + result.shortCommitHash + '，正在刷新…');
      button.textContent = '已更新，正在刷新…';
      setTimeout(() => location.reload(), 700);
      return;
    } catch (error) {
      info('字体库更新失败：' + error.message, true);
    }
    button.innerHTML = original;
    button.disabled = false;
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
  byId('kkfl-weight-scope').addEventListener('change', e => {
    settings.weightScope = ['off', 'chat', 'global'].includes(e.target.value) ? e.target.value : 'off';
    updateWeightScopeNote();
    if (activeFamily) injectCSS(activeFamily);
    save();
  });
  const boldMode = byId('kkfl-preview-bold-mode');
  boldMode.value = settings.previewBoldMode === 'native' ? 'native' : 'stroke';
  updateBoldModeControls();
  boldMode.addEventListener('change', e => {
    settings.previewBoldMode = e.target.value === 'native' ? 'native' : 'stroke';
    save();
    updatePreview(validWeight(byId('kkfl-weight').value));
  });
  let previewFrame = 0;
  byId('kkfl-weight').addEventListener('input', e => {
    byId('kkfl-weight-label').textContent = validWeight(e.target.value);
    // Coalesce pointer-rate events into a single paint per frame.
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      updatePreview(validWeight(byId('kkfl-weight').value));
    });
  });
  byId('kkfl-weight').addEventListener('change',e=>{
    settings.weight = validWeight(e.target.value);
    if (activeFamily && settings.weightScope !== 'off') injectCSS(activeFamily);
    save();
  });
  byId('kkfl-scope').addEventListener('change',e=>{
    settings.scope = ['chat','global','all'].includes(e.target.value) ? e.target.value : 'chat';
    updateScopeNote();
    if (activeFamily) injectCSS(activeFamily);
    save();
  });
  byId('kkfl-add-remote').addEventListener('click',async ()=>{
    root.inert = true;
    try {
      const url=parseCssLink(byId('kkfl-remote-url').value);
      const family=validFamily(byId('kkfl-remote-family').value.trim() || await onlineFamily(url));
      const name=byId('kkfl-remote-name').value.trim() || family;
      const item={id:uuid(),name:name.slice(0,100),family,url,type:'remote'};
      settings.entries.push(item); settings.activeId=item.id; settings.enabled=true;save();renderList();
      apply().then(()=>info('已添加在线字体。如果显示未变化，请确认 CSS 的真实 font-family 名称。')).catch(e=>info(e.message,true));
      byId('kkfl-remote-name').value='';byId('kkfl-remote-family').value='';byId('kkfl-remote-url').value='';
    } catch(e) {info(e.message,true);} finally { root.inert = false; }
  });
  byId('kkfl-choose-local').addEventListener('click', () => byId('kkfl-local-file').click());
  byId('kkfl-local-file').addEventListener('change', e => {
    byId('kkfl-local-filename').textContent = e.target.files?.[0]?.name || '未选择文件';
    byId('kkfl-add-local').disabled = !e.target.files?.length;
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
      await dbAct('readwrite',id,file);
      settings.entries.push(item);
      settings.activeId=id;settings.enabled=true;save();renderList();await apply();
      info(`已添加本地字体「${name}」。`);byId('kkfl-local-name').value='';byId('kkfl-local-file').value='';byId('kkfl-local-filename').textContent='未选择文件';
    }catch(e){info(e.message,true);}finally{button.disabled=!byId('kkfl-local-file').files?.length;root.inert=false;}
  });
  renderList();
  byId('kkfl-version').textContent = 'v' + VERSION;
  setTimeout(checkForUpdates, 2000);
  return true;
}
async function boot() {
  if(!window.SillyTavern?.getContext) { console.warn('[Font Library] SillyTavern context unavailable'); return; }
  const {getCurrentUserHandle} = await import('/scripts/user.js');
  storageKey = EXT_KEY + ':' + getCurrentUserHandle();
  const saved = localStorage.getItem(storageKey);
  settings = saved ? JSON.parse(saved) : structuredClone(DEFAULTS);
  // v1.4.0 dropped the optional server plugin; keep the shared-mode preferences.
  const sharedPrefs = localStorage.getItem(storageKey + ':prefs');
  if (sharedPrefs) {
    try {
      const { entries, ...prefs } = JSON.parse(sharedPrefs);
      Object.assign(settings, prefs);
    } catch { /* Corrupt preferences are ignored. */ }
    localStorage.removeItem(storageKey + ':prefs');
  }
  localStorage.removeItem(storageKey + ':shared');
  // v1.3.5 replaced the adjustBody checkbox with a three-way weight scope.
  if ('adjustBody' in settings) {
    if (!settings.weightScope) settings.weightScope = settings.adjustBody ? 'chat' : 'off';
    delete settings.adjustBody;
  }
  for (const [k,v] of Object.entries(DEFAULTS)) if (!(k in settings)) settings[k]=structuredClone(v);
  if(!Array.isArray(settings.entries))settings.entries=[];
  if(!['chat','global','all'].includes(settings.scope))settings.scope='chat';
  if(!['off','chat','global'].includes(settings.weightScope)) settings.weightScope='off';
  if(!['stroke','native'].includes(settings.previewBoldMode))settings.previewBoldMode='stroke';
  settings.pageSize = Math.max(1, Math.min(100, Math.round(Number(settings.pageSize) || 10)));
  save = () => localStorage.setItem(storageKey, JSON.stringify(settings));
  if (sharedPrefs) save();
  await apply().catch(e=>console.error('[Font Library]', e));
  if(createUI())return;
  const observer=new MutationObserver(()=>{if(createUI()) observer.disconnect();});
  observer.observe(document.body,{childList:true,subtree:true});
  setTimeout(()=>observer.disconnect(),30000);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
