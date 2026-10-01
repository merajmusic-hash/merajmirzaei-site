// Regression tests without dependencies or real GitHub/KV mutations.
// Run: node --test scripts/test-admin.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../merajmirzaei-site (4)/admin-app.html', import.meta.url), 'utf8');
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });
const post = (path, body) => new Request('https://merajmirzaei.com' + path,
  { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });

function worker(fetchImpl = () => { throw new Error('Unexpected fetch'); }, extras = {}) {
  const context = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder,
    crypto:webcrypto, atob, btoa, setTimeout, console, fetch:fetchImpl, ...extras });
  vm.runInContext(source.replace("import { EmailMessage } from 'cloudflare:email';", 'class EmailMessage {}')
    .replace('export default {', 'const worker = {') + `
    globalThis.api = { worker, handleSave, handleGetCredits, handleSaveGallery, handleLoginPost,
      handleAdminListSubmissions, handleAdminListComments, serveMedia, buildEntityGraph, buildSitemapXml,
      LEGACY_CREDITS_REVISION, LEGACY_CREDITS_REF, signSession };`, context);
  return context.api;
}

function panel(fetchImpl) {
  const state = { entries:[], entriesSha:'credits-old', entriesDirty:false, homepage:[], homepageSha:'home-old',
    homepageDirty:false, newReleases:[], newReleasesDirty:false, gallery:[], galleryDirty:false,
    lyrics:{}, lyricsSaved:{}, lyricsDirty:false, lyricsLoaded:true, saving:false, coverUploads:0 };
  const buttons = { saveBtn:{disabled:false}, saveBtn2:{disabled:false} };
  const messages = [];
  const context = vm.createContext({ state, document:{getElementById:(id) => buttons[id]},
    fetch:fetchImpl, showMsg:(text) => messages.push(text), setDirty:() => {}, render:() => {},
    nrUploading:() => state.newReleases.some((x) => x._uploading != null),
    lyricsHas:(id) => !!String(state.lyrics[id] || '').trim(),
    galById:(id) => state.gallery.find((x) => x.id === id), byOrder:(a,b) => (a.order||0)-(b.order||0) });
  // Execute the shipped save implementation, not a reimplementation.
  const start = admin.indexOf('  function savePayload(kind){');
  const end = admin.indexOf("  document.getElementById('saveBtn').addEventListener", start);
  vm.runInContext(admin.slice(start, end), context);
  return { state, buttons, messages, save:context.save };
}

test('production HTTP redirects before handling requests and preserves path and query', async () => {
  const api = worker();
  for (const [url, options, expected] of [
    ['http://merajmirzaei.com/services?lang=fa', {}, 'https://merajmirzaei.com/services?lang=fa'],
    ['http://www.merajmirzaei.com/fa/miragesohi', {}, 'https://merajmirzaei.com/fa/miragesohi'],
    ['http://merajmirzaei.com/admin/login', {method:'POST', body:'password=test'}, 'https://merajmirzaei.com/admin/login'],
  ]) {
    const res = await api.worker.fetch(new Request(url, options), {});
    assert.equal(res.status, 308);
    assert.equal(res.headers.get('Location'), expected);
  }
  const local = await api.worker.fetch(new Request('http://localhost:8787/admin'), {});
  assert.equal(local.status, 401);
  assert.equal(local.headers.get('Location'), null);
});

test('edits made while a save is pending stay dirty and use the new SHA on retry', async () => {
  let resolve;
  const requests = [];
  const p = panel((_url, init) => { requests.push(JSON.parse(init.body)); return new Promise((r) => { resolve = r; }); });
  p.state.entries = [{id:'one', title_en:'Before'}]; p.state.entriesDirty = true;
  const saving = p.save();
  await Promise.resolve();
  p.state.entries[0].title_en = 'After';
  assert.equal(p.buttons.saveBtn.disabled, true);
  resolve(jsonResponse({ok:true, sha:'credits-new'})); await saving;
  assert.equal(requests[0].content[0].title_en, 'Before');
  assert.equal(p.state.entries[0].title_en, 'After');
  assert.equal(p.state.entriesDirty, true);
  assert.equal(p.state.entriesSha, 'credits-new');
  const retry = p.save(); await Promise.resolve();
  assert.equal(requests[1].sha, 'credits-new');
  assert.equal(requests[1].content[0].title_en, 'After');
  resolve(jsonResponse({ok:true, sha:'credits-final'})); await retry;
  assert.equal(p.state.entriesDirty, false);
});

