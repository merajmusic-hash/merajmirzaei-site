#!/usr/bin/env node
// Parses track entries out of the site's HTML, and for any track that
// doesn't already have a cover image in the repo, looks it up on the
// iTunes Search API and saves the artwork to images/covers/<slug>.jpg.
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

const ITUNES_DELAY_MS = 300;

// Only run when invoked directly (`node scripts/fetch-artwork.mjs`), not
// when another script imports this module's parsing helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

async function main() {
  const tracks = new Map(); // slug -> { artist, title, sources: Set<file> }

  for (const page of PAGES) {
    if (!existsSync(page.file)) {
      console.log(`- skip (missing file): ${relPath(page.file)}`);
      continue;
    }
    const html = await readFile(page.file, "utf8");
    const found = page.parse(html);
    console.log(`${relPath(page.file)}: found ${found.length} track entr${found.length === 1 ? "y" : "ies"}`);
    for (const { artist, title } of found) {
      const slug = slugify(`${artist} ${title}`);
      if (!slug) continue;
      const entry = tracks.get(slug) || { artist, title, sources: new Set() };
      entry.sources.add(relPath(page.file));
      tracks.set(slug, entry);
    }
  }

  await mkdir(COVERS_DIR, { recursive: true });

  const found = [];
  const missing = [];
  const skipped = [];

  for (const [slug, { artist, title }] of tracks) {
    const dest = path.join(COVERS_DIR, `${slug}.jpg`);
    if (existsSync(dest)) {
      skipped.push(slug);
      continue;
    }

    const term = `${artist} ${title}`;
    try {
      const artworkUrl = await lookupArtwork(term);
      if (!artworkUrl) {
        console.log(`✗ no iTunes match for "${term}" (${slug})`);
        missing.push(slug);
        continue;
      }
      const bytes = await downloadImage(artworkUrl);
      await writeFile(dest, bytes);
      console.log(`✓ saved ${slug}.jpg  ("${term}")`);
      found.push(slug);
    } catch (err) {
      console.log(`✗ failed for "${term}" (${slug}): ${err.message}`);
      missing.push(slug);
    }

    await sleep(ITUNES_DELAY_MS);
  }

  console.log("");
  console.log(`Done. ${found.length} downloaded, ${skipped.length} already present, ${missing.length} not found.`);
  if (missing.length) {
    console.log(`Missing: ${missing.join(", ")}`);
  }
}

// ---- HTML parsing -----------------------------------------------------

// Credits pages: artists are grouped in <div class="channel">...</div>
// blocks, each holding an artist-name element and one or more
// <img class="thumb" src="..."><span class="TITLE_CLASS">Title</span>
// pairs inside <button> track rows.
function parseCreditsPage({ nameClass, titleClass }) {
  return function parse(html) {
    const results = [];
    for (const chunk of splitOnMarker(html, '<div class="channel"')) {
      const artist = extractSpanText(chunk, nameClass);
      if (!artist) continue;
      for (const { title } of extractThumbTitles(chunk, titleClass)) {
        results.push({ artist, title });
      }
    }
    return results;
  };
}

// Releases pages (and the homepage, which currently has none): a flat
// list of <img class="thumb ..." src="..."> rows with a title span, all
// by the same artist.
function parseFlatThumbs(artist, titleClass = "rt") {
  return function parse(html) {
    return extractThumbTitles(html, titleClass).map(({ title }) => ({ artist, title }));
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
  const re = /<img class="thumb[^"]*"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const title = extractSpanText(m[1], titleClass);
    if (title) results.push({ title });
  }
  return results;
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

// ---- iTunes lookup + download ------------------------------------------

async function lookupArtwork(term) {
  const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(term) + "&entity=song&limit=1";
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`iTunes search HTTP ${resp.status}`);
  const data = await resp.json();
  const hit = data && data.results && data.results[0];
  if (!hit || !hit.artworkUrl100) return null;
  return hit.artworkUrl100.replace("100x100", "600x600");
}

async function downloadImage(url) {
  const resp = await fetch(url);
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

export { PAGES, SITE_DIR, COVERS_DIR, slugify, extractThumbTitles, splitOnMarker, extractSpanText };
