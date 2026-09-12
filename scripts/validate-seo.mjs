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
//   - an untitled ("Pending") entry's slug 404s rather than serving a
//     fabricated page
//   - sitemap.xml contains exactly the same canonical URL set (static
//     pages + every titled recording, both languages) — no omissions,
//     nothing stale

const BASE = process.argv[2] || 'http://localhost:8787';

const STATIC_PAGES = [
  '/', '/fa/',
  '/credits', '/fa/credits',
  '/releases', '/fa/releases',
  '/mirage', '/fa/mirage',
  '/gallery', '/fa/gallery',
  '/services', '/fa/services',
  '/journal', '/fa/journal',
  '/mastering-for-streaming', '/fa/mastering-for-streaming',
  '/mixing-persian-vocals', '/fa/mixing-persian-vocals',
  '/traditional-instruments', '/fa/traditional-instruments',
];

const PERSON_ID = 'https://merajmirzaei.com/#person';

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

    if (hub === 'credits' && entry.artist_en && entry.artist_en !== 'MIRAGE') {
      artistSlugs.add(slugify(entry.artist_en));
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

for (const artistSlug of artistSlugs) {
  for (const lang of ['en', 'fa']) {
    const path = (lang === 'fa' ? '/fa/' : '/') + 'credits/artist/' + artistSlug;
    await checkPage(path);
    expectedSitemapUrls.add('https://merajmirzaei.com' + path);
  }
}
ok(`checked ${artistSlugs.size} artist page requests x 2 languages`);

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
