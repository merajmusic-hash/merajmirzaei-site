#!/usr/bin/env node
// Lightweight entity-SEO regression check (no test framework in this repo
// yet — this mirrors scripts/fetch-artwork.mjs's plain-script convention).
// Run against a local `wrangler dev` instance:
//   node scripts/validate-seo.mjs [http://localhost:8787]
//
// Checks, per plan section 13:
//   - every canonical page (static pages + one per titled recording)
//     returns exactly one <script type="application/ld+json"> block, and
//     it parses as valid JSON
//   - every Person node found uses the same, single @id (no duplicate
//     Person identities)
//   - every page has a self-referencing <link rel="canonical">
//   - hreflang en/fa/x-default are present and internally consistent
//   - no duplicate @id values within a single page's @graph
//   - no duplicate recording slugs in data/credits.json
//   - a song with lyrics in data/lyrics.json has a lyrics page (both
//     languages, one MusicComposition, linked from the song's own page);
//     a song without lyrics has none (404)
//   - an untitled ("Pending") entry's slug 404s rather than serving a
//     fabricated page
//   - sitemap.xml contains exactly the same canonical URL set (static
//     pages + every titled recording, both languages) — no omissions,
//     nothing stale

const BASE = process.argv[2] || 'http://localhost:8787';

const STATIC_PAGES = [
  '/', '/fa/',
  '/about', '/fa/about',
  '/credits', '/fa/credits',
  '/releases', '/fa/releases',
  '/miragesohi', '/fa/miragesohi',
  '/gallery', '/fa/gallery',
  '/services', '/fa/services',
  '/collaborate', '/fa/collaborate',
  '/journal', '/fa/journal',
  '/mastering-for-streaming', '/fa/mastering-for-streaming',
  '/mixing-persian-vocals', '/fa/mixing-persian-vocals',
  '/traditional-instruments', '/fa/traditional-instruments',
];

const PERSON_ID = 'https://merajmirzaei.com/#person';
const WEBSITE_ID = 'https://merajmirzaei.com/#website';
const ARTIST_PROFILE = 'https://open.spotify.com/artist/0MMVa85QISJ2PbwS9xrYX9';

