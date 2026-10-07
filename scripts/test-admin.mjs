// Regression tests without dependencies or real GitHub/KV mutations.
// Run: node --test scripts/test-admin.mjs
import * as LyricsFormat from '../merajmirzaei-site (4)/lyrics-format.mjs';
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
    LyricsFormat, crypto:webcrypto, atob, btoa, setTimeout, console, fetch:fetchImpl, ...extras });
  vm.runInContext(source.replace("import { EmailMessage } from 'cloudflare:email';", 'class EmailMessage {}')
    .replace("import * as LyricsFormat from '../merajmirzaei-site (4)/lyrics-format.mjs';", '')
    .replace('export default {', 'const worker = {') + `
    globalThis.api = { worker, handleSave, handleGetCredits, handleSaveGallery, handleLoginPost,
      handleAdminListSubmissions, handleAdminListComments, serveMedia, buildEntityGraph, buildSitemapXml,
      LEGACY_CREDITS_REVISION, LEGACY_CREDITS_REF, signSession, RENAMED_RECORDING_IDS,
      handleGetComments, handlePostComment, handleAdminApproveComment,
      buildArtistIndexHtml, artistsInSiteOrder,
      buildCareerBlockHtml, isMiragesohiPagePath, buildReleaseCardsHtml, handleSaveLyrics, handleGetLyrics, readLyricsReadOnly, lyricsFor, lyricsDetailsFor, buildLyricsPageContent, validateLyrics };`, context);
  return context.api;
}

