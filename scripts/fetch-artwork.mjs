#!/usr/bin/env node
// Parses track entries out of the site's HTML, and for any track that
// doesn't already have a cover image in the repo, looks up artwork in
// priority order and saves it to images/covers/<slug>.jpg:
//
//   1. Spotify oEmbed, using the track's own Spotify URL (from its
//      button's data-uri) when the page has one.
//   2. Persian music sites, searched by "artist title", tried in order:
//      radiojavan.com, then nex1music.ir, then musicdel.ir. The first
//      search result's og:image is used.
//
// Usage: node scripts/fetch-artwork.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SITE_DIR = path.join(ROOT, "merajmirzaei-site (4)");
const COVERS_DIR = path.join(SITE_DIR, "images", "covers");

const PAGES = [
  { file: path.join(SITE_DIR, "index.html"), parse: parseFlatThumbs("MIRAGE") },
  { file: path.join(SITE_DIR, "fa", "index.html"), parse: parseFlatThumbs("MIRAGE") },
  { file: path.join(SITE_DIR, "credits.html"), parse: parseCreditsPage({ nameClass: "aname", titleClass: "t-main" }) },
  { file: path.join(SITE_DIR, "fa", "credits.html"), parse: parseCreditsPage({ nameClass: "aalt", titleClass: "t-lat" }) },
  { file: path.join(SITE_DIR, "releases.html"), parse: parseFlatThumbs("MIRAGE", "rt") },
  { file: path.join(SITE_DIR, "fa", "releases.html"), parse: parseFlatThumbs("MIRAGE", "ra") },
];

const REQUEST_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SOURCE_ORDER = ["spotify", "radiojavan", "nex1music", "musicdel"];

// Only run when invoked directly (`node scripts/fetch-artwork.mjs`), not
// when another script imports this module's parsing helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

async function main() {
  const tracks = new Map(); // slug -> { artist, title, spotifyUrl, sources: Set<file> }

  for (const page of PAGES) {
    if (!existsSync(page.file)) {
      console.log(`- skip (missing file): ${relPath(page.file)}`);
      continue;
    }
    const html = await readFile(page.file, "utf8");
    const found = page.parse(html);
    console.log(`${relPath(page.file)}: found ${found.length} track entr${found.length === 1 ? "y" : "ies"}`);
    for (const { artist, title, spotifyUrl } of found) {
      const slug = slugify(`${artist} ${title}`);
      if (!slug) continue;
      const entry = tracks.get(slug) || { artist, title, spotifyUrl, sources: new Set() };
      if (!entry.spotifyUrl && spotifyUrl) entry.spotifyUrl = spotifyUrl;
      entry.sources.add(relPath(page.file));
      tracks.set(slug, entry);
    }
  }

  await mkdir(COVERS_DIR, { recursive: true });

  const bySource = { spotify: [], radiojavan: [], nex1music: [], musicdel: [] };
  const skipped = [];
  const missing = [];

  for (const [slug, { artist, title, spotifyUrl }] of tracks) {
    const dest = path.join(COVERS_DIR, `${slug}.jpg`);
    if (existsSync(dest)) {
      skipped.push(slug);
      continue;
    }

    const term = `${artist} ${title}`;
    const result = await findArtwork({ term, spotifyUrl });

    if (result) {
      try {
        const bytes = await downloadImage(result.url);
        await writeFile(dest, bytes);
        console.log(`✓ [${result.source}] saved ${slug}.jpg  ("${term}")`);
        bySource[result.source].push(slug);
      } catch (err) {
        console.log(`✗ found via ${result.source} but couldn't download for "${term}" (${slug}): ${err.message}`);
        missing.push(slug);
      }
    } else {
      console.log(`✗ no artwork found anywhere for "${term}" (${slug})`);
      missing.push(slug);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log("");
  console.log("== Summary ==");
  for (const source of SOURCE_ORDER) {
    console.log(`${source}: ${bySource[source].length}${bySource[source].length ? " — " + bySource[source].join(", ") : ""}`);
  }
  console.log(`already present: ${skipped.length}`);
  console.log(`not found anywhere: ${missing.length}${missing.length ? " — " + missing.join(", ") : ""}`);
}

// ---- Artwork sources, tried in order ------------------------------------

async function findArtwork({ term, spotifyUrl }) {
  if (spotifyUrl) {
    try {
      const url = await spotifyOEmbedArt(spotifyUrl);
      if (url) return { url, source: "spotify" };
    } catch (err) {
      console.log(`  spotify oEmbed failed for "${term}": ${err.message}`);
    }
  }

  for (const site of PERSIAN_SITES) {
    try {
      const url = await site.lookup(term);
      if (url) return { url, source: site.name };
    } catch (err) {
      console.log(`  ${site.name} failed for "${term}": ${err.message}`);
    }
  }

  return null;
}

async function spotifyOEmbedArt(spotifyUrl) {
  const resp = await fetchWithTimeout("https://open.spotify.com/oembed?url=" + encodeURIComponent(spotifyUrl));
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data && data.thumbnail_url) || null;
}

const PERSIAN_SITES = [
  { name: "radiojavan", lookup: radiojavanLookup },
  { name: "nex1music", lookup: (term) => wordpressStyleLookup(term, "https://nex1music.ir") },
  { name: "musicdel", lookup: (term) => wordpressStyleLookup(term, "https://musicdel.ir") },
];

async function radiojavanLookup(term) {
  const origin = "https://www.radiojavan.com";
  const html = await fetchText(`${origin}/search?query=${encodeURIComponent(term)}`);
  if (!html) return null;

  const link =
    firstMatchingLink(html, origin, /href="([^"]*\/mp3s\/[^"]+)"/i) ||
    firstMatchingLink(html, origin, /href="([^"]*\/mp3\/[^"]+)"/i);
  if (!link) return null;

  return fetchOgImage(link);
}

// nex1music.ir and musicdel.ir are Persian music blogs on a typical
// WordPress-style search (?s=) and post-title markup.
async function wordpressStyleLookup(term, origin) {
  const html = await fetchText(`${origin}/?s=${encodeURIComponent(term)}`);
  if (!html) return null;

  const link =
    firstMatchingLink(
      html,
      origin,
      /<h[1-4][^>]*class="[^"]*(?:entry-title|post-title)[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"/i
    ) || firstMatchingLink(html, origin, /<article[\s\S]*?<a[^>]+href="([^"]+)"/i);
  if (!link) return null;

  return fetchOgImage(link);
}