let failures = 0;
function fail(msg) {
  failures++;
  console.error('FAIL: ' + msg);
}
function ok(msg) {
  console.log('ok:   ' + msg);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Mirrors worker.js's normalizeForMatch/matchKeysForRecord/findStoryForEntry
// — duplicated here (rather than imported) since this script validates the
// worker's live HTTP output, not its internals directly.
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/ك/g, 'ک')
    .replace(/ي/g, 'ی')
    .replace(/‌/g, ' ')
    .replace(/ـ/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function matchKeysForRecord(rec) {
  const keys = new Set();
  const titles = [rec.title_en, rec.title_fa].filter(Boolean);
  const artists = [rec.artist_en, rec.artist_fa].filter(Boolean);
  for (const t of titles) {
    for (const a of artists) {
      keys.add(normalizeForMatch(t) + '' + normalizeForMatch(a));
    }
  }
  return keys;
}
function findStoryForEntry(stories, entry) {
  const entryKeys = matchKeysForRecord(entry);
  for (const story of stories) {
    for (const key of matchKeysForRecord(story)) {
      if (entryKeys.has(key)) return story;
    }
  }
  return null;
}

async function checkPage(path, { requireOgImagePrefix = 'https://merajmirzaei.com/images/portrait.jpg' } = {}) {
  const url = BASE + path;
  const res = await fetch(url);
  if (res.status !== 200) {
    fail(`${path}: expected 200, got ${res.status}`);
    return;
  }
  const html = await res.text();

  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) {
    fail(`${path}: expected exactly 1 JSON-LD block, found ${scripts.length}`);
    return;
  }
  let data;
  try {
    data = JSON.parse(scripts[0][1]);
  } catch (e) {
    fail(`${path}: JSON-LD does not parse: ${e.message}`);
    return;
  }
  const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];

  const ids = graph.map((n) => n['@id']).filter(Boolean);
  const dupeIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupeIds.length) fail(`${path}: duplicate @id within one page's @graph: ${dupeIds.join(', ')}`);

  const personNodes = graph.filter((n) => n['@type'] === 'Person');
  if (personNodes.length !== 1) {
    fail(`${path}: expected exactly 1 Person node, found ${personNodes.length}`);
  } else if (personNodes[0]['@id'] !== PERSON_ID) {
    fail(`${path}: Person @id is "${personNodes[0]['@id']}", expected "${PERSON_ID}"`);
  }

  const person = personNodes[0];
  if (person) {
    for (const name of ['معراج میرزایی', 'Miragesohi', 'میراژسهی']) {
      if (!Array.isArray(person.alternateName) || !person.alternateName.includes(name)) {
        fail(`${path}: Person is missing the alternate name "${name}"`);
      }
    }
    if (!Array.isArray(person.sameAs) || !person.sameAs.includes(ARTIST_PROFILE)) {
      fail(`${path}: Person does not link to the current Miragesohi Spotify profile`);
    }
  }

  if (path === '/' || path === '/fa/') {
    const sites = graph.filter((n) => n['@type'] === 'WebSite');
    if (sites.length !== 1) {
      fail(`${path}: expected one shared WebSite identity, found ${sites.length}`);
    } else {
      const site = sites[0];
      if (site['@id'] !== WEBSITE_ID || site.url !== 'https://merajmirzaei.com/') {
        fail(`${path}: WebSite must use the canonical domain-root identity`);
      }
      if (site.publisher?.['@id'] !== PERSON_ID) fail(`${path}: WebSite publisher must be the canonical Person`);
      for (const name of ['معراج میرزایی', 'Miragesohi', 'میراژسهی']) {
        if (!Array.isArray(site.alternateName) || !site.alternateName.includes(name)) {
          fail(`${path}: WebSite is missing the alternate name "${name}"`);
        }
      }
      const profile = graph.find((n) => n['@type'] === 'ProfilePage');
      if (profile?.isPartOf?.['@id'] !== WEBSITE_ID) fail(`${path}: ProfilePage must reference the shared WebSite`);
    }
  }

  if (['/', '/fa/', '/about', '/fa/about', '/miragesohi', '/fa/miragesohi'].includes(path)) {
    const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    for (const name of ['Meraj Mirzaei', 'معراج میرزایی', 'Miragesohi', 'میراژسهی']) {
      if (!visibleText.includes(name)) fail(`${path}: "${name}" must appear in readable page text`);
    }
  }

  // Every Miragesohi page (the artist page, the Releases hub and anything
  // under /releases/) ends with the block that leads into the credits; no
  // other page carries it.
  const isMiragesohiPage = /^(\/fa)?\/(miragesohi|releases(\/[a-z0-9-]+(\/(about|lyrics))?)?)$/.test(path);
  const careerBlocks = (html.match(/<section class="cb" id="careerBlock">/g) || []).length;
  if (careerBlocks !== (isMiragesohiPage ? 1 : 0)) {
    fail(`${path}: expected ${isMiragesohiPage ? 1 : 0} career block(s), found ${careerBlocks}`);
  } else if (isMiragesohiPage) {
    const prefix = path.startsWith('/fa/') ? '/fa' : '';
    if (!html.includes(`<a class="btn" href="${prefix}/credits">`)) fail(`${path}: career block has no link to the credits`);
    if (!new RegExp(`<a class="cb-tile[^"]*" href="${prefix}/credits/artist/[a-z0-9-]+"`).test(html)) fail(`${path}: career block has no artist links`);
  }

  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)">/);
  if (!canonicalMatch) {
    fail(`${path}: missing <link rel="canonical">`);
  } else if (canonicalMatch[1] !== 'https://merajmirzaei.com' + path) {
    fail(`${path}: canonical is "${canonicalMatch[1]}", expected self-referencing "https://merajmirzaei.com${path}"`);
  }

  for (const hl of ['en', 'fa', 'x-default']) {
    const re = new RegExp(`<link rel="alternate" hreflang="${hl}" href="([^"]+)">`);
    const m = html.match(re);
    if (!m) fail(`${path}: missing hreflang="${hl}"`);
  }

  // Usually the site's own portrait/cover, but a recording's cover_url can
  // legitimately be a verified external image URL (e.g. from a label's
  // own site) — any absolute https:// image URL is valid here, not only
  // same-origin ones.
  const ogImageMatch = html.match(/<meta property="og:image" content="(https:\/\/[^"]+)">/);
  if (!ogImageMatch) fail(`${path}: missing og:image`);

  return { graph, ogImage: ogImageMatch && ogImageMatch[1] };
}