function panel(fetchImpl) {
  const state = { entries:[], entriesSha:'credits-old', entriesDirty:false, homepage:[], homepageSha:'home-old',
    homepageDirty:false, newReleases:[], newReleasesDirty:false, gallery:[], galleryDirty:false,
    lyrics:{}, lyricsMeta:{}, lyricsUndo:{}, lyricsSaved:{}, lyricsDirty:false, lyricsLoaded:true, saving:false, coverUploads:0 };
  const buttons = { saveBtn:{disabled:false}, saveBtn2:{disabled:false} };
  const messages = [];
  const context = vm.createContext({ state, LyricsFormat, document:{getElementById:(id) => buttons[id]},
    fetch:fetchImpl, showMsg:(text) => messages.push(text), setDirty:() => {}, render:() => {},
    nrUploading:() => state.newReleases.some((x) => x._uploading != null),
    lyricsHas:(id) => !!String(state.lyrics[id] || '').trim(),
    galById:(id) => state.gallery.find((x) => x.id === id), byOrder:(a,b) => (a.order||0)-(b.order||0) });
  vm.runInContext(admin.slice(admin.indexOf('  function lyricsHas(id)'), admin.indexOf('  function lyricsLineCount(id)')), context);
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


test('release cards expose localized song links without private fields', () => {
  const api = worker();
  const data = [
    {id:'my-song', pages:['releases'], title_en:'My song', title_fa:'آهنگ من', artist_en:'Miragesohi', artist_fa:'میراژسهی', notes:'PRIVATE NOTE', role_production:true},
    {id:'other-song', pages:['credits'], title_en:'Other song'},
    {id:'untitled', pages:['releases'], title_en:''},
  ];
  const html = api.buildReleaseCardsHtml(data, 'fa');
  assert.match(html, /href="\/fa\/releases\/my-song"/);
  assert.match(html, /آهنگ من/);
  assert.match(html, /میراژسهی/);
  assert.doesNotMatch(html, /PRIVATE NOTE|other-song|untitled/);
});

test('release cards escape stored names and survive a failed client fetch', async () => {
  const api = worker();
  const html = api.buildReleaseCardsHtml([{id:'test', pages:['releases'], title_en:'<script>alert(1)</script>', artist_en:'A & B'}], 'en');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A &amp; B/);
  const renderer = fs.readFileSync(new URL('../merajmirzaei-site (4)/credits-render.js', import.meta.url), 'utf8');
  const preserved = {getAttribute:() => 'true', innerHTML:'server links'};
  const context = vm.createContext({window:{__CREDITS_CONFIG__:{lang:'en',page:'releases',mount:'#releasesRoot'}},
    document:{querySelector:() => preserved}, fetch:() => Promise.reject(new Error('offline'))});
  vm.runInContext(renderer, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(preserved.innerHTML, 'server links');
});

test('pasted Unicode line separators keep verses, stanzas and Persian half spaces', () => {
  assert.equal(LyricsFormat.cleanText('می\u200cروم\u2028\nمی\u200cمانی\u2028شعر\u2029بند تازه'), 'می\u200cروم\nمی\u200cمانی\nشعر\n\nبند تازه');
  assert.equal(LyricsFormat.renderHtml('یک\r\nدو\r\n\r\nسه'), '<p dir="auto">یک<br>دو</p><p dir="auto">سه</p>');
  assert.equal(LyricsFormat.renderHtml('<script> & "poem"'), '<p dir="auto">&lt;script&gt; &amp; &quot;poem&quot;</p>');
});

test('explicit formatting tools retain words and existing stanza boundaries', () => {
  assert.equal(LyricsFormat.formatText('یک / دو | سه ؛ چهار  پنج', 'split'), 'یک\nدو\nسه\nچهار\nپنج');
  assert.equal(LyricsFormat.formatText('یک\nدو\nسه\nچهار\nپنج', 'couplets'), 'یک\nدو\n\nسه\nچهار\n\nپنج');
  assert.equal(LyricsFormat.formatText('یک\n\nدو', 'compact'), 'یک\nدو');
  assert.equal(LyricsFormat.formatText('یک   دو\n\nسه', 'clean'), 'یک دو\n\nسه');
  assert.equal(LyricsFormat.formatText('یک دو سه چهار پنج شش\n\nهفت هشت نه ده', 'wrap', 3), 'یک دو سه\nچهار پنج شش\n\nهفت هشت نه\nده');
});

test('lyrics save/reload retains poet and layout and keeps old client rows compatible', async () => {
  let committed;
  const api = worker((_url, init) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body); assert.equal(body.sha, 'lyrics-old');
      committed = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return jsonResponse({content:{sha:'lyrics-new'}});
    }
    return jsonResponse({content:Buffer.from(JSON.stringify(committed)).toString('base64'), encoding:'base64', sha:'lyrics-new'});
  });
  const res = await api.handleSaveLyrics(post('/admin/api/save-lyrics', {sha:'lyrics-old',content:[
    {id:'legacy',lyrics:'One\r\nTwo'},
    {id:'styled',lyrics:'متن شعر',poet:' شاعر نمونه ',layout:{font:'system',fontSize:24,lineHeight:2.4,stanzaGap:40,textAlign:'center',maxWidth:600,position:'right'}},
    {id:'later',lyrics:'',poet:'شاعر نمونه',layout:{maxWidth:500}},
    {id:'empty',lyrics:'',poet:'',layout:LyricsFormat.DEFAULT_LAYOUT},
  ]}), {});
  assert.equal(res.status, 200);
  assert.deepEqual(committed[0], {id:'legacy',lyrics:'One\nTwo'});
  assert.equal(committed.length, 3); assert.equal(committed[1].poet, 'شاعر نمونه');
  assert.equal(committed[1].layout.fontSize, 24); assert.equal(committed[2].lyrics, '');
  const loaded = await (await api.handleGetLyrics({})).json();
  assert.deepEqual(loaded.data, committed); assert.equal(loaded.sha, 'lyrics-new');
  const map = await api.readLyricsReadOnly({ASSETS:{fetch:async () => jsonResponse(committed)}});
  assert.equal(api.lyricsFor(map,{id:'later'}), null);
  assert.equal(api.lyricsDetailsFor(map,{id:'styled'}).poet, 'شاعر نمونه');
});

test('invalid lyric layout and credit inputs fail before any GitHub write', async () => {
  const api = worker();
  for (const fields of [
    {poet:'x'.repeat(201)}, {poet:42}, {layout:[]}, {layout:{font:'url(javascript:alert(1))'}},
    {layout:{fontSize:500}}, {layout:{lineHeight:0}}, {layout:{textAlign:'center;display:none'}},
    {layout:{position:'outside'}}, {layout:JSON.parse('{"__proto__":{}}')}, {layout:{unknown:1}},
  ]) assert.equal((await api.handleSaveLyrics(post('/admin/api/save-lyrics', {content:[{id:'one',lyrics:'poem',...fields}]}), {})).status, 400);
  assert.doesNotMatch(LyricsFormat.layoutStyle({font:'url(evil)',textAlign:'right;display:none'}), /evil|display:none/);
});

