import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

export const info = {id:'st-font-library', name:'字体收藏夹', description:'Per-account shared font files and catalogue'};
const validId = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/i.test(id);
const folder = req => path.join(req.user.directories.root, 'st-font-library');
const bad = () => Object.assign(new Error('Invalid font entry'), {status:400});
const route = fn => async (req,res) => {
  try { await fn(req,res); }
  catch (e) { res.sendStatus(e.code === 'ENOENT' ? 404 : e.status || 500); }
};
function metadata(raw) {
  if (!validId(raw.id) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100) throw bad();
  const base = {id:raw.id, type:raw.type, name:raw.name};
  if (raw.type === 'local' && typeof raw.filename === 'string' && /\.(woff2?|ttf|otf)$/i.test(raw.filename)) {
    return {...base, filename:raw.filename.slice(-255), variable:!!raw.variable, fileWeight:Number(raw.fileWeight)||400};
  }
  if (raw.type === 'remote' && /^https?:\/\//i.test(raw.url) && raw.url.length < 4096 &&
      typeof raw.family === 'string' && raw.family.length <= 120 && raw.family.trim()) {
    return {...base, url:raw.url, family:raw.family, simulate:!!raw.simulate};
  }
  throw bad();
}
export function init(router) {
  router.use((req,res,next) => {res.set('Cache-Control','private, no-store');next();});
  router.param('id',(req,res,next,id)=> validId(id) ? next() : res.sendStatus(400));
  router.get('/list',route(async(req,res)=>{
    let dirs;
    try { dirs=await fs.readdir(folder(req),{withFileTypes:true}); }
    catch(e){ if(e.code==='ENOENT') return res.json([]); throw e; }
    const entries=[];
    for(const dir of dirs.filter(d=>d.isDirectory() && validId(d.name))){
      try { entries.push(JSON.parse(await fs.readFile(path.join(folder(req),dir.name,'entry.json'),'utf8'))); }
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    res.json(entries.sort((a,b)=>a.name.localeCompare(b.name)));
  }));
  router.get('/font/:id',route(async(req,res)=>{
    res.type('application/octet-stream').sendFile(path.resolve(folder(req),req.params.id,'font.bin'),err=>{if(err && !res.headersSent)res.sendStatus(err.status || 404)});
  }));
  router.post('/add',express.raw({type:'application/octet-stream',limit:25*1024*1024+16384}),route(async(req,res)=>{
    const data=req.body;
    if(!Buffer.isBuffer(data) || data.length<5) throw bad();
    const end=4+data.readUInt32BE(0);
    if(end>16384 || end>data.length)throw bad();
    let raw;
    try {raw=JSON.parse(data.toString('utf8',4,end))} catch {throw bad()}
    const item=metadata(raw), bytes=data.subarray(end);
    if((item.type==='local') !== (bytes.length>0) || bytes.length>25*1024*1024)throw bad();
    const root=folder(req), dest=path.join(root,item.id);
    await fs.mkdir(root,{recursive:true});
    const stage=await fs.mkdtemp(path.join(root,'.upload-'));
    try {
      if(bytes.length)await fs.writeFile(path.join(stage,'font.bin'),bytes);
      await fs.writeFile(path.join(stage,'entry.json'),JSON.stringify(item));
      try { await fs.rename(stage,dest); }
      catch(e){if(!['ENOTEMPTY','EEXIST','EPERM'].includes(e.code))throw e;
        return res.json(JSON.parse(await fs.readFile(path.join(dest,'entry.json'),'utf8')));
      }
      res.json(item);
    } finally {await fs.rm(stage,{recursive:true,force:true});}
  }));
  router.post('/rename/:id',route(async(req,res)=>{
    const dir=path.join(folder(req),req.params.id), dest=path.join(dir,'entry.json');
    const old=JSON.parse(await fs.readFile(dest,'utf8'));
    const item=metadata({...old,name:req.body.name});
    const tmp=path.join(dir,'.rename-'+randomUUID());
    try {await fs.writeFile(tmp,JSON.stringify(item));await fs.rename(tmp,dest);}
    finally {await fs.rm(tmp,{force:true});}
    res.json(item);
  }));
  router.post('/remove/:id',route(async(req,res)=>{
    const root=folder(req), trash=path.join(root,'.delete-'+randomUUID());
    try {await fs.rename(path.join(root,req.params.id),trash);}
    catch(e){if(e.code==='ENOENT')return res.sendStatus(204);throw e;}
    await fs.rm(trash,{recursive:true});res.sendStatus(204);
  }));
}
