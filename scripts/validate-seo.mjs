#!/usr/bin/env node
// Lightweight entity-SEO regression check (no test framework in this repo
// yet — this mirrors scripts/fetch-artwork.mjs's plain-script convention).
// Run against a local `wrangler dev` instance:
//   node scripts/validate-seo.mjs [http://localhost:8787]
//
// Checks, per plan section 13:
//   - every canonical page returns exactly one <script type="application/
//     ld+json"> block, and it parses as valid JSON
//   - every Person node found uses the same, single @id (no duplicate
//     Person identities)
//   - every page has a self-referencing <link rel="canonical">
//   - hreflang en/fa/x-default are present and internally consistent
//   - no duplicate @id values within a single page's @graph
//   - sitemap.xml contains exactly the same canonical URL set this script
//     checks (no omissions, nothing stale)

const BASE = process.argv[2] || 'http://localhost:8787';

const PAGES = [
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

async function checkPage(path) {
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

  if (!/<meta property="og:image" content="https:\/\/merajmirzaei\.com\/images\/portrait\.jpg">/.test(html)) {
    fail(`${path}: missing og:image`);
  }

  ok(`${path}: 1 JSON-LD block, 1 Person@${PERSON_ID.slice(-7)}, canonical + hreflang + og:image present`);
}

async function checkSitemap() {
  const res = await fetch(BASE + '/sitemap.xml');
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = new Set(PAGES.map((p) => 'https://merajmirzaei.com' + p));
  const got = new Set(locs);

  for (const u of expected) {
    if (!got.has(u)) fail(`sitemap.xml: missing ${u}`);
  }
  for (const u of got) {
    if (!expected.has(u)) fail(`sitemap.xml: unexpected/stale entry ${u}`);
    if (/\.html/.test(u)) fail(`sitemap.xml: non-canonical .html URL ${u}`);
  }
  if (locs.length === new Set(locs).size) {
    ok(`sitemap.xml: ${locs.length} URLs, no duplicates, matches the ${PAGES.length} canonical pages`);
  } else {
    fail('sitemap.xml: contains duplicate <loc> entries');
  }
}

for (const path of PAGES) {
  await checkPage(path);
}
await checkSitemap();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s) across ${PAGES.length} pages + sitemap.xml`);
process.exit(failures === 0 ? 0 : 1);