test('lyric credit and appearance edits during saving remain dirty for the next save', async () => {
  let resolve; const sent = [];
  const p = panel((_url,init) => {sent.push(JSON.parse(init.body)); return new Promise(r => {resolve=r;});});
  p.state.lyrics.one = 'Poem'; p.state.lyricsDirty = true; p.state.lyricsSha = 'old';
  p.state.lyricsMeta.one = {poet:'Before',layout:{fontSize:20}};
  const first = p.save(); await Promise.resolve();
  p.state.lyricsMeta.one.poet = 'After'; p.state.lyricsMeta.one.layout.fontSize = 28;
  resolve(jsonResponse({ok:true,sha:'new'})); await first;
  assert.equal(sent[0].content[0].poet,'Before'); assert.equal(sent[0].content[0].layout.fontSize,20);
  assert.equal(p.state.lyricsDirty,true); assert.equal(p.state.lyricsSha,'new');
  const retry = p.save(); await Promise.resolve();
  assert.equal(sent[1].content[0].poet,'After'); assert.equal(sent[1].content[0].layout.fontSize,28); assert.equal(sent[1].sha,'new');
  resolve(jsonResponse({ok:true,sha:'final'})); await retry;
  assert.equal(p.state.lyricsDirty,false);
});

test('an entered credit without text is saved but never marked as a published poem', async () => {
  let submitted;
  const p = panel((_url,init) => {submitted=JSON.parse(init.body); return Promise.resolve(jsonResponse({ok:true,sha:'new'}));});
  p.state.lyricsMeta.one = {poet:'Poet'}; p.state.lyricsDirty=true;
  await p.save(); assert.equal(submitted.content[0].lyrics,''); assert.equal(submitted.content[0].poet,'Poet');
  assert.equal(p.state.lyricsSaved.one,false);
});

test('public poem renders escaped credit and safe layout in both page languages', () => {
  const api = worker(), entry={id:'one',title_en:'Song',title_fa:'ترانه',artist_en:'Artist',artist_fa:'خواننده',pages:['releases']};
  const map = new Map([['one',{lyrics:'یک\nدو\n\nسه',poet:'<script>Poet & name</script>',layout:{fontSize:28,textAlign:'center',maxWidth:600,position:'right'}}]]);
  for (const lang of ['fa','en']) {
    const html=api.buildLyricsPageContent(entry,lang,'releases',map.get('one').lyrics,{creditsData:[entry],lyricsMap:map,hasStory:false});
    assert.match(html,/&lt;script&gt;Poet &amp; name&lt;\/script&gt;/); assert.doesNotMatch(html,/<script>Poet/);
    assert.match(html,/--lyr-size:28px/); assert.match(html,/--lyr-align:center/); assert.match(html,/--lyr-width:600px/);
    assert.match(html,/lang="fa" dir="rtl"><p dir="auto">یک<br>دو<\/p><p dir="auto">سه<\/p>/);
    assert.match(html,lang === 'fa' ? /ترانه‌سرا/ : /Lyrics by/);
  }
});

test('structured lyricist credit appears only when explicitly entered', async () => {
  const api=worker(), entry={id:'one',title_en:'Song',title_fa:'ترانه',artist_en:'Artist',pages:['releases']};
  for (const poet of ['', 'Poet']) {
    const env={ASSETS:{fetch:async req => jsonResponse(new URL(req.url).pathname.endsWith('credits.json')
      ? [entry] : new URL(req.url).pathname.endsWith('lyrics.json') ? [{id:'one',lyrics:'One\nTwo',poet}] : [])}};
    const graph=await api.buildEntityGraph('/releases/one/lyrics',env);
    const composition=graph.nodes.find(n=>n['@type']==='MusicComposition');
    assert.ok(composition); assert.equal(composition.lyricist?.name,poet || undefined);
    assert.equal(composition.lyrics.author?.name,poet || undefined);
  }
});