test('a second Save is ignored while the first is pending', async () => {
  let resolve; let calls = 0;
  const p = panel(() => { calls++; return new Promise((r) => { resolve = r; }); });
  p.state.entries = [{id:'one'}]; p.state.entriesDirty = true;
  const first = p.save(); p.save(); await Promise.resolve();
  assert.equal(calls, 1); resolve(jsonResponse({ok:true, sha:'new'})); await first;
});

for (const uploading of ['cover', 'video', 'gallery', 'unloaded lyrics']) {
  test(`preflight blocks every request during ${uploading}`, () => {
    const p = panel(() => { throw new Error('Must not send any request'); });
    p.state.entriesDirty = true; p.state.homepageDirty = true;
    if (uploading === 'cover') p.state.coverUploads = 1;
    if (uploading === 'video') p.state.newReleases = [{_uploading:50}];
    if (uploading === 'gallery') p.state.galUpload = {done:0};
    if (uploading === 'unloaded lyrics') { p.state.lyricsDirty = true; p.state.lyricsLoaded = false; }
    assert.equal(p.save(), undefined); assert.equal(p.state.entriesDirty, true);
  });
}

test('one network failure cannot discard another successful save', async () => {
  const p = panel((url) => url.endsWith('save-homepage') ? Promise.reject(new Error('offline'))
    : Promise.resolve(jsonResponse({ok:true, sha:'credits-success'})));
  p.state.entries = [{id:'one'}]; p.state.entriesDirty = true; p.state.homepageDirty = true;
  await p.save();
  assert.equal(p.state.entriesSha, 'credits-success'); assert.equal(p.state.entriesDirty, false);
  assert.equal(p.state.homepageDirty, true); assert.equal(p.state.saving, false);
  assert.equal(p.buttons.saveBtn2.disabled, false);
});

test('a gallery response preserves edits and new blobs added while saving', async () => {
  let resolve;
  const p = panel(() => new Promise((r) => { resolve = r; }));
  p.state.gallery = [{id:'photo', src:'/images/gallery/original.jpg', _blob:'blob1', people:[], caption_en:'Before'}];
  p.state.galleryDirty = true;
  const saving = p.save(); await Promise.resolve();
  p.state.gallery[0].caption_en = 'After';
  p.state.gallery.push({id:'new', src:'/images/gallery/new.jpg', _blob:'blob2', people:[]});
  resolve(jsonResponse({ok:true, sha:'gallery-new', content:[{id:'photo', src:'/images/gallery/renamed.jpg'}]}));
  await saving;
  assert.equal(p.state.galleryDirty, true); assert.equal(p.state.gallery[0].caption_en, 'After');
  assert.equal(p.state.gallery[0].src, '/images/gallery/renamed.jpg');
  assert.equal(p.state.gallery[0]._blob, undefined); assert.equal(p.state.gallery[1]._blob, 'blob2');
});

test('private notes go to KV only, and reload with the GitHub revision', async () => {
  const kv = new Map(); let committed;
  const api = worker((_url, init) => {
    if (init.method === 'PUT') { committed = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64'));
      return jsonResponse({content:{sha:'new-credits'}}); }
    return jsonResponse({content:Buffer.from(JSON.stringify(committed)).toString('base64'), encoding:'base64', sha:'new-credits'});
  });
  const env = { COMMENTS:{put:async (k,v) => kv.set(k,JSON.parse(v)), get:async (k) => kv.get(k)}, GITHUB_TOKEN:'test' };
  const result = await api.handleSave(post('/admin/api/save', {sha:'old', content:[{id:'one', title_en:'Song', notes:'PRIVATE NOTE', status_genius:'pending'}]}), env);
  assert.equal(result.status, 200);
  assert.equal(committed[0].notes, undefined); assert.equal(committed[0].status_genius, undefined);
  assert.equal(JSON.stringify(committed).includes('PRIVATE NOTE'), false);
  assert.equal(kv.get('admin:credits:'+committed[0]._adminRevision).one.notes, 'PRIVATE NOTE');
  const loaded = await (await api.handleGetCredits(env)).json();
  assert.equal(loaded.data[0].notes, 'PRIVATE NOTE'); assert.equal(loaded.data[0].status_genius, 'pending');
  assert.equal(loaded.data[0]._adminRevision, undefined);
});

test('a private KV failure never sends a public GitHub write', async () => {
  const api = worker();
  const res = await api.handleSave(post('/admin/api/save', {content:[{id:'one', notes:'private'}]}),
    { COMMENTS:{put:async () => { throw new Error('KV unavailable'); }} });
  assert.equal(res.status, 502);
});