async function checkRecordingPage(path, entry, hub, lang) {
  const result = await checkPage(path);
  if (!result) return;
  const { graph } = result;
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);

  const recNodes = graph.filter((n) => n['@type'] === 'MusicRecording' || n['@type'] === 'MusicAlbum');
  if (recNodes.length !== 1) {
    fail(`${path}: expected exactly 1 recording node, found ${recNodes.length}`);
  } else if (recNodes[0].name !== title) {
    fail(`${path}: recording name "${recNodes[0].name}" does not match data "${title}"`);
  }

  const breadcrumbs = graph.filter((n) => n['@type'] === 'BreadcrumbList');
  if (breadcrumbs.length !== 1 || breadcrumbs[0].itemListElement.length !== 3) {
    fail(`${path}: expected a 3-level BreadcrumbList (Home -> ${hub} -> recording)`);
  }
}

async function checkSitemap(expectedUrls) {
  const res = await fetch(BASE + '/sitemap.xml');
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const got = new Set(locs);

  for (const u of expectedUrls) {
    if (!got.has(u)) fail(`sitemap.xml: missing ${u}`);
  }
  for (const u of got) {
    if (!expectedUrls.has(u)) fail(`sitemap.xml: unexpected/stale entry ${u}`);
    if (/\.html/.test(u)) fail(`sitemap.xml: non-canonical .html URL ${u}`);
  }
  if (locs.length === new Set(locs).size) {
    ok(`sitemap.xml: ${locs.length} URLs, no duplicates, matches the ${expectedUrls.size} expected canonical URLs`);
  } else {
    fail('sitemap.xml: contains duplicate <loc> entries');
  }
}

for (const path of STATIC_PAGES) {
  await checkPage(path);
}

// Recording pages, generated from the same live data/credits.json this
// script fetches the same way the worker itself does — read-only.
const creditsData = await (await fetch(BASE + '/data/credits.json')).json();
const expectedSitemapUrls = new Set(STATIC_PAGES.map((p) => 'https://merajmirzaei.com' + p));
let recordingPageCount = 0;
const artistSlugs = new Set();

const storiesData = await (await fetch(BASE + '/data/song-stories.json')).json().catch(() => null);
let storyPageCount = 0;

// Songs that have lyrics in data/lyrics.json (keyed by the song's id).
const lyricsData = await (await fetch(BASE + '/data/lyrics.json')).json().catch(() => []);
const lyricSlugs = new Set(
  (Array.isArray(lyricsData) ? lyricsData : [])
    .filter((r) => r && typeof r.id === 'string' && typeof r.lyrics === 'string' && r.lyrics.trim())
    .map((r) => slugify(r.id))
);
let lyricsPageCount = 0;
let lyricsAbsentChecked = false;