function lyricsEditor() {
  const state={lyrics:{one:'یک / دو | سه ؛ چهار',two:'Other poem'},lyricsMeta:{},lyricsUndo:{},lyricsSaved:{},entries:[]};
  const element=()=>({classList:{toggle:()=>{}},setAttribute(k,v){this[k]=v;}});
  const input={...element(),value:state.lyrics.one,selectionEnd:3,focus(){this.focused=true;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
  const name=element(), poet={...element(),querySelector:()=>name};
  const nodes={'.lyr-status':element(),'textarea[data-lyr]':input,'.lyr-text':element(),'.lyr-empty':element(),'.lyr-preview-poet':poet,'[data-format="undo"]':element(),'[data-lyr-words]':{value:'3'}};
  const row={querySelector:s=>nodes[s],querySelectorAll:()=>[]};
  const context=vm.createContext({state,LyricsFormat,document:{getElementById:()=>null},setDirty:()=>{},
    hasPage:(e,p)=>e.pages.includes(p),esc:LyricsFormat.escapeText});
  vm.runInContext(admin.slice(admin.indexOf('  function lyricsHas(id)'),admin.indexOf('  function renderLyricsTab()')),context);
  const button=action=>({getAttribute:key=>key==='data-id'?'one':action,closest:()=>row});
  return {state,nodes,input,context,row,action:a=>context.lyricsFormatAction(button(a))};
}

test('editor tools update only their poem, preview and dirty state; Undo restores exact text', () => {
  const p=lyricsEditor(), original=p.state.lyrics.one;
  p.action('split'); assert.equal(p.input.value,'یک\nدو\nسه\nچهار');
  assert.equal(p.state.lyrics.two,'Other poem'); assert.equal(p.state.lyricsDirty,true);
  assert.equal(p.nodes['.lyr-text'].innerHTML,'<p dir="auto">یک<br>دو<br>سه<br>چهار</p>');
  assert.equal(p.nodes['[data-format="undo"]'].disabled,false);
  p.action('couplets'); assert.equal(p.input.value,'یک\nدو\n\nسه\nچهار');
  p.action('undo'); assert.equal(p.input.value,'یک\nدو\nسه\nچهار');
  p.action('undo'); assert.equal(p.input.value,original); assert.equal(p.nodes['[data-format="undo"]'].disabled,true);
  assert.equal(p.input.focused,true);
});

test('line break toolbar inserts at cursor without deleting selected words', () => {
  const p=lyricsEditor(); p.state.lyrics.one='First Second'; p.input.value='First Second'; p.input.selectionStart=0;p.input.selectionEnd=5;
  p.action('line'); assert.equal(p.input.value,'First\n Second'); assert.equal(p.input.selectionEnd,6);
  p.action('undo'); assert.equal(p.input.value,'First Second');
});

test('credit and layout controls immediately update preview without rerendering the editor', () => {
  const p=lyricsEditor();
  const control=(attrs,value,type='text',valid=true)=>({value,type,validity:{valid},getAttribute:k=>attrs[k]??null,closest:()=>p.row});
  p.context.lyricsControlInput(control({'data-lyr-meta':'one'},'<Poet>'),false);
  assert.equal(p.nodes['.lyr-preview-poet'].hidden,false);assert.equal(p.nodes['.lyr-preview-poet'].querySelector().textContent,'<Poet>');
  const font=control({'data-lyr-layout':'one','data-layout-field':'fontSize'},'28','number');
  p.context.lyricsControlInput(font,false); assert.match(p.nodes['.lyr-text'].style,/--lyr-size:28px/);
  p.context.lyricsControlInput(control({'data-lyr-layout':'one','data-layout-field':'fontSize'},'','number'),false);
  assert.equal(p.state.lyricsMeta.one.layout.fontSize,28);
  const outside=control({'data-lyr-layout':'one','data-layout-field':'fontSize'},'90','number',false);
  p.context.lyricsControlInput(outside,true); assert.equal(outside.value,36);
  p.action('reset'); assert.equal(p.state.lyricsMeta.one.poet,'<Poet>'); assert.equal(p.state.lyricsMeta.one.layout.fontSize,18.5);
  assert.equal(p.state.lyricsMeta.two,undefined);
});

// --- readable song addresses ------------------------------------------------

const realCredits = () => JSON.parse(fs.readFileSync(new URL('../merajmirzaei-site (4)/data/credits.json', import.meta.url), 'utf8'));
const realNewReleases = () => JSON.parse(fs.readFileSync(new URL('../merajmirzaei-site (4)/data/new-releases.json', import.meta.url), 'utf8'));

test('a renamed song\'s old address redirects permanently, in every form, and keeps the query', async () => {
  const api = worker();
  for (const [from, to] of [
    ['/releases/new-1790330185189-7ht8i', '/releases/miragesohi-dor-az-tasavor'],
    ['/fa/releases/new-1790441193810-5wt4t', '/fa/releases/miragesohi-didi-ey-tanha-omidam'],
    ['/fa/releases/new-1790441193810-5wt4t/lyrics', '/fa/releases/miragesohi-didi-ey-tanha-omidam/lyrics'],
    ['/credits/new-1788546862191-9eahs/about', '/credits/amir-abbas-hassanzadeh-be-ki-begam/about'],
    ['/releases/new-1790330185189-7ht8i/?utm=ig', '/releases/miragesohi-dor-az-tasavor?utm=ig'],
  ]) {
    const res = await api.worker.fetch(new Request('https://merajmirzaei.com' + from), {});
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('Location'), 'https://merajmirzaei.com' + to);
  }
});

test('the data uses the new ids only, and every renamed id points at a real titled song', () => {
  const api = worker();
  const credits = realCredits();
  const ids = new Set(credits.map((e) => e.id));
  assert.equal(ids.size, credits.length);
  for (const [old, current] of Object.entries(api.RENAMED_RECORDING_IDS)) {
    assert.equal(ids.has(old), false, old + ' is still in credits.json');
    const entry = credits.find((e) => e.id === current);
    assert.ok(entry && entry.title_en, current + ' is not a titled song');
    assert.equal(Object.prototype.hasOwnProperty.call(api.RENAMED_RECORDING_IDS, current), false);
  }
  // No song with a page still has a placeholder id, and no video points at a missing song.
  for (const e of credits) if (e.title_en || e.title_fa) assert.doesNotMatch(e.id, /^new-\d+-/);
  for (const it of realNewReleases()) if (it.release_id) assert.ok(ids.has(it.release_id), it.release_id);
});

test('the sitemap and the release cards use the new address, never the old one', async () => {
  const credits = realCredits();
  const api = worker();
  const env = { ASSETS:{ fetch:async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/data/credits.json') return jsonResponse(credits);
    return jsonResponse([]);
  } } };
  const xml = await api.buildSitemapXml(env);
  assert.match(xml, /<loc>https:\/\/merajmirzaei\.com\/releases\/miragesohi-dor-az-tasavor<\/loc>/);
  assert.match(xml, /<loc>https:\/\/merajmirzaei\.com\/fa\/credits\/amir-abbas-hassanzadeh-be-ki-begam<\/loc>/);
  assert.doesNotMatch(xml, /\/new-\d+-/);
  const cards = api.buildReleaseCardsHtml(credits, 'fa');
  assert.match(cards, /href="\/fa\/releases\/miragesohi-didi-ey-tanha-omidam"/);
  assert.doesNotMatch(cards, /\/new-\d+-/);
});