test('a failed GitHub write leaves existing private revisions intact', async () => {
  const kv = new Map([['admin:credits:existing',{one:{notes:'Winner'}}]]);
  const api = worker(() => jsonResponse({message:'Conflict'},409));
  const res = await api.handleSave(post('/admin/api/save', {sha:'stale', content:[{id:'one',notes:'Loser'}]}),
    {COMMENTS:{put:async (k,v) => kv.set(k,JSON.parse(v))}});
  assert.equal(res.status, 409); assert.equal(kv.get('admin:credits:existing').one.notes, 'Winner');
});

test('the migration recovers all old notes from the pinned original revision', async () => {
  const legacy = JSON.parse(execFileSync('git', ['show','5c413fbe10ada42b55a6068600791b05dde5eaec:merajmirzaei-site (4)/data/credits.json'],
    {cwd:new URL('..', import.meta.url), encoding:'utf8'}));
  // Build the initial rollout fixture independently of later live admin saves.
  const current = legacy.map(({notes, status_musicbrainz, status_discogs, status_genius, ...entry}) => entry);
  let api; let calls = 0;
  api = worker((url) => {
    calls++;
    const data = url.includes('ref='+api.LEGACY_CREDITS_REF)
      ? legacy : current;
    return jsonResponse({content:Buffer.from(JSON.stringify(data)).toString('base64'), encoding:'base64', sha:'new'});
  });
  current[0]._adminRevision = api.LEGACY_CREDITS_REVISION;
  const res = await api.handleGetCredits({COMMENTS:{get:async () => null}});
  const data = (await res.json()).data;
  assert.equal(calls, 2); assert.equal(data.length, legacy.length);
  assert.equal(data.filter((e) => e.notes).length, 38);
  for (const e of data) {
    const original = legacy.find((row) => row.id === e.id);
    for (const field of ['notes','status_musicbrainz','status_discogs','status_genius'])
      assert.equal(e[field], original[field] || (field === 'notes' ? '' : 'not started'));
  }
});

test('a missing private revision fails closed instead of erasing notes', async () => {
  const api = worker(() => jsonResponse({content:Buffer.from(JSON.stringify([{id:'one',_adminRevision:'missing'}])).toString('base64'),encoding:'base64'}));
  assert.equal((await api.handleGetCredits({COMMENTS:{get:async () => null}})).status, 503);
});

test('public JSON strips notes, statuses and revision through encoded/extensionless paths', async () => {
  const api = worker();
  const env = {ASSETS:{fetch:async () => jsonResponse([{id:'one', title_en:'Song', notes:'PRIVATE', status_genius:'pending',_adminRevision:'hidden'}])}};
  for (const path of ['/data/credits.json','/data/credits','/data/%63redits.json','/data%2Fcredits.json']) {
    const res = await api.worker.fetch(new Request('https://merajmirzaei.com'+path),env);
    assert.equal(res.status,200); assert.deepEqual(await res.json(), [{id:'one',title_en:'Song'}]);
  }
});

test('public data filtering never falls back to an unfiltered broken asset', async () => {
  const api = worker();
  const res = await api.worker.fetch(new Request('https://merajmirzaei.com/data/credits.json'),
    {ASSETS:{fetch:async () => new Response('invalid PRIVATE JSON')}});
  assert.equal(res.status,503); assert.equal((await res.text()).includes('PRIVATE'),false);
});

test('submissions scan past 1000 keys, paginate newest first, and read only 50 records', async () => {
  const keys = Array.from({length:1205},(_,i) => ({name:'s:item-'+String(i).padStart(5,'0'), metadata:{ts:i,read:i%2===0}}));
  const records = new Map(keys.map((k) => [k.name,{id:k.name.slice(2),ts:k.metadata.ts}]));
  let gets = 0; const cursors = [];
  const env = {COMMENTS:{
    list:async ({cursor,prefix}) => {assert.equal(prefix,'s:'); cursors.push(cursor); const offset=Number(cursor||0);
      return {keys:keys.slice(offset,offset+1000),list_complete:offset+1000>=keys.length,cursor:String(offset+1000)};},
    get:async (k) => {gets++; return records.get(k)||null;}
  }};
  const api = worker();
  const first = await (await api.handleAdminListSubmissions(new Request('https://site/admin/api/submissions'),env)).json();
  assert.equal(first.submissions[0].ts,1204); assert.equal(first.submissions.length,50);
  assert.equal(first.total,1205); assert.equal(gets,51); assert.equal(cursors.length,2);
  const second = await (await api.handleAdminListSubmissions(new Request('https://site/admin/api/submissions?before='+encodeURIComponent(first.next)),env)).json();
  assert.equal(second.submissions[0].ts,1154); assert.equal(second.submissions.length,50);
  assert.equal(first.submissions.some((a) => second.submissions.some((b) => a.id===b.id)),false);
});

