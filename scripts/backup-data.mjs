#!/usr/bin/env node
// Builds the automatic backup files for the site's data, run by
// .github/workflows/backup-data.yml every time data/ changes (i.e. every
// admin-panel Save). Plain script, no dependencies — same convention as
// scripts/fetch-artwork.mjs.
//
//   node scripts/backup-data.mjs <output dir>
//
// Writes into <output dir>:
//   credits-latest.csv   — identical to the admin panel's "Export CSV"
//   credits-latest.json  — identical to the admin panel's "Export JSON"
//   <name>-latest.json   — a copy of every other data/*.json file
// The workflow then zips these into a dated snapshot and uploads it all to
// the "site-backups" GitHub release.

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'merajmirzaei-site (4)/data';
const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/backup-data.mjs <output dir>');
  process.exit(1);
}

// Must match EXPORT_FIELDS / buildCsv in admin-app.html, so a backup opens
// exactly like a manual export does.
const EXPORT_FIELDS = [
  'id', 'order', 'pages', 'artist_en', 'artist_fa', 'artist_image', 'spotify_artist_url',
  'title_en', 'title_fa', 'release_type', 'album_name', 'year', 'label',
  'role_arrangement', 'role_production', 'role_mix', 'role_mastering',
  'links', 'start_seconds', 'cover_url',
  'status_musicbrainz', 'status_discogs', 'status_genius', 'notes',
];

function formatLinksForCsv(links) {
  return (Array.isArray(links) ? links : []).map((l) => {
    if (!l) return '';
    return l.label ? (l.label + ': ' + l.url) : (l.url || '');
  }).join(' | ');
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(entries) {
  const rows = [EXPORT_FIELDS.join(',')];
  for (const entry of entries) {
    rows.push(EXPORT_FIELDS.map((field) => {
      if (field === 'links') return csvCell(formatLinksForCsv(entry.links));
      if (field === 'pages') return csvCell((entry.pages || []).join(';'));
      return csvCell(entry[field]);
    }).join(','));
  }
  // UTF-8 BOM so Excel shows the Farsi text correctly (same as the export).
  return String.fromCharCode(0xFEFF) + rows.join('\r\n') + '\r\n';
}

fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
if (!files.includes('credits.json')) {
  console.error('data/credits.json not found — refusing to write an empty backup');
  process.exit(1);
}

for (const file of files) {
  const text = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  const data = JSON.parse(text); // fail loudly rather than back up a broken file
  const base = file.replace(/\.json$/, '');
  if (base === 'credits') {
    fs.writeFileSync(path.join(outDir, 'credits-latest.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(outDir, 'credits-latest.csv'), buildCsv(data));
    console.log(`credits: ${data.length} entries -> credits-latest.csv, credits-latest.json`);
  } else {
    fs.writeFileSync(path.join(outDir, `${base}-latest.json`), text);
    console.log(`${base} -> ${base}-latest.json`);
  }
}