test('private notes saved under a song\'s old id still load after the rename', async () => {
  const stored = [{id:'miragesohi-dor-az-tasavor', title_en:'Dor Az Tasavor', _adminRevision:'rev-1'}, {id:'other', title_en:'Other'}];
  const api = worker(() => jsonResponse({content:Buffer.from(JSON.stringify(stored)).toString('base64'), encoding:'base64', sha:'s'}));
  const kv = new Map([['admin:credits:rev-1', {
    'new-1790330185189-7ht8i': {notes:'OLD-ID NOTE', status_discogs:'done'},
    other: {notes:'plain'},
  }]]);
  const env = { COMMENTS:{get:async (k) => kv.get(k)}, GITHUB_TOKEN:'test' };
  const loaded = await (await api.handleGetCredits(env)).json();
  assert.equal(loaded.data[0].notes, 'OLD-ID NOTE');
  assert.equal(loaded.data[0].status_discogs, 'done');
  assert.equal(loaded.data[1].notes, 'plain');
});

test('comments left before a rename still show, and new ones are filed under the new id', async () => {
  const api = worker();
  const kv = new Map();
  const meta = new Map();
  const put = async (k, v, opts) => { kv.set(k, v); if (opts && opts.metadata) meta.set(k, opts.metadata); };
  const env = {
    COMMENTS:{ put, get:async (k) => kv.get(k), delete:async (k) => { kv.delete(k); meta.delete(k); },
      list:async ({prefix}) => ({ keys:[...meta].filter(([k]) => k.startsWith(prefix)).map(([name, metadata]) => ({name, metadata})), list_complete:true }) },
    ASSETS:{ fetch:async () => jsonResponse(realNewReleases()) },
  };
  // One approved before the rename (old key), one still waiting with the old song id.
  await put('a:new-1790441193810-5wt4t:aaaaaa-1111', '{}', {metadata:{id:'aaaaaa-1111', song:'new-1790441193810-5wt4t', name:'Sara', text:'old one', ts:1}});
  const waiting = {id:'bbbbbb-2222', song:'new-1790441193810-5wt4t', name:'Ali', text:'approved later', ts:2};
  await put('p:bbbbbb-2222', JSON.stringify(waiting), {metadata:waiting});
  const approved = await api.handleAdminApproveComment(post('/admin/api/comments/approve', {id:'bbbbbb-2222'}), env);
  assert.equal(approved.status, 200);
  assert.ok(kv.has('a:miragesohi-didi-ey-tanha-omidam:bbbbbb-2222'));
  // Asking by the new id, or by the old one (a cached page), returns both.
  for (const song of ['miragesohi-didi-ey-tanha-omidam', 'new-1790441193810-5wt4t']) {
    const res = await api.handleGetComments(new Request('https://merajmirzaei.com/api/comments?song=' + song), env);
    assert.deepEqual((await res.json()).comments.map((c) => c.text), ['old one', 'approved later']);
  }
  // A cached page that still posts with the old id is accepted and stored under the new one.
  const posted = await api.handlePostComment(post('/api/comments', {song:'new-1790441193810-5wt4t', name:'Nima', text:'hello', elapsed:5000}), env);
  assert.equal(posted.status, 200);
  const pendingRec = [...meta].find(([k]) => k.startsWith('p:'))[1];
  assert.equal(pendingRec.song, 'miragesohi-didi-ey-tanha-omidam');
});