test('gallery retry rejects a concurrent gallery edit at the new pinned head', async () => {
  let refCount = 0; let patches = 0;
  const refs = [];
  const api = worker((url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/git/ref/heads/main')) return jsonResponse({object:{sha:++refCount===1?'head1':'head2'}});
    if (u.pathname.includes('/contents/')) {
      refs.push(u.searchParams.get('ref'));
      if (u.pathname.endsWith('gallery.json')) return jsonResponse({sha:u.searchParams.get('ref')==='head1'?'original':'concurrent'});
      return jsonResponse([]);
    }
    if (u.pathname.includes('/git/commits/') && init.method === 'GET') return jsonResponse({tree:{sha:'tree1'}});
    if (u.pathname.endsWith('/git/trees')) return jsonResponse({sha:'newtree'});
    if (u.pathname.endsWith('/git/commits')) return jsonResponse({sha:'newcommit'});
    if (init.method === 'PATCH') {patches++; return jsonResponse({message:'Not fast forward'},422);}
    throw new Error('Unexpected GitHub request: '+url);
  });
  const res = await api.handleSaveGallery(post('/admin/api/gallery/save',{content:[],sha:'original',newFiles:[]}),{});
  assert.equal(res.status,409); assert.equal(patches,1); assert.deepEqual(refs,['head1','head1','head2']);
});

test('rate-limited login returns 429 with a retry time', async () => {
  const api = worker(); let key;
  const res = await api.handleLoginPost(post('/admin/login',{password:'anything'}),
    {ADMIN_PASSWORD:'test-password',ADMIN_LOGIN_LIMITER:{limit:async (v) => {key=v.key;return {success:false};}}});
  assert.equal(res.status,429); assert.equal(res.headers.get('Retry-After'),'60'); assert.match(key,/^admin-login:/);
});

test('valid login still works with the limiter and diagnostics require authentication', async () => {
  const api = worker(); const env = {ADMIN_PASSWORD:'test-password',ADMIN_LOGIN_LIMITER:{limit:async () => ({success:true})}};
  const res = await api.worker.fetch(post('/admin/login',{password:'test-password'}),env);
  assert.equal(res.status,303); assert.match(res.headers.get('Set-Cookie'),/HttpOnly/);
  assert.equal(res.headers.get('Cache-Control'),'private, no-store');
  const denied = await api.worker.fetch(new Request('https://site/admin/__diag'),env);
  assert.equal(denied.status,401);
});

test('uncached media HEAD never fetches or caches the full video', async () => {
  const methods = []; const waits = [];
  const api = worker((url, init={}) => {
    methods.push(init.method||'GET');
    return url.includes('api.github.com') ? new Response(null,{status:302,headers:{Location:'https://video/file'}})
      : new Response(null,{headers:{'Content-Length':'9000000'}});
  },{caches:{default:{match:async () => null,put:async () => {throw new Error('Must not cache HEAD');}}}});
  const res = await api.serveMedia(new Request('https://site/media/123/video.mp4',{method:'HEAD'}),{},
    {waitUntil:(p) => waits.push(p)},['','123','video','mp4']);
  assert.equal(res.status,200); assert.equal(await res.text(),''); assert.deepEqual(methods,['GET','HEAD']);
  assert.equal(waits.length,0);
});

test('uncached full video GET reuses its body for the cache', async () => {
  let calls=0; const waits=[]; let cached;
  const api = worker((url) => {calls++; return url.includes('api.github.com')
    ? new Response(null,{status:302,headers:{Location:'https://video/file'}}) : new Response('video');},
    {caches:{default:{match:async () => null,put:async (_k,r) => {cached=await r.text();}}}});
  const res = await api.serveMedia(new Request('https://site/media/123/video.mp4'),{},
    {waitUntil:(p) => waits.push(p)},['','123','video','mp4']);
  assert.equal(await res.text(),'video'); await Promise.all(waits);
  assert.equal(calls,2); assert.equal(cached,'video');
});