function firstMatchingLink(html, origin, re) {
  const m = html.match(re);
  if (!m) return null;
  try {
    return new URL(m[1], origin).toString();
  } catch {
    return null;
  }
}

async function fetchOgImage(pageUrl) {
  const html = await fetchText(pageUrl);
  if (!html) return null;
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1] : null;
}

async function fetchText(url) {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) return null;
  return resp.text();
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...(init.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url) {
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`artwork download HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relPath(p) {
  return path.relative(ROOT, p);
}

// ---- HTML parsing --------------------------------------------------------

// Credits pages: artists are grouped in <div class="channel">...</div>
// blocks, each holding an artist-name element and one or more track
// <button data-uri="spotify:TYPE:ID" ...>
//   <img class="thumb" src="..."><span class="TITLE_CLASS">Title</span>
// </button> rows. The button's data-uri, when present, is the track's
// Spotify link.
function parseCreditsPage({ nameClass, titleClass }) {
  return function parse(html) {
    const results = [];
    for (const chunk of splitOnMarker(html, '<div class="channel"')) {
      const artist = extractSpanText(chunk, nameClass);
      if (!artist) continue;
      for (const { title, spotifyUrl } of extractThumbTitles(chunk, titleClass)) {
        results.push({ artist, title, spotifyUrl });
      }
    }
    return results;
  };
}

// Releases pages (and the homepage, which currently has none): a flat
// list of track buttons, all by the same artist.
function parseFlatThumbs(artist, titleClass = "rt") {
  return function parse(html) {
    return extractThumbTitles(html, titleClass).map(({ title, spotifyUrl }) => ({ artist, title, spotifyUrl }));
  };
}

function splitOnMarker(html, marker) {
  const starts = [];
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    starts.push(idx);
    idx = html.indexOf(marker, idx + marker.length);
  }
  return starts.map((start, i) => html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length));
}

// A "track" is a <button>...</button> that carries a cover-art <img
// class="thumb"> followed somewhere by the given title span.
function extractThumbTitles(html, titleClass) {
  const results = [];
  const re = /<button([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, attrs, body] = m;
    if (!/class="thumb/.test(body)) continue;
    const title = extractSpanText(body, titleClass);
    if (!title) continue;
    const uriMatch = attrs.match(/data-uri="([^"]*)"/);
    const spotifyUrl = uriMatch ? spotifyUriToUrl(uriMatch[1]) : null;
    results.push({ title, spotifyUrl });
  }
  return results;
}

function spotifyUriToUrl(uri) {
  const m = uri.match(/^spotify:(\w+):(\w+)$/);
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
}

function extractSpanText(html, className) {
  const re = new RegExp(`<[a-z]+[^>]*class="${className}"[^>]*>([^<]*)</`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents left behind by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export { PAGES, SITE_DIR, COVERS_DIR, slugify, extractThumbTitles, splitOnMarker, extractSpanText };