test('a new row gets a readable id on its first titled save; lyrics and videos follow it', async () => {
  const requests = [];
  const p = panel((url, init) => { requests.push({url, body:JSON.parse(init.body)}); return Promise.resolve(jsonResponse({ok:true, sha:'next'})); });
  p.state.entries = [
    {id:'miragesohi-thunder', artist_en:'Miragesohi', title_en:'Thunder'},
    {id:'new-1800000000000-abcde', _fresh:true, artist_en:'Miragesohi', title_en:'Thunder', title_fa:'تندر'},
    {id:'new-1800000000001-fghij', _fresh:true, artist_en:'Reza Sadeghi', title_en:''},
    {id:'new-1700000000000-zzzzz', artist_en:'Old', title_en:'Already Published'},
  ];
  p.state.entriesDirty = true;
  p.state.lyrics['new-1800000000000-abcde'] = 'line'; p.state.lyricsDirty = true;
  p.state.newReleases = [{id:'nr-1', release_id:'new-1800000000000-abcde', title_en:'Thunder', order:0}];
  await p.save();
  const sent = Object.fromEntries(requests.map((r) => [r.url, r.body.content]));
  assert.deepEqual(sent['/admin/api/save'].map((e) => e.id),
    ['miragesohi-thunder', 'miragesohi-thunder-2', 'new-1800000000001-fghij', 'new-1700000000000-zzzzz']);
  assert.equal(JSON.stringify(sent['/admin/api/save']).includes('_fresh'), false);
  assert.equal(sent['/admin/api/save-lyrics'][0].id, 'miragesohi-thunder-2');
  assert.equal(sent['/admin/api/save-new-releases'][0].release_id, 'miragesohi-thunder-2');
  // Saved with a title: settled. Still untitled: still waiting for a name.
  assert.equal(p.state.entries[1]._fresh, undefined);
  assert.equal(p.state.entries[2]._fresh, true);
  // Retitling a settled row never moves its page.
  p.state.entries[1].title_en = 'Lightning'; p.state.entriesDirty = true;
  await p.save();
  assert.equal(requests.at(-1).body.content[1].id, 'miragesohi-thunder-2');
});