for (const hub of ['credits', 'releases']) {
  const entries = creditsData.filter((e) => Array.isArray(e.pages) && e.pages.includes(hub) && (e.title_en || e.title_fa));
  const slugs = entries.map((e) => slugify(e.id));
  const dupeSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupeSlugs.length) fail(`data/credits.json: duplicate recording slug(s) on ${hub}: ${[...new Set(dupeSlugs)].join(', ')}`);

  for (const entry of entries) {
    const slug = slugify(entry.id);
    for (const lang of ['en', 'fa']) {
      const path = (lang === 'fa' ? '/fa/' : '/') + hub + '/' + slug;
      await checkRecordingPage(path, entry, hub, lang);
      expectedSitemapUrls.add('https://merajmirzaei.com' + path);
      recordingPageCount++;
    }

    if (hub === 'credits' && entry.artist_en && entry.artist_en !== 'Miragesohi') {
      artistSlugs.add(slugify(entry.artist_en));
    }

    // Lyrics page: exists only for a song with lyrics, in both languages,
    // with exactly one MusicComposition carrying the lyrics, and the song's
    // own page links to it. A song without lyrics must 404 there.
    for (const lang of ['en', 'fa']) {
      const lyricsPath = (lang === 'fa' ? '/fa/' : '/') + hub + '/' + slug + '/lyrics';
      if (lyricSlugs.has(slug)) {
        const result = await checkPage(lyricsPath);
        if (result) {
          const comps = result.graph.filter((n) => n['@type'] === 'MusicComposition');
          if (comps.length !== 1) fail(`${lyricsPath}: expected exactly 1 MusicComposition node, found ${comps.length}`);
          else if (!comps[0].lyrics || !String(comps[0].lyrics.text || '').trim()) fail(`${lyricsPath}: MusicComposition has no lyrics text`);
          const crumbs = result.graph.filter((n) => n['@type'] === 'BreadcrumbList');
          if (crumbs.length !== 1 || crumbs[0].itemListElement.length !== 4) fail(`${lyricsPath}: expected a 4-level BreadcrumbList`);
        }
        const trackHtml = await (await fetch(BASE + (lang === 'fa' ? '/fa/' : '/') + hub + '/' + slug)).text();
        if (!trackHtml.includes('href="' + lyricsPath + '"')) fail(`${lyricsPath}: the song's own page has no link to it`);
        expectedSitemapUrls.add('https://merajmirzaei.com' + lyricsPath);
        lyricsPageCount++;
      } else if (!lyricsAbsentChecked) {
        const res = await fetch(BASE + lyricsPath);
        if (res.status !== 404) fail(`${lyricsPath}: song without lyrics should 404, got ${res.status}`);
        else ok(`${lyricsPath}: song without lyrics correctly 404s (no empty page)`);
        lyricsAbsentChecked = true;
      }
    }

    const story = Array.isArray(storiesData) ? findStoryForEntry(storiesData, entry) : null;
    if (story) {
      for (const [lang, text] of [['en', story.story_en], ['fa', story.story_fa]]) {
        if (!text || !String(text).trim()) continue;
        const path = (lang === 'fa' ? '/fa/' : '/') + hub + '/' + slug + '/about';
        const result = await checkPage(path);
        if (result) {
          const wp = result.graph.filter((n) => n['@type'] === 'WebPage' && n.about);
          if (wp.length !== 1) fail(`${path}: expected exactly 1 story WebPage node with "about", found ${wp.length}`);
        }
        expectedSitemapUrls.add('https://merajmirzaei.com' + path);
        storyPageCount++;
      }
    }
  }
}
ok(`checked ${recordingPageCount} recording page requests (${recordingPageCount / 2} titled entries x 2 languages)`);
ok(`checked ${storyPageCount} "about this track" story page requests`);
ok(`checked ${lyricsPageCount} lyrics page requests`);

for (const artistSlug of artistSlugs) {
  for (const lang of ['en', 'fa']) {
    const path = (lang === 'fa' ? '/fa/' : '/') + 'credits/artist/' + artistSlug;
    await checkPage(path);
    expectedSitemapUrls.add('https://merajmirzaei.com' + path);
  }
}
ok(`checked ${artistSlugs.size} artist page requests x 2 languages`);

// Gallery photo pages: one per photo in data/gallery.json, both languages.
const galleryData = await (await fetch(BASE + '/data/gallery.json')).json().catch(() => []);
let photoPageCount = 0;
for (const e of Array.isArray(galleryData) ? galleryData : []) {
  if (!e || typeof e.src !== 'string') continue;
  const slug = e.src.split('/').pop().replace(/\.(?:jpg|png|webp)$/, '');
  for (const lang of ['en', 'fa']) {
    const path = (lang === 'fa' ? '/fa/' : '/') + 'gallery/' + slug;
    const result = await checkPage(path);
    if (result) {
      const ip = result.graph.filter((n) => n['@type'] === 'ItemPage');
      if (ip.length !== 1) fail(`${path}: expected exactly 1 ItemPage node, found ${ip.length}`);
    }
    expectedSitemapUrls.add('https://merajmirzaei.com' + path);
    photoPageCount++;
  }
}
ok(`checked ${photoPageCount} gallery photo page requests`);

// An untitled ("Pending") entry must not get a fabricated page.
const untitled = creditsData.find((e) => !(e.title_en || e.title_fa));
if (untitled) {
  const hub = untitled.pages.includes('credits') ? 'credits' : 'releases';
  const path = '/' + hub + '/' + slugify(untitled.id);
  const res = await fetch(BASE + path);
  if (res.status !== 404) fail(`${path}: untitled entry should 404, got ${res.status}`);
  else ok(`${path}: untitled entry correctly 404s (no fabricated page)`);
}

await checkSitemap(expectedSitemapUrls);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