test('a failed first save leaves the row free to follow a corrected title', async () => {
  let fail = true; const bodies = [];
  const p = panel((_url, init) => { bodies.push(JSON.parse(init.body));
    return Promise.resolve(fail ? jsonResponse({error:'conflict'}, 409) : jsonResponse({ok:true, sha:'next'})); });
  p.state.entries = [{id:'new-1800000000000-abcde', _fresh:true, artist_en:'Kamyar', title_en:'Typo'}];
  p.state.entriesDirty = true;
  await p.save();
  assert.equal(p.state.entries[0].id, 'kamyar-typo');
  assert.equal(p.state.entries[0]._fresh, true);
  p.state.entries[0].title_en = 'Right Name'; fail = false;
  await p.save();
  assert.equal(bodies.at(-1).content[0].id, 'kamyar-right-name');
  assert.equal(p.state.entries[0]._fresh, undefined);
});

// --- one order of artists for the whole site -----------------------------------

test('the Credits page lists artist names in the homepage order, then the Credits order', async () => {
  const api = worker();
  const credits = [
    {id:'a1', pages:['credits'], order:1, artist_en:'Ahmad Saeedi', artist_fa:'احمد سعیدی', title_en:'One'},
    {id:'k1', pages:['credits'], order:2, artist_en:'Kamyar', artist_fa:'کامیار', title_en:'Two'},
    {id:'p1', pages:['credits'], order:3, artist_en:'Panida', artist_fa:'پانیدا', title_en:'Three'},
    {id:'g1', pages:['credits'], order:4, artist_en:'Googoosh', artist_fa:'گوگوش', title_en:'Four'},
    {id:'k2', pages:['credits'], order:5, artist_en:'Kamyar', artist_fa:'کامیار', title_en:'Five'},
    {id:'r1', pages:['credits'], order:6, artist_en:'Reza Sadeghi', artist_fa:'رضا صادقی', title_en:''},
    {id:'m1', pages:['releases'], order:7, artist_en:'Miragesohi', title_en:'Mine'},
  ];
  const homepage = [{artist_en:'Kamyar', order:1}, {artist_en:'Googoosh', order:0}, {artist_en:'Reza Sadeghi', order:2}];
  const env = { ASSETS:{ fetch:async (req) => jsonResponse(new URL(req.url).pathname === '/data/homepage.json' ? homepage : credits) } };
  const names = (html) => [...html.matchAll(/<a href="[^"]*">([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(names(await api.buildArtistIndexHtml(env, 'fa')), ['گوگوش', 'کامیار', 'احمد سعیدی', 'پانیدا']);
  assert.deepEqual(names(await api.buildArtistIndexHtml(env, 'en')), ['Googoosh', 'Kamyar', 'Ahmad Saeedi', 'Panida']);
  // Without a readable homepage list the Credits order still stands.
  const noHome = { ASSETS:{ fetch:async (req) => new URL(req.url).pathname === '/data/homepage.json' ? new Response('x', {status:404}) : jsonResponse(credits) } };
  assert.deepEqual(names(await api.buildArtistIndexHtml(noHome, 'en')), ['Ahmad Saeedi', 'Kamyar', 'Panida', 'Googoosh']);
});

test('on the real data Googoosh is the first artist name on the Credits page', async () => {
  const api = worker();
  const read = (name) => JSON.parse(fs.readFileSync(new URL('../merajmirzaei-site (4)/data/' + name, import.meta.url), 'utf8'));
  const env = { ASSETS:{ fetch:async (req) => jsonResponse(read(new URL(req.url).pathname.split('/').pop())) } };
  const html = await api.buildArtistIndexHtml(env, 'fa');
  const names = [...html.matchAll(/<a href="[^"]*">([^<]+)<\/a>/g)].map((m) => m[1]);
  assert.equal(names[0], 'گوگوش');
  assert.equal(new Set(names).size, names.length);
});

// --- the way from a Miragesohi page into the rest of the career ---------------

test('the career block is on every Miragesohi page and nowhere else', () => {
  const api = worker();
  for (const path of ['/miragesohi', '/fa/miragesohi', '/releases', '/fa/releases', '/releases/miragesohi-thunder',
    '/fa/releases/miragesohi-dor-az-tasavor', '/releases/miragesohi-baz-baroon/lyrics', '/fa/releases/miragesohi-farangis/about']) {
    assert.equal(api.isMiragesohiPagePath(path), true, path);
  }
  for (const path of ['/', '/fa/', '/credits', '/fa/credits', '/credits/kamyar-danse', '/credits/artist/googoosh',
    '/about', '/gallery', '/releases/', '/fa/releases/x/other', '/miragesohi/extra']) {
    assert.equal(api.isMiragesohiPagePath(path), false, path);
  }
});

test('the career block names the first singers of the homepage wall, in its order, with their pages', () => {
  const api = worker();
  const credits = [
    {id:'k1', pages:['credits'], order:1, artist_en:'Kamyar', artist_fa:'کامیار', title_en:'One', spotify_artist_url:'https://open.spotify.com/artist/KAM', cover_url:'/images/covers/k1.jpg'},
    {id:'g1', pages:['credits'], order:2, artist_en:'Googoosh', artist_fa:'گوگوش', title_en:'Two', spotify_artist_url:'https://open.spotify.com/artist/GOO', cover_url:'https://open.spotify.com/track/not-an-image'},
    {id:'h1', pages:['credits'], order:3, artist_en:'Helen', artist_fa:'هلن', title_en:'Three', artist_image:'/images/artists/helen.jpg'},
    {id:'p1', pages:['credits'], order:4, artist_en:'Panida', artist_fa:'پانیدا', title_en:'Four', cover_url:'/images/covers/p1.png'},
    {id:'x1', pages:['credits'], order:5, artist_en:'<Odd> "Name"', artist_fa:'', title_en:'Five'},
    {id:'r1', pages:['credits'], order:6, artist_en:'Reza Sadeghi', artist_fa:'رضا صادقی', title_en:''},
    {id:'m1', pages:['releases'], order:7, artist_en:'Miragesohi', title_en:'Mine'},
  ];
  const home = ['googoosh', 'reza-sadeghi', 'kamyar'];
  const fa = api.buildCareerBlockHtml(credits, home, 'fa');
  const names = (html) => [...html.matchAll(/<span class="cb-name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names(fa), ['گوگوش', 'کامیار', 'هلن', 'پانیدا', '&lt;Odd&gt; &quot;Name&quot;']);
  assert.match(fa, /href="\/fa\/credits\/artist\/googoosh"/);
  assert.match(fa, /<a class="btn" href="\/fa\/credits">کارنامه کامل<\/a>/);
  assert.match(fa, /پیش از میراژسهی/);
  // Photos: a Spotify one is looked up by the page (its cover only if that is a real image),
  // the artist's own photo and a plain cover are served straight away.
  assert.match(fa, /href="\/fa\/credits\/artist\/googoosh" data-spotify="https:\/\/open\.spotify\.com\/artist\/GOO">/);
  assert.match(fa, /data-spotify="https:\/\/open\.spotify\.com\/artist\/KAM" data-cover="\/images\/covers\/k1\.jpg"/);
  assert.match(fa, /<img class="cb-img" src="\/images\/artists\/helen\.jpg"/);
  assert.match(fa, /<img class="cb-img" src="\/images\/covers\/p1\.png"/);
  assert.doesNotMatch(fa, /Miragesohi<\/span>|رضا صادقی|not-an-image"/);
  const en = api.buildCareerBlockHtml(credits, home, 'en');
  assert.deepEqual(names(en).slice(0, 2), ['Googoosh', 'Kamyar']);
  assert.match(en, /href="\/credits\/artist\/kamyar"/);
  assert.match(en, /<a class="btn" href="\/credits">Full credits<\/a>/);
  assert.equal(api.buildCareerBlockHtml([{id:'m1', pages:['releases'], artist_en:'Miragesohi', title_en:'Mine'}], home, 'fa'), '');
});

test('on the real data the career block shows six singers, Googoosh first', () => {
  const api = worker();
  const read = (name) => JSON.parse(fs.readFileSync(new URL('../merajmirzaei-site (4)/data/' + name, import.meta.url), 'utf8'));
  const home = read('homepage.json').slice().sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((h) => h.artist_en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  const html = api.buildCareerBlockHtml(read('credits.json'), home, 'fa');
  const names = [...html.matchAll(/<span class="cb-name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(names.length, 6);
  assert.equal(names[0], 'گوگوش');
});
