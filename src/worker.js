import { EmailMessage } from 'cloudflare:email';

// Static-asset passthrough for the public site, plus a password-gated
// /admin panel for editing data/credits.json and data/homepage.json. The
// panel itself is server rendered by this Worker (never a plain static
// asset) so it can enforce the password check before any admin HTML/JS
// ever reaches the browser, and its "Save" actions commit straight to this
// repo's GitHub API using a server-side token the browser never sees.
//
// Required Cloudflare secrets (set via `wrangler secret put NAME`, or the
// dashboard — never committed to this repo):
//   ADMIN_PASSWORD  - the /admin login password
//   GITHUB_TOKEN    - a GitHub token with Contents read/write on this repo
//
// Nothing else here is sensitive: repo owner/name/branch and the data paths
// are plain constants below.

const GITHUB_OWNER = 'merajmusic-hash';
const GITHUB_REPO = 'merajmirzaei-site';
const GITHUB_BRANCH = 'main';
// Both paths are repo-root-relative (for the GitHub Contents API) and live
// inside the static-assets directory, so they're also served publicly at
// /data/credits.json and /images/covers/<file> respectively.
const DATA_PATH = 'merajmirzaei-site (4)/data/credits.json';
// The homepage's "Selected artists" photo wall: an ordered list of
// artist_en names, each of which must also have entries in credits.json to
// actually render a tile (see credits-render.js's renderArtistWall).
const HOMEPAGE_PATH = 'merajmirzaei-site (4)/data/homepage.json';
const COVERS_DIR = 'merajmirzaei-site (4)/images/covers';
// The homepage "New Release" video player: an ordered playlist of
// {title_en, title_fa, youtube_url | video_url}, edited on the admin
// panel's "New Release" tab and played top to bottom on the homepage.
const NEW_RELEASES_PATH = 'merajmirzaei-site (4)/data/new-releases.json';
// Uploaded video files are too big for the repo itself (Cloudflare refuses
// to deploy any static asset over 25 MiB), so they're stored as assets of
// one GitHub release with this tag, and served to visitors through
// /media/<asset id>/<file name> by this Worker (see serveMedia below).
const MEDIA_RELEASE_TAG = 'site-media';
// The /gallery page's photos: an ordered list of {id, src, caption_en,
// caption_fa}, edited on the admin panel's "Gallery" tab and rendered into
// the page by applyEntitySeo (see buildGalleryHtml). Photos uploaded there
// live in GALLERY_DIR, which belongs to the gallery alone: saving the
// gallery removes any file in it that the saved list no longer uses.
const GALLERY_PATH = 'merajmirzaei-site (4)/data/gallery.json';
const GALLERY_DIR = 'merajmirzaei-site (4)/images/gallery';
// The song lyrics ("متن ترانه"): one pasted text per song, edited on the
// admin panel's "Lyrics" tab and published as that song's own /lyrics page
// (see tryServeLyricsPage). A list of {id, lyrics}, where id is the song's id
// in credits.json. Deliberately a file of its own: credits.json is downloaded
// by every visitor of the credits pages, and the lyrics would multiply its size.
const LYRICS_PATH = 'merajmirzaei-site (4)/data/lyrics.json';
const GITHUB_API = 'https://api.github.com';

const SESSION_COOKIE = 'mm_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ---------------------------------------------------------------------
// small crypto/encoding helpers
// ---------------------------------------------------------------------

function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    // still compare something of equal length so the failure path takes
    // roughly the same time as a real mismatch, rather than short-circuiting
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ (bb[i % bb.length] || 0);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signSession(env) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  const key = await hmacKey(env.ADMIN_PASSWORD);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${bufToBase64Url(sigBuf)}`;
}

async function verifySession(env, token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const key = await hmacKey(env.ADMIN_PASSWORD);
  const expectedSigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return timingSafeEqual(sig, bufToBase64Url(expectedSigBuf));
}

function parseCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function isAuthenticated(request, env) {
  const token = parseCookie(request, SESSION_COOKIE);
  return verifySession(env, token);
}

function sessionCookieHeader(value, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/admin',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ];
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------
// GitHub Contents API helpers
// ---------------------------------------------------------------------

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'merajmirzaei-site-admin',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGetFile(env, path) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function ghPutFile(env, path, contentBase64, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const body = {
    message,
    content: contentBase64,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `GitHub PUT ${path} failed: ${res.status}`);
    err.status = res.status;
    err.githubBody = json;
    throw err;
  }
  return json;
}

function base64FromUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ---------------------------------------------------------------------
// data validation (defense in depth — the admin UI already shapes this,
// but a corrupt or hostile payload must never get committed to the repo)
// ---------------------------------------------------------------------

const STRING_FIELDS = [
  'id', 'artist_en', 'artist_fa', 'title_en', 'title_fa', 'release_type',
  'album_name', 'year', 'label', 'cover_url', 'artist_image', 'spotify_artist_url',
  'status_musicbrainz', 'status_discogs', 'status_genius', 'notes', 'start_seconds',
];
const BOOL_FIELDS = ['role_arrangement', 'role_production', 'role_mix', 'role_mastering'];
const RELEASE_TYPES = new Set(['single', 'album track', 'album']);
const STATUS_VALUES = new Set(['not started', 'pending', 'done']);
const PAGE_VALUES = new Set(['credits', 'releases']);

function validateEntries(data) {
  if (!Array.isArray(data)) return 'data must be an array';
  if (data.length > 5000) return 'too many entries';
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    if (!e || typeof e !== 'object') return `entry ${i} is not an object`;
    for (const f of STRING_FIELDS) {
      if (e[f] != null && typeof e[f] !== 'string') return `entry ${i}: ${f} must be a string`;
    }
    for (const f of BOOL_FIELDS) {
      if (e[f] != null && typeof e[f] !== 'boolean') return `entry ${i}: ${f} must be a boolean`;
    }
    if (e.release_type && !RELEASE_TYPES.has(e.release_type)) return `entry ${i}: invalid release_type`;
    for (const f of ['status_musicbrainz', 'status_discogs', 'status_genius']) {
      if (e[f] && !STATUS_VALUES.has(e[f])) return `entry ${i}: invalid ${f}`;
    }
    if (e.order != null && typeof e.order !== 'number') return `entry ${i}: order must be a number`;
    if (e.pages != null) {
      if (!Array.isArray(e.pages)) return `entry ${i}: pages must be an array`;
      for (const p of e.pages) {
        if (typeof p !== 'string' || !PAGE_VALUES.has(p)) return `entry ${i}: invalid pages value "${p}"`;
      }
    }
    if (e.links != null) {
      if (!Array.isArray(e.links)) return `entry ${i}: links must be an array`;
      if (e.links.length > 50) return `entry ${i}: too many links`;
      for (const l of e.links) {
        if (!l || typeof l !== 'object') return `entry ${i}: bad link`;
        if (typeof l.label !== 'string' || typeof l.url !== 'string') return `entry ${i}: link must have label/url strings`;
        if (l.url && !/^https?:\/\//i.test(l.url)) return `entry ${i}: link url must be http(s)`;
      }
    }
  }
  return null;
}

const LYRICS_MAX_CHARS = 30000;

function validateLyrics(data) {
  if (!Array.isArray(data)) return 'data must be an array';
  if (data.length > 2000) return 'too many entries';
  const seen = new Set();
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    if (!e || typeof e !== 'object') return `entry ${i} is not an object`;
    if (typeof e.id !== 'string' || !e.id.trim() || e.id.length > 200) return `entry ${i}: id must be a non-empty string`;
    if (seen.has(e.id)) return `entry ${i}: duplicate id "${e.id}"`;
    seen.add(e.id);
    if (typeof e.lyrics !== 'string') return `entry ${i}: lyrics must be a string`;
    if (e.lyrics.length > LYRICS_MAX_CHARS) return `entry ${i}: lyrics too long (max ${LYRICS_MAX_CHARS} characters)`;
  }
  return null;
}

function validateHomepage(data) {
  if (!Array.isArray(data)) return 'data must be an array';
  if (data.length > 500) return 'too many entries';
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    if (!e || typeof e !== 'object') return `entry ${i} is not an object`;
    if (typeof e.artist_en !== 'string' || !e.artist_en.trim()) return `entry ${i}: artist_en must be a non-empty string`;
    if (e.order != null && typeof e.order !== 'number') return `entry ${i}: order must be a number`;
  }
  return null;
}

// ---------------------------------------------------------------------
// entity SEO: one canonical Person/MusicGroup identity, a per-page
// structured-data @graph, self-referencing canonicals, correct hreflang,
// and canonical (extensionless) internal links — all injected server-side
// via HTMLRewriter on the way out of env.ASSETS.fetch(). This replaces
// ~20 hand-duplicated, @id-less JSON-LD blocks (one static Person object
// per page, drifting independently) with one definition, so there is a
// single source of truth instead of a second SEO system living beside
// data/credits.json. That file is only ever read here (via the same
// public /data/credits.json the browser already fetches) — never written.
// ---------------------------------------------------------------------

const SITE_ORIGIN = 'https://merajmirzaei.com';
const PERSON_ID = SITE_ORIGIN + '/#person';
const MIRAGE_ID = SITE_ORIGIN + '/miragesohi#miragesohi';
const PORTRAIT_URL = SITE_ORIGIN + '/images/portrait.jpg';

// Same favicon set on every page, injected from this one place rather
// than hand-edited into 20 HTML files (and automatically covers every
// generated recording detail page too, since they all go through this
// same head-injection pipeline). apple-touch-icon.png is a full square
// on purpose — iOS applies its own corner mask, and a pre-rounded source
// image would risk a mismatched double edge under it.
const FAVICON_LINKS =
  '<link rel="icon" href="/favicon.ico" sizes="any">\n' +
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n' +
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">\n' +
  '<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">\n' +
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n';

// Verified profile URLs, unchanged from the site's existing (pre-this-task)
// JSON-LD — pulled from the already-vetted data already live on the site,
// not re-derived or guessed.
const PERSON_SAME_AS = [
  'https://musicbrainz.org/artist/5d52a3f9-f059-4c47-9f4e-0bdb61317fe3',
  'https://www.discogs.com/user/Merajmusic',
  'https://genius.com/merajmirzaei',
  'https://open.spotify.com/artist/3wHa2wASrgywhttuHleFl1',
  'https://youtube.com/@miragesohi',
  'https://www.instagram.com/merajmirzaei_music',
];
const MIRAGE_SAME_AS = [
  'https://open.spotify.com/artist/3wHa2wASrgywhttuHleFl1',
  'https://www.youtube.com/@Miragesohi',
  'https://www.instagram.com/merajmirzaei_music/',
];

// jobTitle/description per language — the English strings are exactly what
// was already live in every page's JSON-LD; the Farsi strings reuse the
// site's own already-published Farsi meta description (fa/index.html)
// rather than a fresh, unverified translation.
const PERSON_LOCALIZED = {
  en: {
    jobTitle: 'Music Producer and Mix & Mastering Engineer',
    description: 'Music producer, mix and mastering engineer and sound designer based in London, with over 20 years of work across Persian, electronic and international music.',
  },
  fa: {
    jobTitle: 'پرودیوسر و مهندس میکس و مستر',
    description: 'معراج میرزایی (Miragesohi) — پرودیوسر، مهندس میکس و مستر و ساند دیزاینر در لندن. بیش از ۲۰ سال کار در موسیقی ایرانی، الکترونیک و بین‌المللی.',
  },
};

function buildPersonNode(lang) {
  const loc = PERSON_LOCALIZED[lang];
  return {
    '@type': 'Person',
    '@id': PERSON_ID,
    name: 'Meraj Mirzaei',
    alternateName: ['معراج میرزایی', 'Miragesohi', 'MIRAGE'],
    jobTitle: loc.jobTitle,
    description: loc.description,
    url: SITE_ORIGIN + '/',
    image: PORTRAIT_URL,
    homeLocation: { '@type': 'Place', name: 'London, United Kingdom' },
    address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: 'United Kingdom' },
    knowsAbout: ['Audio mixing', 'Audio mastering', 'Music production', 'Sound design', 'Deep house', 'Persian pop music'],
    sameAs: PERSON_SAME_AS,
  };
}

function buildMirageNode() {
  return {
    '@type': 'MusicGroup',
    '@id': MIRAGE_ID,
    name: 'Miragesohi',
    alternateName: 'MIRAGE',
    genre: ['Deep house', 'Melodic electronic', 'Trap', 'Pop'],
    foundingDate: '2025',
    member: { '@id': PERSON_ID },
    sameAs: MIRAGE_SAME_AS,
  };
}

// Nav labels (visible on every page's <nav>) and the three journal posts'
// editorial copy, reused verbatim from what each page already carries —
// centralized here once instead of hand-duplicated per file.
const NAV_LABELS = {
  home: { en: 'Studio', fa: 'استودیو' },
  about: { en: 'About', fa: 'درباره من' },
  credits: { en: 'Credits', fa: 'کارنامه' },
  releases: { en: 'Releases', fa: 'ریلیزها' },
  miragesohi: { en: 'Miragesohi', fa: 'Miragesohi' },
  gallery: { en: 'Gallery', fa: 'گالری' },
  services: { en: 'Services', fa: 'خدمات' },
  collaborate: { en: 'Collaborate', fa: 'همکاری' },
  journal: { en: 'Journal', fa: 'یادداشت‌ها' },
};

const BLOG_POSTS = [
  {
    slug: 'mixing-persian-vocals',
    datePublished: '2026-08',
    en: { headline: 'Why Persian vocals need a different kind of mix', description: 'The voice sits differently in Persian music than it does in western pop. Mixing it the way a pop record is mixed usually makes it worse.' },
    fa: { headline: 'چرا وکال فارسی میکس متفاوتی می‌خواهد', description: 'جایگاه صدا در موسیقی ایرانی با پاپ غربی فرق دارد. اگر مثل یک کار پاپ میکسش کنی، معمولاً بدترش می‌کنی.' },
  },
  {
    slug: 'mastering-for-streaming',
    datePublished: '2026-07',
    en: { headline: 'Mastering for streaming, without chasing loudness', description: 'Every platform turns your master down to roughly the same level. Knowing that changes what a master should aim for.' },
    fa: { headline: 'مسترینگ برای استریم، بدون دویدن دنبال بلندی', description: 'هر پلتفرمی مستر تو را تا حدود یک سطح مشخص پایین می‌آورد. دانستن این موضوع هدف مسترینگ را عوض می‌کند.' },
  },
  {
    slug: 'traditional-instruments',
    datePublished: '2026-06',
    en: { headline: 'Putting tar, santur and ney into a modern production', description: 'Persian instruments were not designed for a dense mix. Most of the trouble comes from treating them like their western equivalents.' },
    fa: { headline: 'جا دادن تار، سنتور و نی در یک پروداکشن مدرن', description: 'سازهای ایرانی برای یک میکس شلوغ ساخته نشده‌اند. بیشتر دردسر از آنجا می‌آید که مثل معادل‌های غربی‌شان با آن‌ها رفتار می‌کنیم.' },
  },
];

// ---------------------------------------------------------------------
// URL model: every indexable page has exactly one canonical, extensionless
// form (Cloudflare's asset serving already 307s "/foo.html" -> "/foo" and
// "/fa" -> "/fa/", confirmed empirically against this project's own
// wrangler config) — pathFor()/parseSitePath() are the single definition
// of that mapping, shared by canonical tags, hreflang, JSON-LD urls, the
// language toggle and internal link rewriting below.
// ---------------------------------------------------------------------

function parseSitePath(pathname) {
  if (pathname === '/') return { lang: 'en', slug: 'home' };
  if (pathname === '/fa' || pathname === '/fa/') return { lang: 'fa', slug: 'home' };
  if (pathname.startsWith('/fa/')) {
    const rest = pathname.slice(4).replace(/\/$/, '');
    return { lang: 'fa', slug: rest || 'home' };
  }
  const rest = pathname.slice(1).replace(/\/$/, '');
  return { lang: 'en', slug: rest || 'home' };
}

function pathFor(lang, slug) {
  if (slug === 'home') return lang === 'fa' ? '/fa/' : '/';
  return (lang === 'fa' ? '/fa/' : '/') + slug;
}

function buildBreadcrumb(lang, slug) {
  const items = [{ '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') }];
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (post) {
    items.push({ '@type': 'ListItem', position: 2, name: NAV_LABELS.journal[lang], item: SITE_ORIGIN + pathFor(lang, 'journal') });
    items.push({ '@type': 'ListItem', position: 3, name: post[lang].headline, item: SITE_ORIGIN + pathFor(lang, slug) });
  } else if (slug !== 'home' && NAV_LABELS[slug]) {
    items.push({ '@type': 'ListItem', position: 2, name: NAV_LABELS[slug][lang], item: SITE_ORIGIN + pathFor(lang, slug) });
  } else {
    return null;
  }
  return { '@type': 'BreadcrumbList', itemListElement: items };
}

// Page-specific JSON-LD node per slug. Field values (headline/description/
// genre/foundingDate/areaServed/etc.) are copied from what each page's own
// static JSON-LD already carried — this only replaces each page's inline,
// duplicated Person/MusicGroup object with a {"@id": ...} reference to the
// single canonical node above, and (only where the old block had literally
// copy-pasted the English name into the Farsi page — gallery, journal,
// services) swaps in that page's own already-published Farsi <title> text
// so the structured data matches what's actually visible.
function buildPageNode(slug, lang) {
  switch (slug) {
    case 'home':
      return {
        '@type': 'ProfilePage',
        '@id': SITE_ORIGIN + pathFor(lang, 'home') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'home'),
        name: lang === 'fa' ? 'معراج میرزایی (Meraj Mirzaei) — پرودیوسر و مهندس میکس و مستر، لندن · Miragesohi' : 'Meraj Mirzaei (معراج میرزایی) — Producer & Mix/Mastering Engineer, London · Miragesohi',
        inLanguage: lang,
        mainEntity: { '@id': PERSON_ID },
      };
    case 'about':
      return {
        '@type': 'AboutPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'about') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'about'),
        name: lang === 'fa' ? 'درباره من — معراج میرزایی، لندن' : 'About — Meraj Mirzaei, Producer & Mix/Mastering Engineer, London',
        inLanguage: lang,
        mainEntity: { '@id': PERSON_ID },
      };
    case 'credits':
      return {
        '@type': 'CollectionPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'credits') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'credits'),
        name: lang === 'fa' ? 'کارنامه — معراج میرزایی | پرودیوسر و مهندس میکس و مستر' : 'Credits — Meraj Mirzaei | Producer & Mix/Mastering Engineer',
        inLanguage: lang,
        about: { '@id': PERSON_ID },
      };
    case 'releases':
      return {
        '@type': 'CollectionPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'releases') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'releases'),
        name: lang === 'fa' ? 'ریلیزهای جدید — Miragesohi | معراج میرزایی' : 'New Releases — Miragesohi | Meraj Mirzaei',
        inLanguage: lang,
        about: { '@id': MIRAGE_ID },
      };
    case 'miragesohi':
      return buildMirageNode();
    case 'gallery':
      return {
        '@type': 'ImageGallery',
        name: lang === 'fa' ? 'گالری — معراج میرزایی' : 'Gallery — Meraj Mirzaei',
        author: { '@id': PERSON_ID },
      };
    case 'services':
      return {
        '@type': 'ProfessionalService',
        name: lang === 'fa' ? 'خدمات میکس و مسترینگ — معراج میرزایی، لندن' : 'Meraj Mirzaei — Mixing and Mastering',
        areaServed: 'Worldwide',
        provider: { '@id': PERSON_ID },
        address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: 'GB' },
      };
    case 'collaborate':
      return {
        '@type': 'ContactPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'collaborate') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'collaborate'),
        name: lang === 'fa' ? 'همکاری با من — معراج میرزایی' : 'Collaborate — Meraj Mirzaei',
        inLanguage: lang,
        about: { '@id': PERSON_ID },
      };
    case 'journal':
      return {
        '@type': 'Blog',
        name: lang === 'fa' ? 'یادداشت‌ها — معراج میرزایی' : 'Meraj Mirzaei — Journal',
        author: { '@id': PERSON_ID },
        blogPost: BLOG_POSTS.map((p) => ({
          '@type': 'BlogPosting',
          headline: p[lang].headline,
          description: p[lang].description,
          datePublished: p.datePublished,
          url: SITE_ORIGIN + pathFor(lang, p.slug),
        })),
      };
    default: {
      const post = BLOG_POSTS.find((p) => p.slug === slug);
      if (!post) return null;
      return {
        '@type': 'BlogPosting',
        headline: post[lang].headline,
        description: post[lang].description,
        datePublished: post.datePublished,
        inLanguage: lang,
        author: { '@id': PERSON_ID },
        publisher: { '@id': PERSON_ID },
        mainEntityOfPage: SITE_ORIGIN + pathFor(lang, slug),
      };
    }
  }
}

// ---------------------------------------------------------------------
// live recordings graph — read (never write) data/credits.json via the
// same public /data/credits.json the browser fetches, so credits/releases
// pages' structured data is generated from whatever is currently live
// (including anything edited through /admin) instead of a static snapshot
// that drifts out of sync with it.
// ---------------------------------------------------------------------

// Matches credits-render.js's own ROLE_ORDER/ROLE_LABELS, but spelled out
// as full job titles (credits-render.js's on-page badges are deliberately
// short, e.g. "Mix"/"Master") — kept in sync by hand since both files must
// describe the exact same role flags.
const ROLE_ORDER = ['role_arrangement', 'role_production', 'role_mix', 'role_mastering'];
const ROLE_NAME_LABELS = {
  en: { role_arrangement: 'Arrangement', role_production: 'Production', role_mix: 'Mixing Engineer', role_mastering: 'Mastering Engineer' },
  fa: { role_arrangement: 'تنظیم', role_production: 'پروداکشن', role_mix: 'میکس', role_mastering: 'مسترینگ' },
};

function roleNameFor(entry, lang) {
  const labels = ROLE_NAME_LABELS[lang];
  return ROLE_ORDER.filter((f) => entry[f]).map((f) => labels[f]).join(', ');
}

// Same URL-shape patterns credits-render.js uses to find each kind of link
// on an entry — matched by URL, never by the admin-entered label, so
// renaming a label never breaks this. Only a verified, playable/watchable
// link becomes a recording's sameAs or an outbound button; never a
// guessed URL.
const RE_SPOTIFY_PLAYABLE = /open\.spotify\.com\/(album|track)\/([A-Za-z0-9]+)/i;
const RE_SPOTIFY_ARTIST = /open\.spotify\.com\/artist\//i;
const RE_YOUTUBE_WATCH = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
const RE_YOUTUBE_CHANNEL = /youtube\.com\/(@|channel\/)/i;

function findLink(links, re) {
  if (!Array.isArray(links)) return null;
  return links.find((l) => l && typeof l.url === 'string' && re.test(l.url)) || null;
}

function verifiedSameAs(entry) {
  const hit = findLink(entry.links, RE_SPOTIFY_PLAYABLE);
  return hit ? hit.url : null;
}

// Links that are not the artist-profile link, the page-level YouTube
// channel link, or the playable Spotify/YouTube source — e.g. a Telegram
// download — rendered as plain outbound buttons on the recording page,
// exactly mirroring credits-render.js's extraLinks().
function extraLinksFor(entry) {
  const links = Array.isArray(entry.links) ? entry.links : [];
  return links.filter((l) => {
    if (!l || !l.url) return false;
    if (RE_SPOTIFY_ARTIST.test(l.url)) return false;
    if (RE_SPOTIFY_PLAYABLE.test(l.url)) return false;
    if (RE_YOUTUBE_WATCH.test(l.url)) return false;
    if (RE_YOUTUBE_CHANNEL.test(l.url)) return false;
    return true;
  });
}

// A friendly platform name for an extra link's hostname, used when the
// admin never filled in a label — e.g. "ahangify.com" -> "Ahangify" — so
// the button never falls back to showing the raw URL as its own text.
const KNOWN_EXTRA_LINK_PLATFORMS = {
  'ahangify.com': 'Ahangify',
  'soundcloud.com': 'SoundCloud',
  'rj.app': 'Radio Javan',
  'radiojavan.com': 'Radio Javan',
  't.me': 'Telegram',
};

function platformNameForUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return null;
  }
  if (KNOWN_EXTRA_LINK_PLATFORMS[host]) return KNOWN_EXTRA_LINK_PLATFORMS[host];
  const base = host.split('.')[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
}

function extraLinkLabel(l, lang) {
  if (l.label && String(l.label).trim()) return l.label;
  const platform = platformNameForUrl(l.url);
  if (!platform) return lang === 'fa' ? 'شنیدن' : 'Listen';
  return (lang === 'fa' ? 'شنیدن در ' : 'Listen on ') + platform;
}

// data/credits.json's cover_url has occasionally been filled in (via
// /admin, by hand) with a link to a Spotify/streaming page or a
// third-party site rather than an actual image file — those are not
// broken as *links*, but they are not usable as an <img src> or an
// og:image, so treat only something that looks like a real image URL as
// a verified cover: a relative /images/... path (always a real upload)
// or any URL ending in a common image extension.
function isLikelyImageUrl(url) {
  return typeof url === 'string' && /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(url);
}

// Absolute already (some entries' cover_url is a full external image
// URL) vs. site-relative (the normal /images/covers/... case) — never
// blindly concatenate the two, which produced a malformed
// "https://merajmirzaei.comhttps://..." URL for the external case.
function absoluteCoverUrl(url) {
  return /^https?:\/\//i.test(url) ? url : SITE_ORIGIN + url;
}

function slugifyName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function readCreditsReadOnly(env) {
  try {
    const res = await env.ASSETS.fetch(new Request('https://internal/data/credits.json'));
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

// data/song-stories.json — a separate, hand-written "about this track"
// blurb per recording, matched to a credits.json entry by title+artist
// rather than by id (the two files were produced independently, so there
// is no shared key). Read-only, same pattern as credits.json.
async function readStoriesReadOnly(env) {
  try {
    const res = await env.ASSETS.fetch(new Request('https://internal/data/song-stories.json'));
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

// Tolerant text match for matching a story to its credits entry: trims,
// unifies the Arabic vs. Persian forms of "ک"/"ی" and strips ZWNJ/tatweel
// (common, cosmetic spelling differences between two independently
// authored files), collapses whitespace, and case-folds. Confirmed
// against the live data before writing this: 91/91 stories match exactly
// one credits entry each, with no ambiguity in either direction.
function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/ك/g, 'ک')
    .replace(/ي/g, 'ی')
    .replace(/‌/g, ' ') // ZWNJ
    .replace(/ـ/g, '') // tatweel
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// A story or a credits entry is identified by any (title, artist) pair
// drawn from its own EN/FA fields — song-stories.json's own "artist_en"
// field is actually Farsi text for every non-MIRAGE entry (an upstream
// quirk in how that file was produced), so matching only works by
// checking all four title×artist combinations rather than assuming
// title_en pairs with artist_en.
function matchKeysForRecord(rec) {
  const keys = new Set();
  const titles = [rec.title_en, rec.title_fa].filter(Boolean);
  const artists = [rec.artist_en, rec.artist_fa].filter(Boolean);
  for (const t of titles) {
    for (const a of artists) {
      keys.add(normalizeForMatch(t) + '\u0001' + normalizeForMatch(a));
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

// ---------------------------------------------------------------------
// lyrics — data/lyrics.json, a list of {id, lyrics} keyed by the song's id
// in credits.json (see LYRICS_PATH). A song with lyrics gets its own page at
// /credits/<id>/lyrics (or /releases/<id>/lyrics, and the /fa/ twins), a
// "Lyrics" button on its main page, a link on its artist's page and a
// sitemap entry. A song without lyrics gets none of these — no empty,
// thin pages.
// ---------------------------------------------------------------------

// Tidies what was pasted into the admin box, for display only (the stored
// text stays exactly as pasted): one newline style, no BOM / zero-width
// space, no trailing spaces, at most one blank line between stanzas, and the
// Arabic forms of ك / ي turned into the Persian ک / ی — the keyboard
// layouts and websites lyrics get copied from mix them up, and a Persian
// search for the title would otherwise miss the page. (ZWNJ is kept: it is
// part of Persian spelling.)
function cleanLyricsText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[﻿​]/g, '')
    .replace(/ك/g, 'ک')
    .replace(/ي/g, 'ی')
    .split('\n').map((line) => line.replace(/^[ \t ]+|[ \t ]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// song id (slugified, like every recording URL) -> cleaned lyrics text.
// Empty map when the file is missing or unreadable, so a problem here can
// only ever remove the lyrics features, never break a page.
async function readLyricsReadOnly(env) {
  const map = new Map();
  try {
    const res = await env.ASSETS.fetch(new Request('https://internal/data/lyrics.json'));
    if (!res.ok) return map;
    const data = await res.json();
    if (!Array.isArray(data)) return map;
    for (const row of data) {
      if (!row || typeof row.id !== 'string' || typeof row.lyrics !== 'string') continue;
      const text = cleanLyricsText(row.lyrics);
      if (text) map.set(slugifyName(row.id), text);
    }
  } catch (e) {
    // fall through with whatever was read
  }
  return map;
}

function lyricsFor(lyricsMap, entry) {
  return (lyricsMap && lyricsMap.get(slugifyName(entry.id))) || null;
}

// Stanzas are separated by a blank line; lines within one by a line break.
function lyricsStanzas(text) {
  return String(text).split(/\n{2,}/)
    .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length);
}

// Each stanza is its own <p dir="auto"> (so a line that starts in Persian
// reads right-to-left even on an English page, and a stray English line
// inside Persian lyrics does not flip the stanza).
function renderLyricsHtml(text) {
  return lyricsStanzas(text)
    .map((lines) => '<p dir="auto">' + lines.map((l) => escapeHtmlAttr(l)).join('<br>') + '</p>')
    .join('');
}

// 'fa' when most of the letters are Arabic-script (Persian), else 'en'.
function lyricsLang(text) {
  const arabic = (String(text).match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) || []).length;
  const latin = (String(text).match(/[A-Za-z]/g) || []).length;
  return arabic > latin ? 'fa' : 'en';
}

function lyricsFirstLine(text, max) {
  const first = String(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}

// The hub a song's own pages live under: credits if it is on the credits
// page, otherwise releases (an entry may be on either or both).
function primaryHubFor(entry) {
  return Array.isArray(entry.pages) && entry.pages.includes('credits') ? 'credits' : 'releases';
}

// Builds one MusicRecording/MusicAlbum node, reusing a stable per-artist
// @id (and the single canonical MIRAGE node) instead of a fresh anonymous
// artist object every time. Shared by the hub pages' full recordings
// @graph and by a single recording's own detail page, so both always
// describe an entry identically. Returns null when there is no verified
// title on this language (credits-render.js's own "hasTitle" check — shown
// on-page as "Pending") — there is nothing verified yet to publish.
function buildOneRecordingNode(entry, lang) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  if (!title) return null;

  let byArtistRef = null;
  let artistNode = null;
  let usesMirage = false;
  if (entry.artist_en === 'Miragesohi') {
    usesMirage = true;
    byArtistRef = { '@id': MIRAGE_ID };
  } else if (entry.artist_en) {
    const artistId = SITE_ORIGIN + '/credits#artist-' + slugifyName(entry.artist_en);
    byArtistRef = { '@id': artistId };
    artistNode = { '@type': 'MusicGroup', '@id': artistId, name: entry.artist_en };
    if (entry.artist_fa) artistNode.alternateName = entry.artist_fa;
    if (entry.spotify_artist_url) artistNode.sameAs = entry.spotify_artist_url;
  }

  const altTitle = lang === 'fa' ? entry.title_en : entry.title_fa;
  const roleName = roleNameFor(entry, lang);
  const node = { '@type': entry.release_type === 'album' ? 'MusicAlbum' : 'MusicRecording', name: title };
  if (altTitle) node.alternateName = altTitle;
  if (byArtistRef) node.byArtist = byArtistRef;
  // "Role" wraps the reference so roleName qualifies THIS recording's
  // credit only — it must never be written directly onto the {"@id":
  // PERSON_ID} object itself, which would incorrectly merge a
  // per-recording role into the canonical Person's global properties.
  if (roleName) node.contributor = { '@type': 'Role', roleName, contributor: { '@id': PERSON_ID } };
  if (entry.album_name) node.inAlbum = { '@type': 'MusicAlbum', name: entry.album_name };
  if (entry.year) node.datePublished = String(entry.year);
  const sameAs = verifiedSameAs(entry);
  if (sameAs) node.sameAs = sameAs;

  return { node, artistNode, usesMirage };
}

// Builds MusicRecording/MusicAlbum nodes for one hub page ('credits' or
// 'releases'), deduplicating artist nodes across the whole list.
function buildRecordingsGraph(creditsData, pageFilter, lang) {
  const entries = creditsData
    .filter((e) => Array.isArray(e.pages) && e.pages.includes(pageFilter))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const artistNodes = new Map();
  const recordingNodes = [];
  let usesMirage = false;

  for (const entry of entries) {
    const result = buildOneRecordingNode(entry, lang);
    if (!result) continue;
    if (result.usesMirage) usesMirage = true;
    if (result.artistNode && !artistNodes.has(result.artistNode['@id'])) {
      artistNodes.set(result.artistNode['@id'], result.artistNode);
    }
    recordingNodes.push(result.node);
  }

  return { nodes: [...artistNodes.values(), ...recordingNodes], usesMirage };
}

// ---------------------------------------------------------------------
// individual recording pages (plan section 4) — one indexable, canonical
// page per titled recording, at /credits/<slug> or /releases/<slug> (and
// the /fa/ equivalents), generated from data/credits.json at request time.
// The slug is the entry's own `id` field: already unique, already stable
// (set once when the entry is created and never recomputed from title/
// artist text), so editing a title later never changes the URL.
// ---------------------------------------------------------------------

function findEntryBySlug(creditsData, hub, recordingSlug) {
  return creditsData.find((e) => {
    if (!Array.isArray(e.pages) || !e.pages.includes(hub)) return false;
    if (!(e.title_en || e.title_fa)) return false;
    return slugifyName(e.id) === recordingSlug;
  }) || null;
}

// Every titled entry that belongs to a given hub, in the same order the
// hub page itself lists them — the one list both the hub's permalinks and
// the sitemap are built from, so neither can drift from the other.
function titledEntriesFor(creditsData, hub) {
  return creditsData
    .filter((e) => Array.isArray(e.pages) && e.pages.includes(hub) && (e.title_en || e.title_fa))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function parseRecordingSlug(slug) {
  const m = /^(credits|releases)\/([a-z0-9-]+)$/.exec(slug);
  return m ? { hub: m[1], recordingSlug: m[2] } : null;
}

function parseArtistSlug(slug) {
  const m = /^credits\/artist\/([a-z0-9-]+)$/.exec(slug);
  return m ? { artistSlug: m[1] } : null;
}

function parseStorySlug(slug) {
  const m = /^(credits|releases)\/([a-z0-9-]+)\/about$/.exec(slug);
  return m ? { hub: m[1], recordingSlug: m[2] } : null;
}

function parseLyricsSlug(slug) {
  const m = /^(credits|releases)\/([a-z0-9-]+)\/lyrics$/.exec(slug);
  return m ? { hub: m[1], recordingSlug: m[2] } : null;
}

// Every titled credits-page entry for one artist, in hub order — the
// source both the per-artist page and the artist's @id in the
// entity-SEO graph are built from.
function findArtistEntries(creditsData, artistSlug) {
  return creditsData
    .filter((e) => {
      if (!Array.isArray(e.pages) || !e.pages.includes('credits')) return false;
      if (!(e.title_en || e.title_fa)) return false;
      return !!e.artist_en && slugifyName(e.artist_en) === artistSlug;
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

const RELEASE_TYPE_LABELS = {
  en: { single: 'Single', 'album track': 'Album track', album: 'Album' },
  fa: { single: 'تک‌آهنگ', 'album track': 'ترک آلبوم', album: 'آلبوم' },
};

const RECORDING_LABELS = {
  en: { listenSpotify: 'Listen on Spotify', watchYoutube: 'Watch on YouTube', partOf: 'From the release', year: 'Year', home: 'Studio home', artistSpotify: 'Artist on Spotify', aboutTrack: 'About this track', backToTrack: 'Back to track', lyrics: 'Lyrics' },
  fa: { listenSpotify: 'شنیدن در اسپاتیفای', watchYoutube: 'تماشا در یوتیوب', partOf: 'بخشی از', year: 'سال', home: 'صفحه اصلی استودیو', artistSpotify: 'صفحه هنرمند در اسپاتیفای', aboutTrack: 'درباره این قطعه', backToTrack: 'بازگشت به قطعه', lyrics: 'متن ترانه' },
};

function buildRecordingTitleText(entry, lang) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  const artist = lang === 'fa' ? (entry.artist_fa || entry.artist_en) : (entry.artist_en || entry.artist_fa);
  return lang === 'fa' ? `${title} — ${artist} | معراج میرزایی` : `${title} — ${artist} | Meraj Mirzaei`;
}

function buildRecordingDescriptionText(entry, lang) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  const artist = lang === 'fa' ? (entry.artist_fa || entry.artist_en) : (entry.artist_en || entry.artist_fa);
  const roleName = roleNameFor(entry, lang);
  const yearPart = entry.year ? ` (${entry.year})` : '';
  if (lang === 'fa') {
    return roleName
      ? `«${title}» از ${artist}${yearPart} — نقش معراج میرزایی: ${roleName}.`
      : `«${title}» از ${artist}${yearPart} — از کارنامه معراج میرزایی، پرودیوسر و مهندس میکس و مستر.`;
  }
  return roleName
    ? `"${title}" by ${artist}${yearPart} — Meraj Mirzaei's credit: ${roleName}.`
    : `"${title}" by ${artist}${yearPart} — from the credits of Meraj Mirzaei, producer and mix & mastering engineer.`;
}

// Escapes `text`, but wraps any occurrence of `foreignName` in <bdi>
// first — isolating it from the surrounding paragraph's base direction.
// Without this, an RTL name (a Farsi artist name) embedded in an LTR
// English sentence gets visually reordered by the browser's bidi
// algorithm relative to adjacent punctuation/numbers — e.g. the source
// text "by گوگوش (2022)" was rendering on screen as "by (2022) گوگوش".
// That's a real, confirmed rendering bug, not a text bug: the
// underlying string is exactly what's in the data; only its unisolated
// on-screen layout was wrong.
function escapeWithBdiIsolation(text, foreignName) {
  const s = String(text == null ? '' : text);
  if (!foreignName || !s.includes(foreignName)) return escapeHtmlAttr(s);
  return s.split(foreignName).map((part) => escapeHtmlAttr(part)).join('<bdi>' + escapeHtmlAttr(foreignName) + '</bdi>');
}

// Builds the <main> replacement for one recording's detail page. Reuses
// the exact same CSS classes the hub pages already define for a track
// card/player (.tc-cover/.tc-img/.tc-roles/.tc-role/.player/.ytwrap) and
// the shared article/button classes every blog post already uses
// (.article/.atitle/.stand/.hr/.linkrow/.btn) — no new visual component,
// only plain inline layout glue where two of those existing pieces sit
// side by side.
// The always-visible Spotify / YouTube players of a recording — shared by
// the recording's own page and its lyrics page (read the words while it
// plays). Only a verified, playable link ever becomes an embed.
function recordingEmbeds(entry, title) {
  const sp = verifiedSameAs(entry) ? findLink(entry.links, RE_SPOTIFY_PLAYABLE) : null;
  const spMatch = sp ? sp.url.match(RE_SPOTIFY_PLAYABLE) : null;
  const spotifyEmbed = spMatch
    ? `<div class="player" style="margin-bottom:18px"><iframe src="https://open.spotify.com/embed/${spMatch[1].toLowerCase()}/${spMatch[2]}?utm_source=generator&theme=0" width="100%" height="152" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture" loading="lazy" title="${escapeHtmlAttr(title)}"></iframe></div>`
    : '';

  const ytLink = findLink(entry.links, RE_YOUTUBE_WATCH);
  const ytMatch = ytLink ? ytLink.url.match(RE_YOUTUBE_WATCH) : null;
  const youtubeEmbed = ytMatch
    ? `<div class="ytwrap" style="margin-bottom:18px"><iframe src="https://www.youtube.com/embed/${ytMatch[1]}?rel=0" title="${escapeHtmlAttr(title)}" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`
    : '';
  return { sp, ytLink, spotifyEmbed, youtubeEmbed };
}

function renderRecordingDetailContent(entry, lang, hub, story, hasLyrics) {
  const L = RECORDING_LABELS[lang];
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  const titleAlt = lang === 'fa' ? entry.title_en : entry.title_fa;
  const artist = lang === 'fa' ? (entry.artist_fa || entry.artist_en) : (entry.artist_en || entry.artist_fa);
  const artistAlt = lang === 'fa' ? entry.artist_en : entry.artist_fa;
  const releaseTypeLabel = entry.release_type ? RELEASE_TYPE_LABELS[lang][entry.release_type] : '';

  const eyebrowParts = [artist, entry.year, releaseTypeLabel].filter(Boolean);
  const eyebrow = escapeHtmlAttr(eyebrowParts.join(' · '));

  // The artist name links to their own per-artist page — every other
  // track of theirs credited to Meraj Mirzaei — rather than out to
  // Spotify; that external link (when verified) is offered separately,
  // below, as its own button instead. Miragesohi has no per-artist page of
  // its own (that's what /miragesohi already is), so on releases its name
  // stays plain text.
  const artistPageHref = hub === 'credits' && entry.artist_en && entry.artist_en !== 'Miragesohi'
    ? pathFor(lang, 'credits/artist/' + slugifyName(entry.artist_en))
    : null;
  const artistLink = findLink(entry.links, RE_SPOTIFY_ARTIST);
  const artistHtml = artistPageHref
    ? `<a href="${escapeHtmlAttr(artistPageHref)}">${escapeHtmlAttr(artist)}</a>`
    : escapeHtmlAttr(artist);
  const artistLine = `<p>${artistHtml}${artistAlt ? ' — ' + escapeHtmlAttr(artistAlt) : ''}</p>`;

  const albumLine = entry.album_name ? `<p>${escapeHtmlAttr(L.partOf)}: ${escapeHtmlAttr(entry.album_name)}</p>` : '';
  const yearLine = entry.year ? `<p>${escapeHtmlAttr(L.year)}: ${escapeHtmlAttr(String(entry.year))}</p>` : '';

  const roleBadges = ROLE_ORDER.filter((f) => entry[f])
    .map((f) => `<span class="tc-role">${escapeHtmlAttr(ROLE_NAME_LABELS[lang][f])}</span>`)
    .join('');
  const rolesBlock = roleBadges ? `<div class="tc-roles" style="justify-content:flex-start;margin-top:10px">${roleBadges}</div>` : '';

  const coverBlock = isLikelyImageUrl(entry.cover_url)
    ? `<div class="tc-cover" style="width:180px;height:180px;flex:none"><img class="tc-img" src="${escapeHtmlAttr(entry.cover_url)}" alt="" loading="lazy"></div>`
    : '';

  const { sp, ytLink, spotifyEmbed, youtubeEmbed } = recordingEmbeds(entry, title);

  // "About this track" now lives on its own page (/credits/<slug>/about)
  // rather than inline here — this button is the only trace of it on the
  // track's main page. Only shown when a story actually exists for this
  // language; no button to a page that would have nothing on it.
  const storyText = story ? (lang === 'fa' ? story.story_fa : story.story_en) : null;
  const hasStory = !!(storyText && String(storyText).trim());
  const aboutHref = hasStory ? pathFor(lang, hub + '/' + slugifyName(entry.id) + '/about') : null;

  const linkButtons = [];
  if (sp) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(sp.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(L.listenSpotify)}</a>`);
  if (ytLink) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(ytLink.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(L.watchYoutube)}</a>`);
  if (artistLink) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(artistLink.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(L.artistSpotify)}</a>`);
  for (const l of extraLinksFor(entry)) {
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(extraLinkLabel(l, lang))}</a>`);
  }
  if (hasLyrics) {
    const lyricsHref = pathFor(lang, hub + '/' + slugifyName(entry.id) + '/lyrics');
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(lyricsHref)}">${escapeHtmlAttr(L.lyrics)}</a>`);
  }
  if (aboutHref) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(aboutHref)}">${escapeHtmlAttr(L.aboutTrack)}</a>`);
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, hub))}">${escapeHtmlAttr((lang === 'fa' ? 'بازگشت به ' : 'Back to ') + NAV_LABELS[hub][lang])}</a>`);
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, 'home'))}">${escapeHtmlAttr(L.home)}</a>`);

  return '<main class="wrap article">'
    + `<p class="eyebrow" style="margin-bottom:14px">${eyebrow}</p>`
    + `<h1 class="atitle">${escapeHtmlAttr(title)}</h1>`
    + (titleAlt ? `<p class="stand">${escapeHtmlAttr(titleAlt)}</p>` : '')
    + '<div class="hr"></div>'
    + `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin:0 0 28px">`
    + coverBlock
    + `<div style="flex:1;min-width:240px">${artistLine}${albumLine}${yearLine}${rolesBlock}</div>`
    + '</div>'
    + spotifyEmbed
    + youtubeEmbed
    + `<div class="linkrow" style="margin-top:10px">${linkButtons.join('')}</div>`
    + '</main>';
}

// ---------------------------------------------------------------------
// the story page itself — /credits/<slug>/about (and /fa/, /releases/
// equivalents). One page, one job: the "About this track" text, with a
// way back to the track's own page.
// ---------------------------------------------------------------------

function buildStoryTitleText(entry, lang) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  return lang === 'fa'
    ? `درباره «${title}» | معراج میرزایی`
    : `About "${title}" | Meraj Mirzaei`;
}

function buildStoryDescriptionText(storyText) {
  const s = String(storyText || '').trim();
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

function buildStoryPageContent(entry, lang, hub, storyText) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  const artist = lang === 'fa' ? (entry.artist_fa || entry.artist_en) : (entry.artist_en || entry.artist_fa);
  const storyForeignName = lang === 'fa' ? entry.artist_en : entry.artist_fa;
  const trackHref = pathFor(lang, hub + '/' + slugifyName(entry.id));

  const linkButtons = [
    `<a class="btn" href="${escapeHtmlAttr(trackHref)}">${escapeHtmlAttr(RECORDING_LABELS[lang].backToTrack)}</a>`,
    `<a class="btn" href="${escapeHtmlAttr(pathFor(lang, hub))}">${escapeHtmlAttr((lang === 'fa' ? 'بازگشت به ' : 'Back to ') + NAV_LABELS[hub][lang])}</a>`,
  ];

  // The source notes are multi-paragraph (one paragraph per line); render
  // each on its own <p> rather than collapsing them into one block, so the
  // original paragraph breaks survive into the HTML.
  const storyParagraphs = String(storyText)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeWithBdiIsolation(p, storyForeignName)}</p>`)
    .join('');

  return '<main class="wrap article">'
    + `<p class="eyebrow" style="margin-bottom:14px"><a href="${escapeHtmlAttr(trackHref)}">${escapeHtmlAttr(title)}</a> — ${escapeHtmlAttr(artist)}</p>`
    + `<h1 class="atitle">${escapeHtmlAttr(RECORDING_LABELS[lang].aboutTrack)}</h1>`
    + '<div class="hr"></div>'
    + storyParagraphs
    + `<div class="linkrow" style="margin-top:28px">${linkButtons.join('')}</div>`
    + '</main>';
}

// ---------------------------------------------------------------------
// the lyrics page — /credits/<slug>/lyrics (and /fa/, /releases/
// equivalents). One page, one job: the full lyrics of one song, written to
// be found by the searches people actually make ("متن آهنگ <title>",
// "<title> lyrics", "<artist> <title>"): the title, the artist and both
// spellings of each (Persian and English) appear in the <title>, the
// description, the headings and the text, once each, plus the song's
// player, links back to the song / artist / credits pages, and links to the
// same artist's other lyrics.
// ---------------------------------------------------------------------

const LYRICS_PAGE_LABELS = {
  en: {
    moreBy: 'More lyrics by',
    moreByArtist: 'More by',
    note: 'The lyrics are shown for reference. All rights belong to the lyricist and the rights holders.',
    moreLyricsSuffix: ' lyrics',
  },
  fa: {
    moreBy: 'ترانه‌های دیگر از',
    moreByArtist: 'آثار دیگر',
    note: 'این ترانه برای مرجع نمایش داده می‌شود. همهٔ حقوق آن متعلق به ترانه‌سرا و صاحبان اثر است.',
    moreLyricsSuffix: '',
  },
};

const LYRICS_ROLE_NOUNS = {
  en: { role_arrangement: 'arrangement', role_production: 'production', role_mix: 'mixing', role_mastering: 'mastering' },
  fa: { role_arrangement: 'تنظیم', role_production: 'پروداکشن', role_mix: 'میکس', role_mastering: 'مسترینگ' },
};

// "a", "a and b", "a, b and c" — and the Persian "a، b و c".
function joinNatural(list, lang) {
  const and = lang === 'fa' ? ' و ' : ' and ';
  const comma = lang === 'fa' ? '، ' : ', ';
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(comma) + and + list[list.length - 1];
}

function lyricsNames(entry, lang) {
  const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
  const titleAlt = lang === 'fa' ? entry.title_en : entry.title_fa;
  const artist = lang === 'fa' ? (entry.artist_fa || entry.artist_en) : (entry.artist_en || entry.artist_fa);
  const artistAlt = lang === 'fa' ? entry.artist_en : entry.artist_fa;
  return { title, titleAlt: titleAlt && titleAlt !== title ? titleAlt : '', artist, artistAlt: artistAlt && artistAlt !== artist ? artistAlt : '' };
}

// "Mixing and mastering by Meraj Mirzaei." / «میکس و مسترینگ این اثر کار معراج میرزایی است.»
function lyricsRoleSentence(entry, lang, withBdi) {
  const nouns = ROLE_ORDER.filter((f) => entry[f]).map((f) => LYRICS_ROLE_NOUNS[lang][f]);
  const miragesohiTag = entry.artist_en === 'Miragesohi' ? '' : ' (Miragesohi)';
  const nameHtml = withBdi
    ? '<bdi>' + (lang === 'fa' ? 'معراج میرزایی' : 'Meraj Mirzaei') + '</bdi>' + (miragesohiTag ? ' (<bdi>Miragesohi</bdi>)' : '')
    : (lang === 'fa' ? 'معراج میرزایی' : 'Meraj Mirzaei') + miragesohiTag;
  if (!nouns.length) {
    return lang === 'fa'
      ? `از کارنامهٔ ${nameHtml}، پرودیوسر و مهندس میکس و مستر.`
      : `From the credits of ${nameHtml}, producer and mix & mastering engineer.`;
  }
  const list = joinNatural(nouns, lang);
  if (lang === 'fa') return `${list} این اثر کار ${nameHtml} است.`;
  return `${list.charAt(0).toUpperCase() + list.slice(1)} by ${nameHtml}.`;
}

function buildLyricsTitleText(entry, lang) {
  const { title, artist } = lyricsNames(entry, lang);
  return lang === 'fa'
    ? `متن آهنگ ${title} از ${artist} | معراج میرزایی`
    : `${title} Lyrics — ${artist} | Meraj Mirzaei`;
}

function buildLyricsDescriptionText(entry, lang, text) {
  const { title, artist } = lyricsNames(entry, lang);
  const first = lyricsFirstLine(text, 70);
  const yearPart = entry.year ? ` (${entry.year})` : '';
  const roleText = lyricsRoleSentence(entry, lang, false);
  return lang === 'fa'
    ? `متن کامل ترانهٔ «${title}» با صدای ${artist}${yearPart}: «${first}» — ${roleText}`
    : `Full lyrics of "${title}" by ${artist}${yearPart}: "${first}" — ${roleText}`;
}

// Other songs with lyrics by the same artist (never the song itself), in
// credits order — the internal links that carry a visitor (and a crawler)
// from one lyrics page to the next.
function otherLyricsByArtist(creditsData, lyricsMap, entry) {
  if (!entry.artist_en) return [];
  return creditsData
    .filter((e) => e !== entry
      && e.id !== entry.id
      && e.artist_en === entry.artist_en
      && Array.isArray(e.pages)
      && (e.title_en || e.title_fa)
      && lyricsFor(lyricsMap, e))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(0, 12);
}

const LYRICS_PAGE_CSS = '<style>'
  + '.lyr-h2{font-family:var(--display);font-weight:800;font-size:22px;line-height:1.5;margin:40px 0 14px;color:var(--text)}'
  + 'body.fa .lyr-h2{font-family:var(--fa)}'
  + '.lyr-text{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:24px 26px}'
  + '.lyr-text p{font-size:18.5px;line-height:2.1;color:var(--text);margin:0 0 26px;max-width:none}'
  + '.lyr-text p:last-child{margin-bottom:0}'
  + '.lyr-text[lang="fa"]{direction:rtl}'
  + '.lyr-text[lang="fa"] p{font-family:var(--fa)}'
  + '.lyr-note{font-size:13px;color:var(--muted);margin:14px 0 0}'
  + '@media(max-width:760px){.article{padding-left:var(--pad);padding-right:var(--pad)}}'
  + '@media(max-width:520px){.lyr-text{padding:18px 16px}.lyr-text p{font-size:17px;line-height:2}}'
  + '</style>\n';

function buildLyricsPageContent(entry, lang, hub, text, opts) {
  const { creditsData, lyricsMap, hasStory } = opts;
  const L = RECORDING_LABELS[lang];
  const P = LYRICS_PAGE_LABELS[lang];
  const { title, titleAlt, artist, artistAlt } = lyricsNames(entry, lang);
  const releaseTypeLabel = entry.release_type ? RELEASE_TYPE_LABELS[lang][entry.release_type] : '';
  const textLang = lyricsLang(text);

  const trackHref = pathFor(lang, hub + '/' + slugifyName(entry.id));
  const artistPageHref = hub === 'credits' && entry.artist_en && entry.artist_en !== 'Miragesohi'
    ? pathFor(lang, 'credits/artist/' + slugifyName(entry.artist_en))
    : null;
  const bdi = (s) => '<bdi>' + escapeHtmlAttr(s) + '</bdi>';

  const eyebrowParts = [artist, entry.year, releaseTypeLabel].filter(Boolean);
  const eyebrow = escapeHtmlAttr(eyebrowParts.join(' · '));

  const h1 = lang === 'fa' ? `متن آهنگ «${title}»` : `${title} — Lyrics`;
  // The other language's spelling of the same names, as the subtitle: a
  // Persian page also answers the English search and the other way round.
  let standText = '';
  if (titleAlt || artistAlt) {
    const altTitle = titleAlt || title;
    const altArtist = artistAlt || artist;
    // One isolated run in the other language's direction, so the phrase
    // keeps its own word order inside a page of the opposite direction.
    standText = lang === 'fa'
      ? `<bdi dir="ltr">${escapeHtmlAttr(altTitle)} lyrics — ${escapeHtmlAttr(altArtist)}</bdi>`
      : `<bdi dir="rtl">متن آهنگ ${escapeHtmlAttr(altTitle)} — ${escapeHtmlAttr(altArtist)}</bdi>`;
  }

  // The intro names the song and artist in both languages, once, in a real
  // sentence (not a keyword list), with the year and the credit.
  const titleBoth = bdi(title) + (titleAlt ? ' (' + bdi(titleAlt) + ')' : '');
  const artistBoth = bdi(artist) + (artistAlt ? ' (' + bdi(artistAlt) + ')' : '');
  const yearPart = entry.year ? ' (' + escapeHtmlAttr(String(entry.year)) + ')' : '';
  const intro = lang === 'fa'
    ? `متن کامل ترانهٔ «${titleBoth}» با صدای ${artistBoth}${yearPart}. ${lyricsRoleSentence(entry, lang, true)}`
    : `Full lyrics of “${titleBoth}” by ${artistBoth}${yearPart}. ${lyricsRoleSentence(entry, lang, true)}`;

  const coverBlock = isLikelyImageUrl(entry.cover_url)
    ? `<div class="tc-cover" style="width:120px;height:120px;flex:none"><img class="tc-img" src="${escapeHtmlAttr(entry.cover_url)}" alt="${escapeHtmlAttr(title + ' — ' + artist)}" loading="lazy"></div>`
    : '';

  const { sp, ytLink, spotifyEmbed, youtubeEmbed } = recordingEmbeds(entry, title);

  const linkButtons = [];
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(trackHref)}">${escapeHtmlAttr(L.backToTrack)}</a>`);
  if (artistPageHref) {
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(artistPageHref)}">${escapeHtmlAttr(P.moreByArtist + ' ' + artist)}</a>`);
  } else if (entry.artist_en === 'Miragesohi') {
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, 'miragesohi'))}">${escapeHtmlAttr(NAV_LABELS.miragesohi[lang])}</a>`);
  }
  if (hasStory) {
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, hub + '/' + slugifyName(entry.id) + '/about'))}">${escapeHtmlAttr(L.aboutTrack)}</a>`);
  }
  if (sp) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(sp.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(L.listenSpotify)}</a>`);
  if (ytLink) linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(ytLink.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(L.watchYoutube)}</a>`);
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, hub))}">${escapeHtmlAttr((lang === 'fa' ? 'بازگشت به ' : 'Back to ') + NAV_LABELS[hub][lang])}</a>`);
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, 'home'))}">${escapeHtmlAttr(L.home)}</a>`);

  const others = otherLyricsByArtist(creditsData, lyricsMap, entry);
  const moreBlock = others.length
    ? `<h2 class="lyr-h2">${escapeHtmlAttr(P.moreBy + ' ' + artist)}</h2>`
      + `<nav class="roster" aria-label="${escapeHtmlAttr(P.moreBy + ' ' + artist)}">`
      + others.map((o) => {
        const oTitle = lang === 'fa' ? (o.title_fa || o.title_en) : (o.title_en || o.title_fa);
        const label = lang === 'fa' ? `متن آهنگ ${oTitle}` : `${oTitle}${P.moreLyricsSuffix}`;
        return `<a href="${escapeHtmlAttr(pathFor(lang, primaryHubFor(o) + '/' + slugifyName(o.id) + '/lyrics'))}">${escapeHtmlAttr(label)}</a>`;
      }).join('')
      + '</nav>'
    : '';

  return '<main class="wrap article">'
    + `<p class="eyebrow" style="margin-bottom:14px"><a href="${escapeHtmlAttr(trackHref)}">${escapeHtmlAttr(title)}</a> · ${eyebrow}</p>`
    + `<h1 class="atitle">${escapeHtmlAttr(h1)}</h1>`
    + (standText ? `<p class="stand">${standText}</p>` : '')
    + '<div class="hr"></div>'
    + `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin:0 0 28px">`
    + coverBlock
    + `<div style="flex:1;min-width:240px"><p>${intro}</p></div>`
    + '</div>'
    + spotifyEmbed
    + youtubeEmbed
    + `<h2 class="lyr-h2" style="margin-top:12px">${escapeHtmlAttr(L.lyrics + ' — ' + title)}</h2>`
    + `<div class="lyr-text" lang="${textLang}" dir="${textLang === 'fa' ? 'rtl' : 'ltr'}">${renderLyricsHtml(text)}</div>`
    + `<p class="lyr-note">${escapeHtmlAttr(P.note)}</p>`
    + `<div class="linkrow" style="margin-top:28px">${linkButtons.join('')}</div>`
    + moreBlock
    + '</main>';
}

// ---------------------------------------------------------------------
// per-artist pages — /credits/artist/<slug> (and /fa/ equivalent),
// listing every titled recording credited to Meraj Mirzaei for one
// artist. Same shell-reuse approach as an individual recording page:
// fetches credits.html as a shell, swaps in title/description/<main>.
// ---------------------------------------------------------------------

function buildArtistTitleText(entries, lang) {
  const first = entries[0];
  const primary = lang === 'fa' ? (first.artist_fa || first.artist_en) : (first.artist_en || first.artist_fa);
  return lang === 'fa' ? `${primary} — کارنامه | معراج میرزایی` : `${primary} — Credits | Meraj Mirzaei`;
}

function buildArtistDescriptionText(entries, lang) {
  const first = entries[0];
  const primary = lang === 'fa' ? (first.artist_fa || first.artist_en) : (first.artist_en || first.artist_fa);
  const n = entries.length;
  return lang === 'fa'
    ? `${n} اثر با ${primary} که معراج میرزایی روی آن‌ها اعتبار دارد — میکس، مسترینگ، تنظیم یا پروداکشن.`
    : `${n} recording${n === 1 ? '' : 's'} with ${primary} credited to Meraj Mirzaei — mix, mastering, arrangement or production.`;
}

function buildArtistPageContent(entries, lang, artistSlug, lyricsMap) {
  const first = entries[0];
  const primary = lang === 'fa' ? (first.artist_fa || first.artist_en) : (first.artist_en || first.artist_fa);
  const alt = lang === 'fa' ? first.artist_en : first.artist_fa;
  const photo = entries.map((e) => e.artist_image).find(Boolean) || entries.map((e) => e.cover_url).find(Boolean);
  const spotifyArtistUrl = entries.map((e) => e.spotify_artist_url).find(Boolean);
  const trackCountText = lang === 'fa' ? `${entries.length} اثر` : `${entries.length} track${entries.length === 1 ? '' : 's'}`;

  const photoBlock = isLikelyImageUrl(photo)
    ? `<div class="tc-cover" style="width:120px;height:120px;flex:none"><img class="tc-img" src="${escapeHtmlAttr(photo)}" alt="" loading="lazy"></div>`
    : '';

  const headerHtml = `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:10px">`
    + photoBlock
    + '<div>'
    + `<h1 class="atitle" style="margin-bottom:4px">${escapeHtmlAttr(primary)}</h1>`
    + (alt ? `<p class="stand" style="margin-bottom:4px">${escapeHtmlAttr(alt)}</p>` : '')
    + `<p class="eyebrow" style="margin-bottom:0">${escapeHtmlAttr(trackCountText)}</p>`
    + '</div></div>';

  const trackCards = entries.map((entry) => {
    const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
    const titleAlt = lang === 'fa' ? entry.title_en : entry.title_fa;
    const href = pathFor(lang, 'credits/' + slugifyName(entry.id));
    const cover = isLikelyImageUrl(entry.cover_url)
      ? `<div class="tc-cover"><img class="tc-img" src="${escapeHtmlAttr(entry.cover_url)}" alt="" loading="lazy"></div>`
      : '';
    const roleBadges = ROLE_ORDER.filter((f) => entry[f])
      .map((f) => `<span class="tc-role">${escapeHtmlAttr(ROLE_NAME_LABELS[lang][f])}</span>`)
      .join('');
    const rolesBlock = roleBadges ? `<span class="tc-roles">${roleBadges}</span>` : '';
    // A small button under the card when the song has lyrics — the same
    // look as the "Full page" button on the credits cards.
    const lyricsLink = lyricsFor(lyricsMap, entry)
      ? '<a class="tc-permalink" href="' + escapeHtmlAttr(pathFor(lang, 'credits/' + slugifyName(entry.id) + '/lyrics')) + '" '
        + 'style="display:block;margin-top:8px;text-align:center;font-family:var(--mono);font-size:10px;'
        + 'letter-spacing:.1em;text-transform:uppercase;text-decoration:none;color:var(--brass);'
        + 'border:1px solid var(--brass);border-radius:2px;padding:7px 10px">'
        + escapeHtmlAttr(RECORDING_LABELS[lang].lyrics) + '</a>'
      : '';
    return '<div class="trackcard-wrap"><a class="trackcard" href="' + escapeHtmlAttr(href) + '">'
      + cover
      + '<div class="tc-body">'
      + `<span class="tc-title">${escapeHtmlAttr(title)}</span>`
      + (titleAlt ? `<span class="tc-title-alt">${escapeHtmlAttr(titleAlt)}</span>` : '')
      + rolesBlock
      + '</div></a>' + lyricsLink + '</div>';
  }).join('');

  const linkButtons = [];
  if (spotifyArtistUrl) {
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(spotifyArtistUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(RECORDING_LABELS[lang].artistSpotify)}</a>`);
  }
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, 'credits'))}">${escapeHtmlAttr((lang === 'fa' ? 'بازگشت به ' : 'Back to ') + NAV_LABELS.credits[lang])}</a>`);
  linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(pathFor(lang, 'home'))}">${escapeHtmlAttr(RECORDING_LABELS[lang].home)}</a>`);

  return '<main class="wrap article">'
    + headerHtml
    + '<div class="hr"></div>'
    + `<div class="trackcard-grid">${trackCards}</div>`
    + `<div class="linkrow" style="margin-top:28px">${linkButtons.join('')}</div>`
    + '</main>';
}

async function buildEntityGraph(pathname, env) {
  const { lang, slug } = parseSitePath(pathname);
  const nodes = [buildPersonNode(lang)];
  const base = { canonicalPath: pathFor(lang, slug), enPath: pathFor('en', slug), faPath: pathFor('fa', slug) };

  const storySlug = parseStorySlug(slug);
  if (storySlug) {
    const creditsData = await readCreditsReadOnly(env);
    const entry = creditsData ? findEntryBySlug(creditsData, storySlug.hub, storySlug.recordingSlug) : null;
    if (entry) {
      const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
      const trackUrl = SITE_ORIGIN + pathFor(lang, storySlug.hub + '/' + storySlug.recordingSlug);
      const pageUrl = SITE_ORIGIN + base.canonicalPath;
      nodes.push({
        '@type': 'WebPage',
        '@id': pageUrl + '#webpage',
        url: pageUrl,
        name: RECORDING_LABELS[lang].aboutTrack + ' — ' + title,
        inLanguage: lang,
        about: { '@id': trackUrl + '#recording' },
        isPartOf: { '@id': trackUrl + '#webpage' },
      });
      nodes.push({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') },
          { '@type': 'ListItem', position: 2, name: NAV_LABELS[storySlug.hub][lang], item: SITE_ORIGIN + pathFor(lang, storySlug.hub) },
          { '@type': 'ListItem', position: 3, name: title, item: trackUrl },
          { '@type': 'ListItem', position: 4, name: RECORDING_LABELS[lang].aboutTrack, item: pageUrl },
        ],
      });
    }
    return { lang, slug, nodes, ...base };
  }

  const lyricsSlug = parseLyricsSlug(slug);
  if (lyricsSlug) {
    const creditsData = await readCreditsReadOnly(env);
    const entry = creditsData ? findEntryBySlug(creditsData, lyricsSlug.hub, lyricsSlug.recordingSlug) : null;
    const text = entry ? lyricsFor(await readLyricsReadOnly(env), entry) : null;
    if (entry && text) {
      const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
      const trackUrl = SITE_ORIGIN + pathFor(lang, lyricsSlug.hub + '/' + lyricsSlug.recordingSlug);
      const pageUrl = SITE_ORIGIN + base.canonicalPath;
      const recordingId = trackUrl + '#recording';
      const compositionId = pageUrl + '#composition';
      const textLang = lyricsLang(text);

      // The recording the lyrics belong to, so the reference below resolves
      // inside this page's own graph.
      const rec = buildOneRecordingNode(entry, lang);
      if (rec) {
        rec.node['@id'] = recordingId;
        rec.node.url = trackUrl;
        if (rec.artistNode) nodes.push(rec.artistNode);
        if (rec.usesMirage) nodes.push(buildMirageNode());
        nodes.push(rec.node);
      }

      const composition = {
        '@type': 'MusicComposition',
        '@id': compositionId,
        name: title,
        inLanguage: textLang,
        lyrics: { '@type': 'CreativeWork', inLanguage: textLang, text },
      };
      const altTitle = lang === 'fa' ? entry.title_en : entry.title_fa;
      if (altTitle && altTitle !== title) composition.alternateName = altTitle;
      if (rec) composition.recordedAs = { '@id': recordingId };
      nodes.push(composition);

      nodes.push({
        '@type': 'WebPage',
        '@id': pageUrl + '#webpage',
        url: pageUrl,
        name: buildLyricsTitleText(entry, lang),
        inLanguage: lang,
        about: { '@id': compositionId },
        mainEntity: { '@id': compositionId },
        isPartOf: { '@id': trackUrl + '#webpage' },
      });
      nodes.push({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') },
          { '@type': 'ListItem', position: 2, name: NAV_LABELS[lyricsSlug.hub][lang], item: SITE_ORIGIN + pathFor(lang, lyricsSlug.hub) },
          { '@type': 'ListItem', position: 3, name: title, item: trackUrl },
          { '@type': 'ListItem', position: 4, name: RECORDING_LABELS[lang].lyrics, item: pageUrl },
        ],
      });
    }
    return { lang, slug, nodes, ...base };
  }

  const artistSlug = parseArtistSlug(slug);
  if (artistSlug) {
    const creditsData = await readCreditsReadOnly(env);
    const entries = creditsData ? findArtistEntries(creditsData, artistSlug.artistSlug) : [];
    if (entries.length) {
      const first = entries[0];
      const artistId = SITE_ORIGIN + '/credits#artist-' + artistSlug.artistSlug;
      const artistNode = { '@type': 'MusicGroup', '@id': artistId, name: first.artist_en };
      if (first.artist_fa) artistNode.alternateName = first.artist_fa;
      const spotifyArtistUrl = entries.map((e) => e.spotify_artist_url).find(Boolean);
      if (spotifyArtistUrl) artistNode.sameAs = spotifyArtistUrl;
      nodes.push(artistNode);

      const pageUrl = SITE_ORIGIN + base.canonicalPath;
      const primaryName = lang === 'fa' ? (first.artist_fa || first.artist_en) : (first.artist_en || first.artist_fa);
      nodes.push({
        '@type': 'CollectionPage',
        '@id': pageUrl + '#webpage',
        url: pageUrl,
        name: primaryName,
        inLanguage: lang,
        about: { '@id': artistId },
      });
      nodes.push({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') },
          { '@type': 'ListItem', position: 2, name: NAV_LABELS.credits[lang], item: SITE_ORIGIN + pathFor(lang, 'credits') },
          { '@type': 'ListItem', position: 3, name: primaryName, item: pageUrl },
        ],
      });
    }
    return { lang, slug, nodes, ...base };
  }

  const photoMatch = /^gallery\/([a-z0-9][a-z0-9-]*)$/.exec(slug);
  if (photoMatch) {
    const items = await readGalleryReadOnly(env);
    const found = items ? findGalleryPhoto(items, photoMatch[1]) : null;
    if (found && found.exact) {
      const { list, i } = found;
      const index = buildGalleryPeopleIndex(await readCreditsReadOnly(env));
      const { images, extraNodes } = buildGalleryImageGraph([list[i]], lang, index);
      const pageUrl = SITE_ORIGIN + base.canonicalPath;
      const image = { ...images[0], '@id': pageUrl + '#image' };
      const { heading, title } = galleryPhotoTexts(list[i], i, list.length, lang, index);
      nodes.push(...extraNodes);
      nodes.push(image);
      nodes.push({
        '@type': 'ItemPage',
        '@id': pageUrl + '#webpage',
        url: pageUrl,
        name: title,
        inLanguage: lang,
        primaryImageOfPage: { '@id': image['@id'] },
        about: image.about || { '@id': PERSON_ID },
      });
      nodes.push({
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') },
          { '@type': 'ListItem', position: 2, name: NAV_LABELS.gallery[lang], item: SITE_ORIGIN + pathFor(lang, 'gallery') },
          { '@type': 'ListItem', position: 3, name: heading, item: pageUrl },
        ],
      });
    }
    return { lang, slug, nodes, ...base };
  }

  const recSlug = parseRecordingSlug(slug);
  if (recSlug) {
    const creditsData = await readCreditsReadOnly(env);
    const entry = creditsData ? findEntryBySlug(creditsData, recSlug.hub, recSlug.recordingSlug) : null;
    if (entry) {
      const result = buildOneRecordingNode(entry, lang);
      if (result) {
        const pageUrl = SITE_ORIGIN + base.canonicalPath;
        const recordingId = pageUrl + '#recording';
        result.node['@id'] = recordingId;
        result.node.url = pageUrl;
        if (result.artistNode) nodes.push(result.artistNode);
        if (result.usesMirage) nodes.push(buildMirageNode());
        nodes.push(result.node);
        const title = lang === 'fa' ? (entry.title_fa || entry.title_en) : (entry.title_en || entry.title_fa);
        nodes.push({
          '@type': 'WebPage',
          '@id': pageUrl + '#webpage',
          url: pageUrl,
          name: title,
          inLanguage: lang,
          about: { '@id': recordingId },
          isPartOf: { '@id': SITE_ORIGIN + pathFor(lang, recSlug.hub) + '#webpage' },
        });
        nodes.push({
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: NAV_LABELS.home[lang], item: SITE_ORIGIN + pathFor(lang, 'home') },
            { '@type': 'ListItem', position: 2, name: NAV_LABELS[recSlug.hub][lang], item: SITE_ORIGIN + pathFor(lang, recSlug.hub) },
            { '@type': 'ListItem', position: 3, name: title, item: pageUrl },
          ],
        });
      }
    }
    return { lang, slug, nodes, ...base };
  }

  const pageNode = buildPageNode(slug, lang);
  if (pageNode) nodes.push(pageNode);

  if (slug === 'gallery' && pageNode) {
    const galleryItems = await readGalleryReadOnly(env);
    if (galleryItems && galleryItems.length) {
      const index = buildGalleryPeopleIndex(await readCreditsReadOnly(env));
      const { images, extraNodes } = buildGalleryImageGraph(galleryItems, lang, index);
      if (images.length) pageNode.associatedMedia = images;
      nodes.push(...extraNodes);
    }
  }

  const breadcrumb = buildBreadcrumb(lang, slug);
  if (breadcrumb) nodes.push(breadcrumb);

  if (slug === 'credits' || slug === 'releases') {
    const creditsData = await readCreditsReadOnly(env);
    if (creditsData) {
      const { nodes: recNodes, usesMirage } = buildRecordingsGraph(creditsData, slug, lang);
      if (usesMirage && slug !== 'miragesohi') nodes.push(buildMirageNode());
      nodes.push(...recNodes);
    }
  }

  return { lang, slug, nodes, ...base };
}

// ---------------------------------------------------------------------
// HTMLRewriter transform: removes each page's old static JSON-LD, injects
// the generated @graph + canonical + og:image/Twitter Card tags, fixes the
// three hreflang <link> tags (previously always pointing at the homepage,
// on every page), fixes the language-toggle link (previously always the
// opposite-language HOMEPAGE regardless of current page), and rewrites
// internal ".html" links (nav/wordmark/footer) to their canonical
// extensionless form so they resolve without a redirect hop.
// ---------------------------------------------------------------------

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Resolves a same-origin ".html" href from the static markup (nav,
// wordmark, footer) to its canonical path. Only ever applied to relative
// links the site's own templates emit: "index.html", "credits.html",
// "fa/index.html", "../index.html" — never to absolute http(s) URLs.
function resolveHtmlHref(href, currentLang) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let lang = currentLang;
  let rest = href;
  if (rest.startsWith('fa/')) {
    lang = 'fa';
    rest = rest.slice(3);
  } else if (rest.startsWith('../')) {
    lang = 'en';
    rest = rest.slice(3);
  }
  const qIdx = rest.indexOf('?');
  const file = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rest.slice(qIdx);
  const base = file.replace(/\.html$/i, '');
  const slug = base === 'index' || base === '' ? 'home' : base;
  return pathFor(lang, slug) + query;
}

class RemoveElement {
  element(element) {
    element.remove();
  }
}

class SetAttribute {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
  element(element) {
    element.setAttribute(this.name, this.value);
  }
}

class HeadInjector {
  constructor(html) {
    this.html = html;
  }
  element(element) {
    element.append(this.html, { html: true });
  }
}

class LangtogRewriter {
  constructor(targetHref) {
    this.targetHref = targetHref;
  }
  element(element) {
    element.setAttribute('href', this.targetHref);
  }
}

class InternalLinkRewriter {
  constructor(currentLang) {
    this.currentLang = currentLang;
  }
  element(element) {
    if (element.getAttribute('id') === 'langtog') return; // owned by LangtogRewriter
    const href = element.getAttribute('href');
    if (!href) return;
    const resolved = resolveHtmlHref(href, this.currentLang);
    if (resolved) element.setAttribute('href', resolved);
  }
}

class ReplaceText {
  // NB: not `this.text` — HTMLRewriter's ElementContentHandlers looks for
  // a `text` method on this object, so a same-named plain property here
  // makes it throw ("not of type 'function'") the moment this handler
  // matches anything.
  constructor(value) {
    this.value = value;
  }
  element(element) {
    element.setInnerContent(this.value); // plain text — auto-escaped, correct for <title>
  }
}

class ReplaceScriptBody {
  constructor(value) {
    this.value = value;
  }
  element(element) {
    // {html: true} here means "insert literally, don't escape" — required
    // for a <script> body: setInnerContent's default text mode HTML-
    // escapes (e.g. "&&" -> "&amp;&amp;"), which a JS engine can't parse.
    element.setInnerContent(this.value, { html: true });
  }
}

class SetInnerHtml {
  constructor(html) {
    this.html = html;
  }
  element(element) {
    element.setInnerContent(this.html, { html: true });
  }
}

class ReplaceElement {
  constructor(html) {
    this.html = html;
  }
  element(element) {
    element.replace(this.html, { html: true });
  }
}

async function applyEntitySeo(response, env, pathname, ogImageOverride) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return response;

  const { lang, nodes, canonicalPath, enPath, faPath } = await buildEntityGraph(pathname, env);
  const canonicalUrl = SITE_ORIGIN + canonicalPath;
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }, null, 2).replace(/</g, '\\u003c');
  // A recording's own cover art is a more specific, relevant image than
  // the generic portrait — passed in by tryServeRecordingPage() below,
  // through the same single injection point every other page uses (never
  // a second, duplicate og:image tag).
  const ogImage = ogImageOverride || PORTRAIT_URL;

  const injection =
    '\n' + FAVICON_LINKS +
    '<link rel="canonical" href="' + escapeHtmlAttr(canonicalUrl) + '">\n' +
    '<meta property="og:url" content="' + escapeHtmlAttr(canonicalUrl) + '">\n' +
    '<meta property="og:image" content="' + escapeHtmlAttr(ogImage) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:image" content="' + escapeHtmlAttr(ogImage) + '">\n' +
    '<script type="application/ld+json">' + jsonLd + '</script>\n';

  // Root-relative, matching every other internal link on the page (only
  // canonical/hreflang/JSON-LD urls need to be absolute).
  const langtogHref = lang === 'en' ? faPath : enPath;

  // Every EN page's <head> carries an on-load script that redirects a
  // fa-preferring visitor before they see any content — but it always
  // hardcoded the same target, the FA homepage, regardless of which page
  // they landed on. Same bug class as the language toggle, same fix: send
  // them to this page's own FA equivalent instead. (FA pages carry no
  // such script, so this selector simply matches nothing there.)
  const faTarget = JSON.stringify(faPath);
  const langRedirectBody = '\n(function(){\n'
    + '  if(location.protocol !== \'http:\' && location.protocol !== \'https:\') return;\n'
    + '  try{\n'
    + '    var stored = localStorage.getItem(\'mm_lang\');\n'
    + '    if(stored){ if(stored===\'fa\'){ location.replace(' + faTarget + '); } return; }\n'
    + '    var langs = navigator.languages || [navigator.language || \'\'];\n'
    + '    for(var i=0;i<langs.length;i++){\n'
    + '      if(/^fa\\b/i.test(langs[i])){ location.replace(' + faTarget + '); return; }\n'
    + '    }\n'
    + '  }catch(e){}\n'
    + '})();\n';

  // Only the two credits hubs get the artist index — never a recording
  // or artist detail page, which reuse the same hub shell but replace
  // <main> wholesale (the #creditsRoot selector simply won't match
  // there, but checking the path keeps the data read off those requests).
  let artistIndexHtml = null;
  if (canonicalPath === pathFor('en', 'credits') || canonicalPath === pathFor('fa', 'credits')) {
    try {
      artistIndexHtml = await buildArtistIndexHtml(env, lang);
    } catch (err) {
      // A missing index is cosmetic; a 500 on the hub is not.
      console.error('buildArtistIndexHtml failed', (err && err.stack) || err);
    }
  }

  let rewriter = new HTMLRewriter()
    .on('script[type="application/ld+json"]', new RemoveElement())
    .on('link[rel="alternate"][hreflang="en"]', new SetAttribute('href', SITE_ORIGIN + enPath))
    .on('link[rel="alternate"][hreflang="fa"]', new SetAttribute('href', SITE_ORIGIN + faPath))
    .on('link[rel="alternate"][hreflang="x-default"]', new SetAttribute('href', SITE_ORIGIN + enPath))
    .on('head', new HeadInjector(injection))
    .on('script#langRedirect', new ReplaceScriptBody(langRedirectBody))
    .on('a#langtog', new LangtogRewriter(langtogHref))
    .on('a[href$=".html"]', new InternalLinkRewriter(lang));

  if (artistIndexHtml) {
    rewriter = rewriter.on('div#creditsRoot', new BeforeElementInjector(artistIndexHtml));
  }

  // The gallery page's photos come from data/gallery.json (edited on the
  // admin "Gallery" tab), not from the page's own markup.
  if (canonicalPath === pathFor('en', 'gallery') || canonicalPath === pathFor('fa', 'gallery')) {
    const galleryItems = await readGalleryReadOnly(env);
    if (galleryItems) {
      const peopleIndex = buildGalleryPeopleIndex(await readCreditsReadOnly(env));
      rewriter = rewriter
        .on('div#gallery', new SetInnerHtml(buildGalleryHtml(galleryItems, lang, peopleIndex)))
        .on('body', new HeadInjector(buildGalleryViewerJson(galleryItems, lang, peopleIndex)));
    }
  }

  return rewriter.transform(response);
}

// ---------------------------------------------------------------------
// individual recording page serving — fetches the entry's hub page
// (credits.html/releases.html, matching language) as a shell so the
// detail page reuses the site's real header/nav/footer/CSS verbatim (no
// new template), replaces only the title/description/og tags and <main>
// with the recording's own content, strips the hub's list-rendering and
// click-to-play scripts (nothing left on this page for them to mount
// into — the player here is a plain, always-visible, static iframe), and
// then runs the result through the same applyEntitySeo() every other
// page goes through, so canonical/hreflang/JSON-LD/internal links are
// handled by the one shared pipeline, not a second one.
// ---------------------------------------------------------------------

const RECORDING_PATH_RE = /^\/(fa\/)?(credits|releases)\/([a-z0-9-]+)\/?$/;

async function tryServeRecordingPage(env, pathname) {
  const m = RECORDING_PATH_RE.exec(pathname);
  if (!m) return null;
  const lang = m[1] ? 'fa' : 'en';
  const hub = m[2];
  const recordingSlug = m[3];

  const creditsData = await readCreditsReadOnly(env);
  if (!creditsData) return null;
  const entry = findEntryBySlug(creditsData, hub, recordingSlug);
  if (!entry) return null; // unknown or untitled slug — no fabricated page, let it 404 normally

  const shellPath = (lang === 'fa' ? '/fa/' : '/') + hub + '.html';
  const shellRes = await env.ASSETS.fetch(new Request('https://internal' + shellPath));
  if (!shellRes.ok) return null;

  const storiesData = await readStoriesReadOnly(env);
  const story = storiesData ? findStoryForEntry(storiesData, entry) : null;
  const hasLyrics = !!lyricsFor(await readLyricsReadOnly(env), entry);

  const titleText = buildRecordingTitleText(entry, lang);
  const descText = buildRecordingDescriptionText(entry, lang);
  const mainHtml = renderRecordingDetailContent(entry, lang, hub, story, hasLyrics);
  const ogImage = isLikelyImageUrl(entry.cover_url) ? absoluteCoverUrl(entry.cover_url) : PORTRAIT_URL;

  const detailRewriter = new HTMLRewriter()
    .on('title', new ReplaceText(titleText))
    .on('meta[name="description"]', new SetAttribute('content', descText))
    .on('meta[property="og:title"]', new SetAttribute('content', titleText))
    .on('meta[property="og:description"]', new SetAttribute('content', descText))
    .on('meta[property="og:type"]', new SetAttribute('content', 'music.song'))
    .on('main', new ReplaceElement(mainHtml))
    .on('#creditsConfig', new RemoveElement())
    .on('#playbackController', new RemoveElement())
    .on('script[src="/credits-render.js"]', new RemoveElement())
    .on('script[src="https://open.spotify.com/embed/iframe-api/v1"]', new RemoveElement())
    .on('script[src="https://www.youtube.com/iframe_api"]', new RemoveElement());

  const stage1 = detailRewriter.transform(shellRes);
  return applyEntitySeo(stage1, env, pathname, ogImage);
}

const STORY_PATH_RE = /^\/(fa\/)?(credits|releases)\/([a-z0-9-]+)\/about\/?$/;

// A gallery photo's own page (/gallery/<slug>, /fa/gallery/<slug>): the
// gallery page itself as the shell, with <main> replaced by that one photo
// large, its names and caption, and previous/next links — so every photo
// has an address of its own, titled with the names of who is in it.
const GALLERY_PHOTO_PATH_RE = /^\/(fa\/)?gallery\/([a-z0-9][a-z0-9-]{0,160})\/?$/;

async function tryServeGalleryPhotoPage(env, pathname) {
  const m = GALLERY_PHOTO_PATH_RE.exec(pathname);
  if (!m) return null;
  const lang = m[1] ? 'fa' : 'en';
  const items = await readGalleryReadOnly(env);
  if (!items) return null;
  const found = findGalleryPhoto(items, m[2]);
  if (!found) return null;
  const { list, i } = found;
  const canonical = pathFor(lang, 'gallery/' + galleryPhotoSlug(list[i]));
  if (!found.exact || pathname !== canonical) return Response.redirect(SITE_ORIGIN + canonical, 301);

  const shellRes = await env.ASSETS.fetch(new Request('https://internal' + (lang === 'fa' ? '/fa/' : '/') + 'gallery.html'));
  if (!shellRes.ok) return null;
  const index = buildGalleryPeopleIndex(await readCreditsReadOnly(env));
  const { title, description } = galleryPhotoTexts(list[i], i, list.length, lang, index);

  const stage1 = new HTMLRewriter()
    .on('title', new ReplaceText(title))
    .on('meta[name="description"]', new SetAttribute('content', description))
    .on('meta[property="og:title"]', new SetAttribute('content', title))
    .on('meta[property="og:description"]', new SetAttribute('content', description))
    .on('meta[property="og:type"]', new SetAttribute('content', 'article'))
    .on('main', new ReplaceElement(renderGalleryPhotoContent(list, i, lang, index)))
    .on('body', new HeadInjector(buildGalleryViewerJson(items, lang, index)))
    .transform(shellRes);
  return applyEntitySeo(stage1, env, pathname, SITE_ORIGIN + list[i].src);
}

async function tryServeStoryPage(env, pathname) {
  const m = STORY_PATH_RE.exec(pathname);
  if (!m) return null;
  const lang = m[1] ? 'fa' : 'en';
  const hub = m[2];
  const recordingSlug = m[3];

  const creditsData = await readCreditsReadOnly(env);
  if (!creditsData) return null;
  const entry = findEntryBySlug(creditsData, hub, recordingSlug);
  if (!entry) return null;

  const storiesData = await readStoriesReadOnly(env);
  const story = storiesData ? findStoryForEntry(storiesData, entry) : null;
  const storyText = story ? (lang === 'fa' ? story.story_fa : story.story_en) : null;
  if (!storyText || !String(storyText).trim()) return null; // no story for this language — no fabricated page

  const shellPath = (lang === 'fa' ? '/fa/' : '/') + hub + '.html';
  const shellRes = await env.ASSETS.fetch(new Request('https://internal' + shellPath));
  if (!shellRes.ok) return null;

  const titleText = buildStoryTitleText(entry, lang);
  const descText = buildStoryDescriptionText(storyText);
  const mainHtml = buildStoryPageContent(entry, lang, hub, storyText);

  const detailRewriter = new HTMLRewriter()
    .on('title', new ReplaceText(titleText))
    .on('meta[name="description"]', new SetAttribute('content', descText))
    .on('meta[property="og:title"]', new SetAttribute('content', titleText))
    .on('meta[property="og:description"]', new SetAttribute('content', descText))
    .on('meta[property="og:type"]', new SetAttribute('content', 'article'))
    .on('main', new ReplaceElement(mainHtml))
    .on('#creditsConfig', new RemoveElement())
    .on('#playbackController', new RemoveElement())
    .on('script[src="/credits-render.js"]', new RemoveElement())
    .on('script[src="https://open.spotify.com/embed/iframe-api/v1"]', new RemoveElement())
    .on('script[src="https://www.youtube.com/iframe_api"]', new RemoveElement());

  const stage1 = detailRewriter.transform(shellRes);
  return applyEntitySeo(stage1, env, pathname);
}

const LYRICS_PATH_RE = /^\/(fa\/)?(credits|releases)\/([a-z0-9-]+)\/lyrics\/?$/;

// A song's lyrics page. Exists only for a titled song that has lyrics in
// data/lyrics.json — anything else falls through to a normal 404, so there
// is never an empty or made-up page.
async function tryServeLyricsPage(env, pathname) {
  const m = LYRICS_PATH_RE.exec(pathname);
  if (!m) return null;
  const lang = m[1] ? 'fa' : 'en';
  const hub = m[2];
  const recordingSlug = m[3];

  const creditsData = await readCreditsReadOnly(env);
  if (!creditsData) return null;
  const entry = findEntryBySlug(creditsData, hub, recordingSlug);
  if (!entry) return null;

  const lyricsMap = await readLyricsReadOnly(env);
  const text = lyricsFor(lyricsMap, entry);
  if (!text) return null;

  const shellPath = (lang === 'fa' ? '/fa/' : '/') + hub + '.html';
  const shellRes = await env.ASSETS.fetch(new Request('https://internal' + shellPath));
  if (!shellRes.ok) return null;

  const storiesData = await readStoriesReadOnly(env);
  const story = storiesData ? findStoryForEntry(storiesData, entry) : null;
  const storyText = story ? (lang === 'fa' ? story.story_fa : story.story_en) : null;
  const hasStory = !!(storyText && String(storyText).trim());

  const titleText = buildLyricsTitleText(entry, lang);
  const descText = buildLyricsDescriptionText(entry, lang, text);
  const mainHtml = buildLyricsPageContent(entry, lang, hub, text, { creditsData, lyricsMap, hasStory });
  const ogImage = isLikelyImageUrl(entry.cover_url) ? absoluteCoverUrl(entry.cover_url) : PORTRAIT_URL;

  const detailRewriter = new HTMLRewriter()
    .on('title', new ReplaceText(titleText))
    .on('meta[name="description"]', new SetAttribute('content', descText))
    .on('meta[property="og:title"]', new SetAttribute('content', titleText))
    .on('meta[property="og:description"]', new SetAttribute('content', descText))
    .on('meta[property="og:type"]', new SetAttribute('content', 'article'))
    .on('head', new HeadInjector(LYRICS_PAGE_CSS))
    .on('main', new ReplaceElement(mainHtml))
    .on('#creditsConfig', new RemoveElement())
    .on('#playbackController', new RemoveElement())
    .on('script[src="/credits-render.js"]', new RemoveElement())
    .on('script[src="https://open.spotify.com/embed/iframe-api/v1"]', new RemoveElement())
    .on('script[src="https://www.youtube.com/iframe_api"]', new RemoveElement());

  const stage1 = detailRewriter.transform(shellRes);
  return applyEntitySeo(stage1, env, pathname, ogImage);
}

const ARTIST_PATH_RE = /^\/(fa\/)?credits\/artist\/([a-z0-9-]+)\/?$/;

async function tryServeArtistPage(env, pathname) {
  const m = ARTIST_PATH_RE.exec(pathname);
  if (!m) return null;
  const lang = m[1] ? 'fa' : 'en';
  const artistSlug = m[2];

  const creditsData = await readCreditsReadOnly(env);
  if (!creditsData) return null;
  const entries = findArtistEntries(creditsData, artistSlug);
  if (!entries.length) return null; // unknown artist slug — no fabricated page

  const shellPath = (lang === 'fa' ? '/fa/' : '/') + 'credits.html';
  const shellRes = await env.ASSETS.fetch(new Request('https://internal' + shellPath));
  if (!shellRes.ok) return null;

  const titleText = buildArtistTitleText(entries, lang);
  const descText = buildArtistDescriptionText(entries, lang);
  const mainHtml = buildArtistPageContent(entries, lang, artistSlug, await readLyricsReadOnly(env));
  const photo = entries.map((e) => e.artist_image).find(Boolean) || entries.map((e) => e.cover_url).find(Boolean);
  const ogImage = isLikelyImageUrl(photo) ? absoluteCoverUrl(photo) : PORTRAIT_URL;

  const detailRewriter = new HTMLRewriter()
    .on('title', new ReplaceText(titleText))
    .on('meta[name="description"]', new SetAttribute('content', descText))
    .on('meta[property="og:title"]', new SetAttribute('content', titleText))
    .on('meta[property="og:description"]', new SetAttribute('content', descText))
    .on('main', new ReplaceElement(mainHtml))
    .on('#creditsConfig', new RemoveElement())
    .on('#playbackController', new RemoveElement())
    .on('script[src="/credits-render.js"]', new RemoveElement())
    .on('script[src="https://open.spotify.com/embed/iframe-api/v1"]', new RemoveElement())
    .on('script[src="https://www.youtube.com/iframe_api"]', new RemoveElement());

  const stage1 = detailRewriter.transform(shellRes);
  return applyEntitySeo(stage1, env, pathname, ogImage);
}

// ---------------------------------------------------------------------
// admin HTML shell (served only after authentication)
// ---------------------------------------------------------------------

async function serveAdminApp(env) {
  const res = await env.ASSETS.fetch(new Request('https://internal/admin-app.html'));
  if (res.status === 404) {
    return new Response('Admin app asset missing', { status: 500 });
  }
  return new Response(res.body, {
    status: res.status,
    headers: res.headers,
  });
}

function loginPage(error) {
  const errHtml = error
    ? `<p class="err">${error.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<title>Admin login</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0B0D10;color:#E7E4DE;font-family:system-ui,sans-serif}
  form{background:#14181D;border:1px solid #262D36;border-radius:6px;padding:32px;
    width:100%;max-width:320px}
  h1{font-size:16px;margin:0 0 20px;letter-spacing:.02em}
  input{width:100%;box-sizing:border-box;padding:10px 12px;background:#1B2027;
    border:1px solid #262D36;border-radius:4px;color:#E7E4DE;font-size:15px;margin-bottom:14px}
  button{width:100%;padding:10px;background:#C2A878;color:#0B0D10;border:0;border-radius:4px;
    font-weight:600;cursor:pointer;font-size:15px}
  .err{color:#e08585;font-size:13px;margin:-6px 0 14px}
</style>
</head><body>
<form method="POST" action="/admin/login">
  <h1>Admin login</h1>
  ${errHtml}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------

async function handleLoginPost(request, env) {
  if (!env.ADMIN_PASSWORD) return html('Admin not configured', 503);
  let password = '';
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const b = await request.json().catch(() => ({}));
    password = b.password || '';
  } else {
    const form = await request.formData();
    password = form.get('password') || '';
  }
  // Small fixed delay slows down naive scripted brute force; the real
  // protection is the password itself plus the page being unindexed and
  // unlinked.
  await new Promise((r) => setTimeout(r, 300));
  if (!timingSafeEqual(String(password), env.ADMIN_PASSWORD)) {
    return html(loginPage('Wrong password.'), 401);
  }
  const token = await signSession(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/admin',
      'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_MS / 1000),
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/admin',
      'Set-Cookie': sessionCookieHeader('', 0),
    },
  });
}

async function handleGetCredits(env) {
  const file = await ghGetFile(env, DATA_PATH);
  if (!file) return json({ error: 'data/credits.json not found in repo' }, 500);
  const content = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return json({ error: 'data/credits.json is not valid JSON: ' + e.message }, 500);
  }
  return json({ data, sha: file.sha });
}

async function handleSave(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { content, sha } = body;
  const invalid = validateEntries(content);
  if (invalid) return json({ error: invalid }, 400);

  const text = JSON.stringify(content, null, 2) + '\n';
  try {
    const result = await ghPutFile(
      env,
      DATA_PATH,
      base64FromUtf8(text),
      sha || undefined,
      `Update credits data via /admin`
    );
    return json({ ok: true, sha: result.content && result.content.sha });
  } catch (e) {
    if (e.status === 409) {
      return json({ error: 'Someone else saved changes since you loaded this page. Reload and try again.' }, 409);
    }
    return json({ error: e.message || 'GitHub save failed' }, 502);
  }
}

async function handleGetHomepage(env) {
  const file = await ghGetFile(env, HOMEPAGE_PATH);
  if (!file) return json({ data: [], sha: null });
  const content = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return json({ error: 'data/homepage.json is not valid JSON: ' + e.message }, 500);
  }
  return json({ data, sha: file.sha });
}

async function handleSaveHomepage(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { content, sha } = body;
  const invalid = validateHomepage(content);
  if (invalid) return json({ error: invalid }, 400);

  const text = JSON.stringify(content, null, 2) + '\n';
  try {
    const result = await ghPutFile(
      env,
      HOMEPAGE_PATH,
      base64FromUtf8(text),
      sha || undefined,
      `Update homepage artist list via /admin`
    );
    return json({ ok: true, sha: result.content && result.content.sha });
  } catch (e) {
    if (e.status === 409) {
      return json({ error: 'Someone else saved changes since you loaded this page. Reload and try again.' }, 409);
    }
    return json({ error: e.message || 'GitHub save failed' }, 502);
  }
}

// ---------------------------------------------------------------------
// Lyrics — data/lyrics.json (see LYRICS_PATH). Loaded and saved whole by
// the admin panel's "Lyrics" tab, the same way as the homepage list.
// ---------------------------------------------------------------------

function utf8FromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// The Contents API only inlines files up to 1 MB; past that it answers with
// empty content, and the raw media type is the way to get the text.
async function ghGetFileText(env, file, path) {
  if (file.content && file.encoding === 'base64') return utf8FromBase64(file.content);
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: { ...ghHeaders(env), Accept: 'application/vnd.github.raw+json' } });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  return res.text();
}

async function handleGetLyrics(env) {
  const file = await ghGetFile(env, LYRICS_PATH);
  if (!file) return json({ data: [], sha: null });
  let data;
  try {
    data = JSON.parse(await ghGetFileText(env, file, LYRICS_PATH));
  } catch (e) {
    return json({ error: 'data/lyrics.json could not be read: ' + e.message }, 500);
  }
  if (!Array.isArray(data)) return json({ error: 'data/lyrics.json is not a list' }, 500);
  return json({ data, sha: file.sha });
}

async function handleSaveLyrics(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { content, sha } = body;
  const invalid = validateLyrics(content);
  if (invalid) return json({ error: invalid }, 400);

  // Only songs that actually have lyrics are stored; the text itself is
  // kept as pasted (only the line endings are unified and the ends trimmed).
  const rows = [];
  for (const row of content) {
    const lyrics = row.lyrics.replace(/\r\n?/g, '\n').trim();
    if (lyrics) rows.push({ id: row.id, lyrics });
  }

  const text = JSON.stringify(rows, null, 2) + '\n';
  try {
    const result = await ghPutFile(
      env,
      LYRICS_PATH,
      base64FromUtf8(text),
      sha || undefined,
      `Update song lyrics via /admin`
    );
    return json({ ok: true, sha: result.content && result.content.sha });
  } catch (e) {
    if (e.status === 409) {
      return json({ error: 'Someone else saved changes since you loaded this page. Reload and try again.' }, 409);
    }
    return json({ error: e.message || 'GitHub save failed' }, 502);
  }
}

const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function safeSlug(s) {
  return String(s || 'cover')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'cover';
}

async function handleUploadImage(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { filenameHint, mime, contentBase64 } = body;
  const ext = ALLOWED_IMAGE_TYPES[mime];
  if (!ext) return json({ error: 'Unsupported image type. Use JPEG, PNG, or WebP.' }, 400);
  if (!contentBase64 || typeof contentBase64 !== 'string') return json({ error: 'Missing image data' }, 400);
  const approxBytes = contentBase64.length * 0.75;
  if (approxBytes > MAX_IMAGE_BYTES) return json({ error: 'Image too large (max 8MB).' }, 400);

  const slug = safeSlug(filenameHint);
  const path = `${COVERS_DIR}/${slug}-${Date.now().toString(36)}.${ext}`;
  try {
    await ghPutFile(env, path, contentBase64, undefined, `Add cover image via /admin: ${slug}`);
    return json({ ok: true, path: '/images/covers/' + path.split('/').pop() });
  } catch (e) {
    return json({ error: e.message || 'GitHub upload failed' }, 502);
  }
}

// ---------------------------------------------------------------------
// Gallery — data/gallery.json plus the photos in GALLERY_DIR.
//
// Unlike a cover upload, uploading a gallery photo commits nothing: the
// file is only stored as a git blob. Save then writes the new photos,
// gallery.json and the removal of any photo taken off the list as ONE
// commit, so the site rebuilds once per Save, never lists a photo that
// isn't deployed yet, and removed photos don't pile up in the repo.
// ---------------------------------------------------------------------

const ASSETS_DIR = 'merajmirzaei-site (4)';
// Any site image may be listed (the two original gallery photos are the
// site-wide /images/studio.jpg and /images/portrait.jpg); only files in
// images/gallery/ are ever added or removed by a gallery save.
const GALLERY_SRC_RE = /^\/images\/(?:gallery\/)?[a-z0-9][a-z0-9-]{0,100}\.(?:jpg|png|webp)$/;
const GALLERY_UPLOAD_SRC_RE = /^\/images\/gallery\/[a-z0-9][a-z0-9-]{0,100}\.(?:jpg|png|webp)$/;
const GALLERY_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const GALLERY_MAX_ITEMS = 300;
const GALLERY_CAPTION_MAX = 300;
const GALLERY_PEOPLE_MAX = 12;
const GALLERY_NAME_MAX = 80;

function validateGallery(data) {
  if (!Array.isArray(data)) return 'data must be an array';
  if (data.length > GALLERY_MAX_ITEMS) return `too many photos (max ${GALLERY_MAX_ITEMS})`;
  const ids = new Set();
  const srcs = new Set();
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    const label = `Photo ${i + 1}`;
    if (!e || typeof e !== 'object') return `${label} is not an object`;
    if (typeof e.id !== 'string' || !GALLERY_ID_RE.test(e.id)) return `${label}: invalid id`;
    if (ids.has(e.id)) return `${label}: duplicate id`;
    ids.add(e.id);
    if (typeof e.src !== 'string' || !GALLERY_SRC_RE.test(e.src)) return `${label}: invalid photo path`;
    if (srcs.has(e.src)) return `${label}: the same photo is listed twice`;
    srcs.add(e.src);
    if (e.people != null) {
      if (!Array.isArray(e.people)) return `${label}: people must be a list`;
      if (e.people.length > GALLERY_PEOPLE_MAX) return `${label}: too many names (max ${GALLERY_PEOPLE_MAX})`;
      for (const n of e.people) {
        if (typeof n !== 'string' || !n.trim()) return `${label}: empty name`;
        if (n.length > GALLERY_NAME_MAX) return `${label}: name is too long`;
      }
    }
    for (const f of ['caption_en', 'caption_fa']) {
      if (e[f] != null && typeof e[f] !== 'string') return `${label}: ${f} must be text`;
      if (e[f] && e[f].length > GALLERY_CAPTION_MAX) return `${label}: caption is too long (max ${GALLERY_CAPTION_MAX} characters)`;
    }
    if (e.order != null && typeof e.order !== 'number') return `${label}: order must be a number`;
  }
  return null;
}

// Plain GitHub REST call against this repo; throws with .status on failure.
async function ghApi(env, method, apiPath, body) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}${apiPath}`, {
    method,
    headers: body ? { ...ghHeaders(env), 'Content-Type': 'application/json' } : ghHeaders(env),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.message || `GitHub ${method} ${apiPath} failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return j;
}

// Files currently in a repo directory ([] if it doesn't exist yet).
async function ghListDir(env, dirPath) {
  const url = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(dirPath).replace(/%2F/g, '/')}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub GET ${dirPath} failed: ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list.filter((f) => f && f.type === 'file') : [];
}

// The git blob id of a text file — what the Contents API reports as the
// file's "sha" — so a save can hand the admin panel gallery.json's new sha
// without a follow-up read that may still see the old file.
async function gitBlobSha(text) {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The file name a gallery photo should have: the names of the people in it
// (e.g. "kamyar-meraj-mirzaei-<id>.jpg" — Google reads image file names),
// else its English caption, else whatever it's called now. The short
// unique ending of the current name is kept, so a rename never collides.
function galleryFileNameFor(entry, currentName, taken) {
  const m = /^(.*?)(?:-([a-z0-9]+))?\.(jpg|png|webp)$/.exec(currentName);
  if (!m) return currentName;
  const [, base, suffix, ext] = m;
  const people = Array.isArray(entry.people) ? entry.people : [];
  const trimSlug = (t) => slugifyName(t).slice(0, 70).replace(/-+$/, '');
  const desired = trimSlug(people.join(' ')) || trimSlug(entry.caption_en || '');
  if (!desired || desired === base) return currentName;
  let candidate = `${desired}-${suffix || Math.random().toString(36).slice(2, 8)}.${ext}`;
  while (taken.has(candidate)) candidate = `${desired}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return candidate;
}

async function handleGetGallery(env) {
  const file = await ghGetFile(env, GALLERY_PATH);
  if (!file) return json({ data: [], sha: null });
  const content = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return json({ error: 'data/gallery.json is not valid JSON: ' + e.message }, 500);
  }
  return json({ data, sha: file.sha });
}

async function handleUploadGalleryImage(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { filenameHint, mime, contentBase64 } = body;
  const ext = ALLOWED_IMAGE_TYPES[mime];
  if (!ext) return json({ error: 'Unsupported image type. Use JPEG, PNG, or WebP.' }, 400);
  if (!contentBase64 || typeof contentBase64 !== 'string') return json({ error: 'Missing image data' }, 400);
  if (contentBase64.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: 'Image too large (max 8MB).' }, 400);

  const slug = safeSlug(filenameHint || 'photo');
  const name = `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.${ext}`;
  try {
    const blob = await ghApi(env, 'POST', '/git/blobs', { content: contentBase64, encoding: 'base64' });
    return json({ ok: true, blobSha: blob.sha, path: '/images/gallery/' + name });
  } catch (e) {
    return json({ error: e.message || 'GitHub upload failed' }, 502);
  }
}

async function handleSaveGallery(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { content, sha, newFiles } = body;
  const invalid = validateGallery(content);
  if (invalid) return json({ error: invalid }, 400);
  if (newFiles != null && !Array.isArray(newFiles)) return json({ error: 'Invalid request body' }, 400);

  const used = new Set(content.map((e) => e.src));
  const adds = new Map(); // src -> blob sha
  for (const f of newFiles || []) {
    if (!f || typeof f.src !== 'string' || !GALLERY_UPLOAD_SRC_RE.test(f.src)
        || typeof f.blobSha !== 'string' || !/^[0-9a-f]{40}$/.test(f.blobSha)) {
      return json({ error: 'Invalid uploaded photo' }, 400);
    }
    // A photo uploaded and then removed again before saving is just dropped.
    if (used.has(f.src)) adds.set(f.src, f.blobSha);
  }

  try {
    // Same "someone else saved first" check as every other tab's save.
    const current = await ghGetFile(env, GALLERY_PATH);
    if ((current ? current.sha : null) !== (sha || null)) {
      return json({ error: 'Someone else saved changes since you loaded this page. Reload and try again.' }, 409);
    }

    const existing = await ghListDir(env, GALLERY_DIR);
    const existingSrcs = new Set(existing.map((f) => '/images/gallery/' + f.name));
    for (const src of used) {
      if (GALLERY_UPLOAD_SRC_RE.test(src) && !existingSrcs.has(src) && !adds.has(src)) {
        return json({ error: `A photo on the list is missing (${src.split('/').pop()}). Remove it and upload it again.` }, 400);
      }
    }

    // Give each uploaded photo its name-based file name (see
    // galleryFileNameFor); a renamed photo is written at its new path and
    // its old file is removed below like any other unused file.
    const existingByName = new Map(existing.map((f) => [f.name, f]));
    const taken = new Set(existing.map((f) => f.name));
    const writes = new Map(); // final src -> blob sha
    const finalContent = content.map((e) => {
      if (!GALLERY_UPLOAD_SRC_RE.test(e.src)) return e;
      const name = e.src.split('/').pop();
      const target = galleryFileNameFor(e, name, taken);
      taken.add(target);
      const src = '/images/gallery/' + target;
      if (adds.has(e.src)) writes.set(src, adds.get(e.src));
      else if (target !== name) writes.set(src, existingByName.get(name).sha);
      return target === name ? e : { ...e, src };
    });
    const finalUsed = new Set(finalContent.map((e) => e.src));
    const text = JSON.stringify(finalContent, null, 2) + '\n';

    const tree = [];
    for (const [src, blobSha] of writes) {
      tree.push({ path: ASSETS_DIR + src, mode: '100644', type: 'blob', sha: blobSha });
    }
    for (const f of existing) {
      if (!finalUsed.has('/images/gallery/' + f.name)) {
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); // delete
      }
    }
    tree.push({ path: GALLERY_PATH, mode: '100644', type: 'blob', content: text });

    // Build the commit on top of the current branch head. If something
    // else (e.g. the artwork bot) moves the branch in between, rebuild on
    // the new head and try again rather than overwrite it.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await ghApi(env, 'GET', `/git/ref/heads/${GITHUB_BRANCH}`);
      const headSha = ref.object.sha;
      const headCommit = await ghApi(env, 'GET', `/git/commits/${headSha}`);
      const newTree = await ghApi(env, 'POST', '/git/trees', { base_tree: headCommit.tree.sha, tree });
      const commit = await ghApi(env, 'POST', '/git/commits', {
        message: 'Update gallery via /admin',
        tree: newTree.sha,
        parents: [headSha],
      });
      try {
        await ghApi(env, 'PATCH', `/git/refs/heads/${GITHUB_BRANCH}`, { sha: commit.sha, force: false });
        return json({ ok: true, sha: await gitBlobSha(text), content: finalContent });
      } catch (e) {
        lastErr = e;
        if (e.status !== 422) throw e; // 422 = not a fast-forward any more
      }
    }
    throw lastErr;
  } catch (e) {
    return json({ error: e.message || 'GitHub save failed' }, 502);
  }
}

// Public side: the gallery page's photos, rendered into its <div
// id="gallery"> server-side (see applyEntitySeo) from the deployed
// data/gallery.json.
async function readGalleryReadOnly(env) {
  try {
    const res = await env.ASSETS.fetch(new Request('https://internal/data/gallery.json'));
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

// Who a tagged name is on this site: a credited artist links to their
// artist page (and is the same MusicGroup entity as there), Meraj himself
// to the About page, Miragesohi to its page; any other name is shown
// without a link.
function buildGalleryPeopleIndex(creditsData) {
  const byKey = new Map();
  const add = (key, v) => { if (key && !byKey.has(key.trim().toLowerCase())) byKey.set(key.trim().toLowerCase(), v); };
  const me = { kind: 'person', en: 'Meraj Mirzaei', fa: 'معراج میرزایی', slug: 'about' };
  const mirage = { kind: 'mirage', en: 'Miragesohi', fa: 'Miragesohi', slug: 'miragesohi' };
  add('Meraj Mirzaei', me); add('معراج میرزایی', me);
  add('Miragesohi', mirage); add('MIRAGE', mirage);
  for (const e of titledEntriesFor(creditsData || [], 'credits')) {
    if (!e.artist_en || e.artist_en === 'Miragesohi') continue;
    const artistSlug = slugifyName(e.artist_en);
    const v = { kind: 'artist', en: e.artist_en, fa: e.artist_fa || e.artist_en, slug: 'credits/artist/' + artistSlug, artistSlug };
    add(e.artist_en, v);
    add(e.artist_fa, v);
  }
  return byKey;
}

function resolveGalleryPerson(name, lang, index) {
  const hit = index.get(String(name).trim().toLowerCase());
  if (!hit) return { label: String(name).trim(), href: null, hit: null };
  return { label: lang === 'fa' ? hit.fa : hit.en, href: pathFor(lang, hit.slug), hit };
}

function sortedGalleryItems(items) {
  return items
    .filter((e) => e && typeof e.src === 'string' && GALLERY_SRC_RE.test(e.src))
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Each page shows its own language's caption; if only one was written,
// both pages show that one.
function galleryCaption(e, lang) {
  const own = lang === 'fa' ? e.caption_fa : e.caption_en;
  const other = lang === 'fa' ? e.caption_en : e.caption_fa;
  return String(own || other || '').trim();
}

// The photo's text for Google and screen readers: who is in it, then the
// caption — e.g. "Kamyar, Meraj Mirzaei — In the studio, London".
function galleryAltText(e, lang, index) {
  const people = (Array.isArray(e.people) ? e.people : []).map((n) => resolveGalleryPerson(n, lang, index).label);
  const cap = galleryCaption(e, lang);
  const who = people.join(lang === 'fa' ? '، ' : ', ');
  return [who, cap].filter(Boolean).join(' — ') || (lang === 'fa' ? 'معراج میرزایی — گالری' : 'Meraj Mirzaei — gallery');
}

// Each photo's own page: /gallery/<file name without extension>, e.g.
// /gallery/kamyar-meraj-mirzaei-mun4r1rxmbn (see tryServeGalleryPhotoPage).
function galleryPhotoSlug(e) {
  return e.src.split('/').pop().replace(/\.(?:jpg|png|webp)$/, '');
}

function buildGalleryHtml(items, lang, index) {
  return sortedGalleryItems(items).map((e, i) => {
    const cap = galleryCaption(e, lang);
    const people = (Array.isArray(e.people) ? e.people : []).map((n) => resolveGalleryPerson(n, lang, index));
    const peopleHtml = people.length
      ? '<span class="people">' + people.map((p) => (p.href
        ? '<a href="' + escapeHtmlAttr(p.href) + '">' + escapeHtmlAttr(p.label) + '</a>'
        : '<span>' + escapeHtmlAttr(p.label) + '</span>')).join(' · ') + '</span>'
      : '';
    const href = pathFor(lang, 'gallery/' + galleryPhotoSlug(e));
    return '\n    <figure><a class="gal-open" href="' + escapeHtmlAttr(href) + '" data-i="' + i + '">'
      + '<img src="' + escapeHtmlAttr(e.src) + '" alt="' + escapeHtmlAttr(galleryAltText(e, lang, index)) + '"'
      + (i < 3 ? '' : ' loading="lazy"') + ' decoding="async"></a>'
      + (cap || peopleHtml ? '<figcaption>' + escapeHtmlAttr(cap) + peopleHtml + '</figcaption>' : '')
      + '</figure>';
  }).join('') + '\n  ';
}

// What the enlarge-and-zoom viewer (/gallery.js) needs, embedded in the
// page as JSON: every photo's image, its own page, caption and names.
function buildGalleryViewerJson(items, lang, index) {
  const data = {
    lang,
    items: sortedGalleryItems(items).map((e) => ({
      href: pathFor(lang, 'gallery/' + galleryPhotoSlug(e)),
      src: e.src,
      alt: galleryAltText(e, lang, index),
      caption: galleryCaption(e, lang),
      people: (Array.isArray(e.people) ? e.people : []).map((n) => {
        const p = resolveGalleryPerson(n, lang, index);
        return { label: p.label, href: p.href };
      }),
    })),
  };
  return '<script type="application/json" id="galleryData">'
    + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>\n';
}

const GALLERY_PHOTO_LABELS = {
  en: { gallery: 'Gallery', photo: 'Photo', prev: 'Previous', next: 'Next', featuring: 'Featuring', from: 'A photo from the Meraj Mirzaei gallery' },
  fa: { gallery: 'گالری', photo: 'عکس', prev: 'قبلی', next: 'بعدی', featuring: 'در این عکس', from: 'عکسی از گالری معراج میرزایی' },
};

function faDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

// Finds a photo by its page slug. A photo whose file was renamed (its
// names changed) is still found by the unique ending of its old name, so
// the caller can redirect old links to the new address.
function findGalleryPhoto(items, slug) {
  const list = sortedGalleryItems(items);
  let i = list.findIndex((e) => galleryPhotoSlug(e) === slug);
  if (i >= 0) return { list, i, exact: true };
  const suffix = slug.includes('-') ? slug.split('-').pop() : '';
  if (suffix.length >= 8) {
    i = list.findIndex((e) => {
      const own = galleryPhotoSlug(e);
      return own.includes('-') && own.split('-').pop() === suffix;
    });
    if (i >= 0) return { list, i, exact: false };
  }
  return null;
}

function galleryPhotoTexts(e, i, total, lang, index) {
  const L = GALLERY_PHOTO_LABELS[lang];
  const people = (Array.isArray(e.people) ? e.people : []).map((n) => resolveGalleryPerson(n, lang, index).label);
  const who = people.join(lang === 'fa' ? '، ' : ', ');
  const cap = galleryCaption(e, lang);
  const num = L.photo + ' ' + (lang === 'fa' ? faDigits(i + 1) : String(i + 1));
  const heading = [who, cap].filter(Boolean).join(' — ') || num;
  const title = (heading === num ? num : heading + ' — ' + num) + ' | ' + L.gallery + (who ? '' : ' — ' + (lang === 'fa' ? 'معراج میرزایی' : 'Meraj Mirzaei'));
  const description = L.from + (who ? ' — ' + L.featuring + ': ' + who : '') + (cap ? ' — ' + cap : '') + '.';
  return { heading, title, description, num };
}

function renderGalleryPhotoContent(list, i, lang, index) {
  const L = GALLERY_PHOTO_LABELS[lang];
  const e = list[i];
  const { heading } = galleryPhotoTexts(e, i, list.length, lang, index);
  const cap = galleryCaption(e, lang);
  const people = (Array.isArray(e.people) ? e.people : []).map((n) => resolveGalleryPerson(n, lang, index));
  const peopleHtml = people.length
    ? '<span class="people">' + people.map((p) => (p.href
      ? '<a href="' + escapeHtmlAttr(p.href) + '">' + escapeHtmlAttr(p.label) + '</a>'
      : '<span>' + escapeHtmlAttr(p.label) + '</span>')).join(' · ') + '</span>'
    : '';
  const self = pathFor(lang, 'gallery/' + galleryPhotoSlug(e));
  const prev = list[(i - 1 + list.length) % list.length];
  const next = list[(i + 1) % list.length];
  const count = lang === 'fa' ? faDigits(i + 1) + ' / ' + faDigits(list.length) : (i + 1) + ' / ' + list.length;
  const nav = list.length > 1
    ? '<nav class="gp-nav">'
      + '<a rel="prev" href="' + escapeHtmlAttr(pathFor(lang, 'gallery/' + galleryPhotoSlug(prev))) + '">' + (lang === 'fa' ? '› ' : '‹ ') + escapeHtmlAttr(L.prev) + '</a>'
      + '<span class="gp-count">' + count + '</span>'
      + '<a rel="next" href="' + escapeHtmlAttr(pathFor(lang, 'gallery/' + galleryPhotoSlug(next))) + '">' + escapeHtmlAttr(L.next) + (lang === 'fa' ? ' ‹' : ' ›') + '</a>'
      + '</nav>'
    : '';
  return `<main class="wrap">
<section class="gphoto">
  <div class="rail"><p class="eyebrow"><a href="${escapeHtmlAttr(pathFor(lang, 'gallery'))}">${lang === 'fa' ? '› ' : '‹ '}${escapeHtmlAttr(L.gallery)}</a></p><div class="ticks"></div><div class="peak"></div></div>
  <h1 class="gp-h">${escapeHtmlAttr(heading)}</h1>
  <figure class="gp-fig">
    <a class="gal-open" href="${escapeHtmlAttr(self)}" data-i="${i}"><img src="${escapeHtmlAttr(e.src)}" alt="${escapeHtmlAttr(galleryAltText(e, lang, index))}" decoding="async"></a>
    ${cap || peopleHtml ? '<figcaption>' + escapeHtmlAttr(cap) + peopleHtml + '</figcaption>' : ''}
  </figure>
  ${nav}
</section>
</main>`;
}

// Structured data for the gallery page: every photo as an ImageObject that
// names who is in it, pointing at the same entities the rest of the site
// uses (the Person, Miragesohi, and each artist's MusicGroup).
function buildGalleryImageGraph(items, lang, index) {
  const extraNodes = new Map();
  const images = sortedGalleryItems(items).map((e) => {
    const node = {
      '@type': 'ImageObject',
      contentUrl: SITE_ORIGIN + e.src,
      url: SITE_ORIGIN + e.src,
      name: galleryAltText(e, lang, index),
    };
    const cap = galleryCaption(e, lang);
    if (cap) node.caption = cap;
    const about = [];
    for (const n of Array.isArray(e.people) ? e.people : []) {
      const p = resolveGalleryPerson(n, lang, index);
      if (p.hit && p.hit.kind === 'person') about.push({ '@id': PERSON_ID });
      else if (p.hit && p.hit.kind === 'mirage') about.push({ '@id': MIRAGE_ID });
      else if (p.hit) {
        const id = SITE_ORIGIN + '/credits#artist-' + p.hit.artistSlug;
        if (!extraNodes.has(id)) {
          const g = { '@type': 'MusicGroup', '@id': id, name: p.hit.en, url: SITE_ORIGIN + pathFor(lang, p.hit.slug) };
          if (p.hit.fa && p.hit.fa !== p.hit.en) g.alternateName = p.hit.fa;
          extraNodes.set(id, g);
        }
        about.push({ '@id': id });
      } else {
        about.push({ '@type': 'Person', name: p.label });
      }
    }
    if (about.length) node.about = about;
    return node;
  });
  return { images, extraNodes: [...extraNodes.values()] };
}

// ---------------------------------------------------------------------
// homepage "New Release" video player — playlist data + video uploads.
//
// The playlist itself is a small JSON file in the repo like every other
// piece of site data. A video can be either a YouTube link or a file
// uploaded from the admin panel; uploaded files go to a GitHub release
// (MEDIA_RELEASE_TAG) rather than into the repo, because the repo is what
// Cloudflare deploys and it rejects any single static file over 25 MiB.
// ---------------------------------------------------------------------

const ALLOWED_VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
// Cloudflare accepts request bodies up to 100 MB on this plan; stay under.
const MAX_VIDEO_BYTES = 95 * 1024 * 1024;
// .mov files are served as video/mp4: an H.264 .mov is the same ISO media
// container underneath, and Chrome/Firefox only play it when told "mp4".
const VIDEO_MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/mp4', webm: 'video/webm' };
const MEDIA_ROUTE_RE = /^\/media\/(\d{1,15})\/([a-z0-9][a-z0-9-]{0,80})\.(mp4|mov|webm)$/;
// release_id: the credits.json id of the song on the Releases page that
// the video (and its name) links to.
const NR_STRING_FIELDS = ['id', 'release_id', 'title_en', 'title_fa', 'youtube_url', 'video_url'];

function youtubeIdFrom(url) {
  const m = String(url || '').match(
    /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function validateNewReleases(data) {
  if (!Array.isArray(data)) return 'data must be an array';
  if (data.length > 200) return 'too many videos';
  for (let i = 0; i < data.length; i++) {
    const e = data[i];
    const label = `Video ${i + 1}` + (e && e.title_en ? ` ("${e.title_en}")` : '');
    if (!e || typeof e !== 'object') return `${label} is not an object`;
    for (const f of NR_STRING_FIELDS) {
      if (e[f] != null && typeof e[f] !== 'string') return `${label}: ${f} must be text`;
      if (e[f] && e[f].length > 500) return `${label}: ${f} is too long`;
    }
    if (e.order != null && typeof e.order !== 'number') return `${label}: order must be a number`;
    if (e.youtube_url && !youtubeIdFrom(e.youtube_url)) return `${label}: that doesn't look like a YouTube link`;
    if (e.video_url && !MEDIA_ROUTE_RE.test(e.video_url)) return `${label}: invalid uploaded video path`;
    if (!e.youtube_url && !e.video_url) return `${label} has no video yet — upload a file or paste a YouTube link`;
  }
  return null;
}

async function handleGetNewReleases(env) {
  const file = await ghGetFile(env, NEW_RELEASES_PATH);
  if (!file) return json({ data: [], sha: null });
  const content = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return json({ error: 'data/new-releases.json is not valid JSON: ' + e.message }, 500);
  }
  return json({ data, sha: file.sha });
}

async function handleSaveNewReleases(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request body' }, 400);
  const { content, sha } = body;
  const invalid = validateNewReleases(content);
  if (invalid) return json({ error: invalid }, 400);

  const text = JSON.stringify(content, null, 2) + '\n';
  try {
    const result = await ghPutFile(
      env,
      NEW_RELEASES_PATH,
      base64FromUtf8(text),
      sha || undefined,
      `Update New Release videos via /admin`
    );
    return json({ ok: true, sha: result.content && result.content.sha });
  } catch (e) {
    if (e.status === 409) {
      return json({ error: 'Someone else saved changes since you loaded this page. Reload and try again.' }, 409);
    }
    return json({ error: e.message || 'GitHub save failed' }, 502);
  }
}

// Finds (or, on the very first upload, creates) the GitHub release that
// holds uploaded videos. A published pre-release rather than a draft: a
// draft's assets can't be looked up by tag.
async function ghEnsureMediaRelease(env) {
  const base = `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
  const lookup = async () => {
    const res = await fetch(`${base}/releases/tags/${MEDIA_RELEASE_TAG}`, { headers: ghHeaders(env) });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    throw new Error(`GitHub release lookup failed: ${res.status}`);
  };
  const existing = await lookup();
  if (existing) return existing;
  const res = await fetch(`${base}/releases`, {
    method: 'POST',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: MEDIA_RELEASE_TAG,
      target_commitish: GITHUB_BRANCH,
      name: 'Site media (homepage New Release videos)',
      body: 'Video files uploaded from merajmirzaei.com/admin for the homepage "New Release" player. '
        + 'Managed by the admin panel: deleting an asset here breaks that video on the site.',
      prerelease: true,
    }),
  });
  if (res.ok) return res.json();
  // Two uploads racing to create it: the other one won, so just use it.
  if (res.status === 422) {
    const again = await lookup();
    if (again) return again;
  }
  const j = await res.json().catch(() => ({}));
  throw new Error(j.message || `GitHub release create failed: ${res.status}`);
}

// The browser sends the raw file as the request body (no base64/JSON
// wrapping — videos are large), streamed straight through to GitHub.
async function handleUploadVideo(request, env) {
  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED_VIDEO_TYPES[mime];
  if (!ext) return json({ error: 'Unsupported video type. Use MP4 (recommended), MOV or WebM.' }, 400);
  const size = Number(request.headers.get('Content-Length'));
  if (!size || !request.body) return json({ error: 'Missing video data' }, 400);
  if (size > MAX_VIDEO_BYTES) return json({ error: 'Video too large (max 95 MB).' }, 413);

  let hint = '';
  try { hint = decodeURIComponent(request.headers.get('X-Filename-Hint') || ''); } catch (e) { hint = ''; }
  // (A Farsi-only title slugs down to nothing, hence the fallback.)
  const slug = String(hint).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video';
  const name = `${slug}-${Date.now().toString(36)}.${ext}`;

  try {
    const release = await ghEnsureMediaRelease(env);
    const uploadBase = String(release.upload_url || '').replace(/\{.*$/, '');
    if (!uploadBase) throw new Error('GitHub release has no upload URL');
    // FixedLengthStream makes the outgoing request carry a real
    // Content-Length (GitHub's upload endpoint requires one) while still
    // streaming, so a large video never has to fit in Worker memory.
    const { readable, writable } = new FixedLengthStream(size);
    const piping = request.body.pipeTo(writable).catch(() => {});
    const res = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...ghHeaders(env), 'Content-Type': mime },
      body: readable,
    });
    await piping;
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.id) {
      return json({ error: j.message || `GitHub upload failed (${res.status})` }, 502);
    }
    return json({ ok: true, path: `/media/${j.id}/${name}`, size: j.size || size });
  } catch (e) {
    return json({ error: e.message || 'Upload failed' }, 502);
  }
}

// Public: /media/<asset id>/<name>. Resolves the release asset's
// short-lived signed download URL and streams it with a proper video
// Content-Type and byte-range support (video players seek with Range
// requests). The whole file is also copied into Cloudflare's edge cache in
// the background, so after the first view it plays from Cloudflare, not
// GitHub.
async function serveMedia(request, env, ctx, match) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const assetId = match[1];
  const contentType = VIDEO_MIME_BY_EXT[match[3]];
  const isHead = request.method === 'HEAD';
  const url = new URL(request.url);
  const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
  const range = request.headers.get('Range');
  const rangeHeaders = range ? { Range: range } : {};
  const cache = (typeof caches !== 'undefined' && caches.default) || null;

  if (cache) {
    const hit = await cache.match(new Request(cacheKey.url, { method: 'GET', headers: rangeHeaders })).catch(() => undefined);
    if (hit) return isHead ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
  }

  const apiRes = await fetch(`${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${assetId}`, {
    headers: { ...ghHeaders(env), Accept: 'application/octet-stream' },
    redirect: 'manual',
  });
  if (apiRes.status === 404) return new Response('Not found', { status: 404 });
  const upstreamUrl = apiRes.status >= 300 && apiRes.status < 400 ? apiRes.headers.get('Location') : null;
  if (!upstreamUrl) return new Response('Video temporarily unavailable', { status: 502 });

  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'X-Robots-Tag': 'noindex',
  };

  if (cache && ctx && ctx.waitUntil) {
    ctx.waitUntil((async () => {
      const full = await fetch(upstreamUrl);
      if (full.status !== 200) return;
      const headers = new Headers(baseHeaders);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      const len = full.headers.get('Content-Length');
      if (len) headers.set('Content-Length', len);
      await cache.put(cacheKey, new Response(full.body, { status: 200, headers }));
    })().catch(() => {}));
  }

  const direct = await fetch(upstreamUrl, { method: isHead ? 'HEAD' : 'GET', headers: rangeHeaders });
  if (direct.status !== 200 && direct.status !== 206) {
    return new Response('Video temporarily unavailable', { status: 502 });
  }
  const headers = new Headers(baseHeaders);
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = direct.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(isHead ? null : direct.body, { status: direct.status, headers });
}

// ---------------------------------------------------------------------
// Song comments on the homepage "New Release" player.
//
// A visitor leaves a name + comment on the song that's playing. It waits
// in a queue until approved on the admin panel's "Comments" tab, and only
// then floats over that song's video for everyone. Stored in Workers KV
// (binding COMMENTS — see wrangler.toml):
//   p:<id>               a comment waiting for approval
//   a:<song>:<id>        an approved comment; the record is also kept as
//                        the key's metadata, so one list() call returns a
//                        song's comments without a read per comment
//   rl:<visitor hash>    one-minute marker that rate-limits posting
// <song> is the video's release_id (its song page), or "nr:<video id>" for
// a video not linked to a song page.
// ---------------------------------------------------------------------

const COMMENT_SONG_RE = /^[a-z0-9][a-z0-9:_-]{0,120}$/;
const COMMENT_ID_RE = /^[a-z0-9]{6,12}-[a-z0-9]{4,8}$/;
const COMMENTS_PER_SONG_MAX = 200;

function cleanCommentText(s, maxChars, maxBytes) {
  let out = String(s == null ? '' : s)
    // (keeps U+200C, the Persian half-space, and U+200D used inside emoji)
    .replace(/[\u0000-\u001F\u007F\u200B\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  out = Array.from(out).slice(0, maxChars).join('');
  // Keep every record well inside KV's 1 KB metadata limit.
  const enc = new TextEncoder();
  while (out && enc.encode(out).length > maxBytes) out = Array.from(out).slice(0, -1).join('');
  return out;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The songs that can be commented on: exactly the videos in the playlist.
async function commentableSongs(env) {
  const res = await env.ASSETS.fetch(new Request('https://internal/data/new-releases.json'));
  if (!res.ok) return new Set();
  const list = await res.json().catch(() => []);
  const songs = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    if (!it) continue;
    if (it.release_id) songs.add(String(it.release_id));
    if (it.id) songs.add('nr:' + String(it.id));
  }
  return songs;
}

function commentsCacheKey(origin, song) {
  return new Request(`${origin}/api/comments?song=${encodeURIComponent(song)}`, { method: 'GET' });
}

async function handlePostComment(request, env) {
  if (!env.COMMENTS) return json({ error: 'Comments are not available yet.', code: 'unavailable' }, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);
  // Bots: a filled-in hidden field, or a form sent within 2 s of appearing.
  // Pretend it worked so they don't learn anything.
  if (body.website) return json({ ok: true, pending: true });
  if (typeof body.elapsed === 'number' && body.elapsed < 2000) return json({ ok: true, pending: true });

  const song = String(body.song || '');
  if (!COMMENT_SONG_RE.test(song)) return json({ error: 'Invalid song' }, 400);
  const name = cleanCommentText(body.name, 40, 120);
  const text = cleanCommentText(body.text, 200, 600);
  if (!name) return json({ error: 'Please write your name.', code: 'name' }, 400);
  if (!text) return json({ error: 'Please write a comment.', code: 'text' }, 400);
  if (/(https?:\/\/|www\.|\.com\b|\.ir\b)/i.test(name + ' ' + text)) {
    return json({ error: 'Links are not allowed in comments.', code: 'links' }, 400);
  }
  if (!(await commentableSongs(env)).has(song)) return json({ error: 'Invalid song' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = 'rl:' + (await sha256Hex('comment|' + ip)).slice(0, 32);
  if (await env.COMMENTS.get(rlKey)) {
    return json({ error: 'Please wait a minute before commenting again.', code: 'rate' }, 429);
  }

  const ts = Date.now();
  const id = ts.toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(4, '0').slice(0, 8);
  const rec = { id, song, name, text, ts, lang: body.lang === 'fa' ? 'fa' : 'en' };
  await env.COMMENTS.put('p:' + id, JSON.stringify(rec), { metadata: rec });
  await env.COMMENTS.put(rlKey, '1', { expirationTtl: 60 });
  return json({ ok: true, pending: true });
}

async function handleGetComments(request, env, ctx) {
  const url = new URL(request.url);
  const song = url.searchParams.get('song') || '';
  if (!COMMENT_SONG_RE.test(song)) return json({ error: 'Invalid song' }, 400);
  if (!env.COMMENTS) return json({ comments: [] });

  const cache = (typeof caches !== 'undefined' && caches.default) || null;
  const key = commentsCacheKey(url.origin, song);
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return hit;
  }
  const listed = await env.COMMENTS.list({ prefix: `a:${song}:`, limit: COMMENTS_PER_SONG_MAX });
  const comments = listed.keys
    .map((k) => k.metadata)
    .filter((m) => m && m.text)
    .sort((a, b) => a.ts - b.ts)
    .map((m) => ({ name: m.name, text: m.text, ts: m.ts }));
  const res = new Response(JSON.stringify({ comments }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
  });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

async function handleAdminListComments(env) {
  if (!env.COMMENTS) return json({ error: 'Comments storage is not connected yet.', code: 'unavailable' }, 503);
  const [pending, approved] = await Promise.all([
    env.COMMENTS.list({ prefix: 'p:', limit: 1000 }),
    env.COMMENTS.list({ prefix: 'a:', limit: 1000 }),
  ]);
  const shape = (k) => (k.metadata ? { key: k.name, ...k.metadata } : null);
  const newestFirst = (a, b) => b.ts - a.ts;
  return json({
    pending: pending.keys.map(shape).filter(Boolean).sort(newestFirst),
    approved: approved.keys.map(shape).filter(Boolean).sort(newestFirst),
  });
}

async function handleAdminApproveComment(request, env) {
  if (!env.COMMENTS) return json({ error: 'Comments storage is not connected yet.' }, 503);
  const body = await request.json().catch(() => null);
  const id = body && String(body.id || '');
  if (!id || !COMMENT_ID_RE.test(id)) return json({ error: 'Invalid comment' }, 400);
  const raw = await env.COMMENTS.get('p:' + id);
  if (!raw) return json({ error: 'That comment is no longer waiting — reload the page.' }, 404);
  const rec = JSON.parse(raw);
  if (!COMMENT_SONG_RE.test(rec.song || '')) return json({ error: 'Invalid comment' }, 400);
  await env.COMMENTS.put(`a:${rec.song}:${id}`, JSON.stringify(rec), { metadata: rec });
  await env.COMMENTS.delete('p:' + id);
  const cache = (typeof caches !== 'undefined' && caches.default) || null;
  if (cache) await cache.delete(commentsCacheKey(new URL(request.url).origin, rec.song)).catch(() => {});
  return json({ ok: true });
}

async function handleAdminDeleteComment(request, env) {
  if (!env.COMMENTS) return json({ error: 'Comments storage is not connected yet.' }, 503);
  const body = await request.json().catch(() => null);
  const key = body && String(body.key || '');
  const m = /^(p:|a:([a-z0-9][a-z0-9:_-]{0,120}):)([a-z0-9]{6,12}-[a-z0-9]{4,8})$/.exec(key);
  if (!m) return json({ error: 'Invalid comment' }, 400);
  await env.COMMENTS.delete(key);
  const cache = (typeof caches !== 'undefined' && caches.default) || null;
  if (cache && m[2]) await cache.delete(commentsCacheKey(new URL(request.url).origin, m[2])).catch(() => {});
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Collaboration submissions — the /collaborate page's form.
//
// Poets, composers and mix/master clients send their work from there.
// Everything they send is private: it's stored in the same Workers KV
// namespace as the song comments (binding COMMENTS), never in this repo
// (which is public), and it can only be read on the admin panel's
// "Submissions" tab. Keys:
//   s:<id>               the submission (JSON); a short summary is also
//                        kept as the key's metadata
//   sf:<id>:<n>          attached file n (raw bytes; name/type/size in
//                        the metadata)
//   rl:collab:<hash>     one-minute marker that rate-limits sending
//   collab:mailstatus    how the last notification email went — shown on
//                        the admin tab, so a broken email setup is visible
// Every new submission is also emailed to the site owner through the
// SEND_EMAIL binding (Cloudflare Email Routing — see wrangler.toml). The
// email is best-effort: a submission is saved whether or not it's sent.
// ---------------------------------------------------------------------

const COLLAB_ROLES = ['poet', 'composer', 'mix'];
const COLLAB_SERVICES = ['mix', 'master', 'mixmaster'];
const COLLAB_ID_RE = /^[a-z0-9]{6,12}-[a-z0-9]{4,8}$/;
const COLLAB_MAX_FILES = 3;
// All files of one submission together. Each file is one KV value, and
// KV's per-value limit is 25 MiB, so this keeps every file inside it.
const COLLAB_MAX_BYTES = 25 * 1000 * 1000;
// Files are attached to the notification email up to this total; above
// it the email just points to the admin panel (Gmail's own cap is 25 MB,
// and base64 makes an attachment a third bigger).
const COLLAB_EMAIL_ATTACH_MAX = 15 * 1000 * 1000;
const COLLAB_NOTIFY_TO = 'merajmusic2@gmail.com';
const COLLAB_NOTIFY_FROM = 'site@merajmirzaei.com';
// Accepted by file extension; the stored/served Content-Type always comes
// from this table, never from what the browser claimed (so nothing
// uploaded can ever be served back as HTML or script).
const COLLAB_FILE_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  ogg: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
};
const COLLAB_ROLE_FA = { poet: 'شاعر', composer: 'آهنگساز', mix: 'میکس و مستر' };
const COLLAB_SERVICE_FA = { mix: 'میکس', master: 'مسترینگ', mixmaster: 'میکس و مستر' };

// One line of text: control characters out, whitespace collapsed.
function collabLine(s, maxChars) {
  const out = String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F​﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(out).slice(0, maxChars).join('');
}

// Multi-line text (lyrics, description): line breaks kept.
function collabText(s, maxChars) {
  const out = String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    // (keeps U+200C, the Persian half-space)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return Array.from(out).slice(0, maxChars).join('');
}

function collabFileName(name, ext) {
  let base = String(name || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001F\u007F"<>|:*?]/g, '')
    .trim();
  if (!base) base = 'file.' + ext;
  const arr = Array.from(base);
  return arr.length > 120 ? arr.slice(0, 110).join('') + '.' + ext : base;
}

function collabSummary(rec) {
  return {
    id: rec.id, ts: rec.ts, role: rec.role, service: rec.service || '',
    name: Array.from(rec.name || '').slice(0, 60).join(''),
    files: (rec.files || []).length, read: !!rec.read,
  };
}

function collabError(code, message, status = 400) {
  return json({ error: message, code }, status);
}

async function handlePostCollab(request, env, ctx) {
  if (!env.COMMENTS) return collabError('unavailable', 'Sending is not available right now.', 503);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > COLLAB_MAX_BYTES + 2 * 1000 * 1000) {
    return collabError('size', 'Files are too big (25 MB in total at most).', 413);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return collabError('invalid', 'Invalid request');
  }
  // Bots: a filled-in hidden field, or a form sent within 3 s of the page
  // opening. Pretend it worked so they don't learn anything.
  if (form.get('website')) return json({ ok: true });
  const elapsed = Number(form.get('elapsed'));
  if (Number.isFinite(elapsed) && elapsed < 3000) return json({ ok: true });

  const role = String(form.get('role') || '');
  if (!COLLAB_ROLES.includes(role)) return collabError('role', 'Choose poet, composer or mix & master.');
  const lang = form.get('lang') === 'fa' ? 'fa' : 'en';
  const name = collabLine(form.get('name'), 80);
  const email = collabLine(form.get('email'), 120);
  const phone = collabLine(form.get('phone'), 60);
  const lyrics = role === 'poet' ? collabText(form.get('lyrics'), 20000) : '';
  const description = collabText(form.get('description'), 5000);
  const serviceRaw = String(form.get('service') || '');
  const service = role === 'mix' && COLLAB_SERVICES.includes(serviceRaw) ? serviceRaw : '';
  const viaTelegram = role === 'mix' && form.get('telegram') === '1';
  const termsAccepted = form.get('terms') === '1';

  let link = collabLine(form.get('link'), 500);
  if (link) {
    if (!/^https?:\/\//i.test(link)) link = 'https://' + link;
    let parsed = null;
    try { parsed = new URL(link); } catch (e) { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) {
      return collabError('link', 'That link doesn\'t look right.');
    }
    link = parsed.href;
  }

  if (!name) return collabError('name', 'Please write your name.');
  if (!email && !phone) return collabError('contact', 'Please leave an email or a phone number.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return collabError('email', 'That email doesn\'t look right.');
  if (role === 'mix' && !termsAccepted) return collabError('terms', 'Please accept the terms.');

  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
  if (files.length > COLLAB_MAX_FILES) return collabError('files_count', 'Up to 3 files.');
  const fileRecs = [];
  let total = 0;
  for (const f of files) {
    const m = /\.([a-z0-9]{1,5})$/.exec(String(f.name || '').toLowerCase());
    const ext = m ? m[1] : '';
    if (!COLLAB_FILE_TYPES[ext]) return collabError('file_type', 'That file type isn\'t accepted.');
    total += f.size;
    fileRecs.push({ name: collabFileName(f.name, ext), type: COLLAB_FILE_TYPES[ext], size: f.size, file: f });
  }
  if (total > COLLAB_MAX_BYTES) return collabError('size', 'Files are too big (25 MB in total at most).', 413);

  const hasWork = role === 'poet' ? !!(lyrics || fileRecs.length)
    : role === 'composer' ? !!(fileRecs.length || link)
      : !!(fileRecs.length || link || viaTelegram);
  if (!hasWork) return collabError('work', 'Please add your work.');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = 'rl:collab:' + (await sha256Hex('collab|' + ip)).slice(0, 32);
  if (await env.COMMENTS.get(rlKey)) return collabError('rate', 'Please wait a minute before sending again.', 429);

  const ts = Date.now();
  const id = ts.toString(36) + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(4, '0').slice(0, 8);
  const buffers = [];
  for (let i = 0; i < fileRecs.length; i++) {
    const fr = fileRecs[i];
    const buf = await fr.file.arrayBuffer();
    buffers.push(buf);
    await env.COMMENTS.put(`sf:${id}:${i}`, buf, { metadata: { name: fr.name, type: fr.type, size: fr.size } });
  }
  const rec = {
    id, ts, role, lang, service, name, email, phone, link, viaTelegram, termsAccepted,
    lyrics, description,
    files: fileRecs.map(({ name: n, type, size }) => ({ name: n, type, size })),
    read: false,
  };
  await env.COMMENTS.put('s:' + id, JSON.stringify(rec), { metadata: collabSummary(rec) });
  await env.COMMENTS.put(rlKey, '1', { expirationTtl: 60 });

  const notify = notifyCollab(env, rec, buffers);
  if (ctx && ctx.waitUntil) ctx.waitUntil(notify);
  else await notify;
  return json({ ok: true });
}

// --- notification email -------------------------------------------------

function collabEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function mimeLines(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

// RFC 2047 header text: plain ASCII as-is, anything else as UTF-8
// base64 "encoded words", split into short pieces (a header line and
// each encoded word have length limits).
function mimeHeaderText(str) {
  const s = String(str);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const chars = Array.from(s);
  const words = [];
  for (let i = 0; i < chars.length; i += 12) {
    words.push('=?UTF-8?B?' + base64FromUtf8(chars.slice(i, i + 12).join('')) + '?=');
  }
  return words.join('\r\n ');
}

// Content-Type name= / Content-Disposition filename= for an attachment.
function mimeFileParam(param, name) {
  if (/^[\x20-\x7e]*$/.test(name) && !name.includes('"')) return param + '="' + name + '"';
  return param + '="=?UTF-8?B?' + base64FromUtf8(name) + '?="'
    + (param === 'filename' ? '; filename*=UTF-8\'\'' + encodeURIComponent(name) : '');
}

function formatSize(bytes) {
  return bytes >= 1000 * 1000 ? (bytes / 1000 / 1000).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1000)) + ' KB';
}

function buildCollabEmail(rec, attachments) {
  const roleFa = COLLAB_ROLE_FA[rec.role] || rec.role;
  const subject = (rec.role === 'mix' ? 'درخواست ' : 'همکاری تازه: ') + (rec.role === 'mix' ? (COLLAB_SERVICE_FA[rec.service] || roleFa) : roleFa) + ' — ' + rec.name;
  const adminUrl = SITE_ORIGIN + '/admin#submissions';
  const filesLine = rec.files.length
    ? rec.files.map((f) => f.name + ' (' + formatSize(f.size) + ')').join('، ')
      + (attachments.length ? ' — پیوست همین ایمیل' : ' — در پنل ادمین')
    : '';
  const rows = [
    ['نوع', roleFa + (rec.service ? ' — ' + (COLLAB_SERVICE_FA[rec.service] || rec.service) : '')],
    ['نام', rec.name],
    ['ایمیل', rec.email],
    ['تلفن / تلگرام', rec.phone],
    ['لینک', rec.link],
    ['تلگرام', rec.viaTelegram ? 'پروژه را در تلگرام می‌فرستد' : ''],
    ['فایل‌ها', filesLine],
  ].filter((r) => r[1]);

  const text = [subject, '']
    .concat(rows.map((r) => r[0] + ': ' + r[1]))
    .concat(rec.description ? ['', 'توضیحات:', rec.description] : [])
    .concat(rec.lyrics ? ['', 'متن شعر:', rec.lyrics] : [])
    .concat(['', 'پنل ادمین: ' + adminUrl])
    .join('\n');

  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e2dc;vertical-align:top';
  const block = (title, body) => body
    ? '<h3 style="font-size:14px;margin:18px 0 6px;color:#8a7650">' + collabEsc(title) + '</h3>'
      + '<div style="white-space:pre-wrap;line-height:1.9;background:#f7f5f1;border-radius:4px;padding:10px 12px">' + collabEsc(body) + '</div>'
    : '';
  const htmlBody = '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:14px;color:#1b1b1b;max-width:620px">'
    + '<h2 style="font-size:17px;margin:0 0 12px">' + collabEsc(subject) + '</h2>'
    + '<table style="border-collapse:collapse;width:100%">'
    + rows.map((r) => '<tr><td style="' + cell + ';color:#777;white-space:nowrap">' + collabEsc(r[0]) + '</td><td style="' + cell + '" dir="auto">'
      + (r[0] === 'لینک' ? '<a href="' + collabEsc(r[1]) + '">' + collabEsc(r[1]) + '</a>'
        : r[0] === 'ایمیل' ? '<a href="mailto:' + collabEsc(r[1]) + '">' + collabEsc(r[1]) + '</a>'
          : collabEsc(r[1]))
      + '</td></tr>').join('')
    + '</table>'
    + block('توضیحات', rec.description)
    + block('متن شعر', rec.lyrics)
    + '<p style="margin:22px 0 0"><a href="' + adminUrl + '" style="display:inline-block;background:#C2A878;color:#0B0D10;text-decoration:none;padding:10px 16px;border-radius:3px">باز کردن در پنل ادمین</a></p>'
    + '</div>';

  const boundary = 'mm-' + rec.id + '-' + Math.random().toString(36).slice(2, 10);
  const alt = boundary + '-alt';
  const headers = [
    'From: "merajmirzaei.com" <' + COLLAB_NOTIFY_FROM + '>',
    'To: <' + COLLAB_NOTIFY_TO + '>',
  ];
  if (rec.email) headers.push('Reply-To: <' + rec.email.replace(/[<>\r\n]/g, '') + '>');
  headers.push(
    'Subject: ' + mimeHeaderText(subject),
    'Date: ' + new Date(rec.ts).toUTCString(),
    'Message-ID: <' + rec.id + '.' + Date.now().toString(36) + '@merajmirzaei.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  );
  const parts = [
    headers.join('\r\n'),
    '',
    '--' + boundary,
    'Content-Type: multipart/alternative; boundary="' + alt + '"',
    '',
    '--' + alt,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    mimeLines(base64FromUtf8(text)),
    '--' + alt,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    mimeLines(base64FromUtf8(htmlBody)),
    '--' + alt + '--',
  ];
  attachments.forEach((buf, i) => {
    const f = rec.files[i];
    parts.push(
      '--' + boundary,
      'Content-Type: ' + f.type.split(';')[0] + '; ' + mimeFileParam('name', f.name),
      'Content-Disposition: attachment; ' + mimeFileParam('filename', f.name),
      'Content-Transfer-Encoding: base64',
      '',
      mimeLines(bufferToBase64(buf)),
    );
  });
  parts.push('--' + boundary + '--', '');
  return parts.join('\r\n');
}

async function sendCollabEmail(env, rec, attachments) {
  const raw = buildCollabEmail(rec, attachments);
  await env.SEND_EMAIL.send(new EmailMessage(COLLAB_NOTIFY_FROM, COLLAB_NOTIFY_TO, raw));
}

async function notifyCollab(env, rec, buffers) {
  let status;
  try {
    if (!env.SEND_EMAIL) throw new Error('The SEND_EMAIL binding is not set up');
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const attach = total <= COLLAB_EMAIL_ATTACH_MAX ? buffers : [];
    try {
      await sendCollabEmail(env, rec, attach);
    } catch (err) {
      if (!attach.length) throw err;
      // Maybe the attachments were the problem: still get the news out.
      await sendCollabEmail(env, rec, []);
    }
    status = { ok: true, ts: Date.now() };
  } catch (err) {
    console.error('collab notification email failed', (err && err.stack) || err);
    status = { ok: false, ts: Date.now(), error: String((err && err.message) || err).slice(0, 300) };
  }
  await env.COMMENTS.put('collab:mailstatus', JSON.stringify(status)).catch(() => {});
}

// --- admin: Submissions tab -----------------------------------------------

async function handleAdminListSubmissions(env) {
  if (!env.COMMENTS) return json({ error: 'Storage is not connected yet.', code: 'unavailable' }, 503);
  const listed = await env.COMMENTS.list({ prefix: 's:', limit: 1000 });
  const keys = listed.keys
    .slice()
    .sort((a, b) => ((b.metadata && b.metadata.ts) || 0) - ((a.metadata && a.metadata.ts) || 0))
    .slice(0, 300);
  const [recs, mail] = await Promise.all([
    Promise.all(keys.map((k) => env.COMMENTS.get(k.name, 'json').catch(() => null))),
    env.COMMENTS.get('collab:mailstatus', 'json').catch(() => null),
  ]);
  return json({
    submissions: recs.filter(Boolean).sort((a, b) => b.ts - a.ts),
    mail,
    emailConfigured: !!env.SEND_EMAIL,
  });
}

// The attached file itself (played/viewed/downloaded from the admin tab).
// Range requests are honoured so the audio player can seek.
async function handleAdminSubmissionFile(request, env) {
  if (!env.COMMENTS) return new Response('Not available', { status: 503 });
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const n = url.searchParams.get('n') || '';
  if (!COLLAB_ID_RE.test(id) || !/^[0-9]$/.test(n)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.COMMENTS.getWithMetadata(`sf:${id}:${n}`, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  const meta = metadata || {};
  const type = Object.values(COLLAB_FILE_TYPES).includes(meta.type) ? meta.type : 'application/octet-stream';
  const name = String(meta.name || 'file');
  const disposition = (url.searchParams.get('dl') === '1' ? 'attachment' : 'inline')
    + '; filename="' + name.replace(/[^\x20-\x7e]|"/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
  const headers = {
    'Content-Type': type,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'X-Robots-Tag': 'noindex',
  };
  const size = value.byteLength;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (range && (range[1] || range[2])) {
    let start;
    let end;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    return new Response(value.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(value, { headers: { ...headers, 'Content-Length': String(size) } });
}

async function handleAdminMarkSubmission(request, env) {
  if (!env.COMMENTS) return json({ error: 'Storage is not connected yet.' }, 503);
  const body = await request.json().catch(() => null);
  const id = body && String(body.id || '');
  if (!id || !COLLAB_ID_RE.test(id)) return json({ error: 'Invalid submission' }, 400);
  const rec = await env.COMMENTS.get('s:' + id, 'json');
  if (!rec) return json({ error: 'That submission is gone — reload the page.' }, 404);
  rec.read = !!body.read;
  await env.COMMENTS.put('s:' + id, JSON.stringify(rec), { metadata: collabSummary(rec) });
  return json({ ok: true });
}

async function handleAdminDeleteSubmission(request, env) {
  if (!env.COMMENTS) return json({ error: 'Storage is not connected yet.' }, 503);
  const body = await request.json().catch(() => null);
  const id = body && String(body.id || '');
  if (!id || !COLLAB_ID_RE.test(id)) return json({ error: 'Invalid submission' }, 400);
  const deletes = [];
  for (let i = 0; i < COLLAB_MAX_FILES; i++) deletes.push(env.COMMENTS.delete(`sf:${id}:${i}`));
  await Promise.all(deletes);
  await env.COMMENTS.delete('s:' + id);
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// crawlable artist index on the credits hub.
//
// Until now the only links from the credits hub down to the per-artist
// pages (and through them to the ~182 recording pages) were written by
// credits-render.js *after* the page loads, and they pointed at
// /credits?artist=<slug> rather than at the real /credits/artist/<slug>
// page. In the HTML a crawler actually receives, every artist page and
// every recording page was therefore an orphan: present in sitemap.xml,
// linked from nowhere. That is exactly the shape Search Console reports
// as "Discovered - currently not indexed".
//
// This injects a real, visible, server-rendered <a> per artist into the
// hub itself, built from the same live data/credits.json everything else
// on this page uses, so it can never drift from the sitemap.
// ---------------------------------------------------------------------

const ARTIST_INDEX_LABELS = {
  en: { heading: 'Artists', intro: 'Every artist with a credit on this sheet — each name opens that artist\u2019s own page.' },
  fa: { heading: 'آرتیست‌ها', intro: 'همهٔ آرتیست‌هایی که در این کارنامه کردیتی دارند — هر نام، صفحهٔ همان آرتیست را باز می‌کند.' },
};

async function buildArtistIndexHtml(env, lang) {
  const creditsData = await readCreditsReadOnly(env);
  if (!creditsData) return null;

  const bySlug = new Map();
  for (const entry of titledEntriesFor(creditsData, 'credits')) {
    if (!entry.artist_en || entry.artist_en === 'Miragesohi') continue;
    const slug = slugifyName(entry.artist_en);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        slug,
        label: lang === 'fa' ? (entry.artist_fa || entry.artist_en) : entry.artist_en,
        count: 0,
      });
    }
    bySlug.get(slug).count += 1;
  }
  if (!bySlug.size) return null;

  const artists = [...bySlug.values()].sort((a, b) => a.label.localeCompare(b.label, lang === 'fa' ? 'fa' : 'en'));
  const L = ARTIST_INDEX_LABELS[lang] || ARTIST_INDEX_LABELS.en;

  const links = artists.map((a) => {
    const href = pathFor(lang, 'credits/artist/' + a.slug);
    return `<a href="${escapeHtmlAttr(href)}">${escapeHtmlAttr(a.label)}</a>`;
  }).join('\n    ');

  return `<section id="artistIndex" style="border-bottom:none;padding-bottom:8px">
  <h2 style="margin-bottom:6px">${escapeHtmlAttr(L.heading)}</h2>
  <p style="color:var(--muted);font-size:15px;margin-top:0">${escapeHtmlAttr(L.intro)}</p>
  <nav class="roster" aria-label="${escapeHtmlAttr(L.heading)}">
    ${links}
  </nav>
</section>
`;
}

class BeforeElementInjector {
  constructor(html) {
    this.html = html;
  }
  element(element) {
    element.before(this.html, { html: true });
  }
}

// ---------------------------------------------------------------------
// sitemap.xml — generated at request time from the same static page list
// and the same live data/credits.json this whole module already uses, so
// a new credit or a new title added through /admin appears in the
// sitemap the moment it appears on the site, with nothing to hand-edit
// and nothing that can drift out of sync. There is no static
// sitemap.xml file in the assets directory any more — this is the only
// source of it now, matching the same "one source of truth" this entire
// module is built around.
// ---------------------------------------------------------------------

const STATIC_SITEMAP_SLUGS = [
  'home', 'about', 'credits', 'releases', 'miragesohi', 'gallery', 'services', 'collaborate', 'journal',
  'mastering-for-streaming', 'mixing-persian-vocals', 'traditional-instruments',
];

async function buildSitemapXml(env) {
  const urls = [];
  for (const slug of STATIC_SITEMAP_SLUGS) {
    urls.push({ loc: SITE_ORIGIN + pathFor('en', slug), priority: slug === 'home' ? '1.0' : '0.8' });
    urls.push({ loc: SITE_ORIGIN + pathFor('fa', slug), priority: '0.8' });
  }

  const creditsData = await readCreditsReadOnly(env);
  const storiesData = creditsData ? await readStoriesReadOnly(env) : null;
  const lyricsMap = creditsData ? await readLyricsReadOnly(env) : new Map();
  if (creditsData) {
    const artistSlugs = new Set();
    for (const hub of ['credits', 'releases']) {
      const entries = titledEntriesFor(creditsData, hub);
      for (const entry of entries) {
        const slug = hub + '/' + slugifyName(entry.id);
        urls.push({ loc: SITE_ORIGIN + pathFor('en', slug), priority: '0.6' });
        urls.push({ loc: SITE_ORIGIN + pathFor('fa', slug), priority: '0.6' });

        const story = storiesData ? findStoryForEntry(storiesData, entry) : null;
        if (story) {
          const aboutSlug = slug + '/about';
          if (story.story_en && String(story.story_en).trim()) {
            urls.push({ loc: SITE_ORIGIN + pathFor('en', aboutSlug), priority: '0.5' });
          }
          if (story.story_fa && String(story.story_fa).trim()) {
            urls.push({ loc: SITE_ORIGIN + pathFor('fa', aboutSlug), priority: '0.5' });
          }
        }

        if (lyricsFor(lyricsMap, entry)) {
          urls.push({ loc: SITE_ORIGIN + pathFor('en', slug + '/lyrics'), priority: '0.6' });
          urls.push({ loc: SITE_ORIGIN + pathFor('fa', slug + '/lyrics'), priority: '0.6' });
        }

        if (hub === 'credits' && entry.artist_en && entry.artist_en !== 'Miragesohi') {
          artistSlugs.add(slugifyName(entry.artist_en));
        }
      }
    }
    for (const artistSlug of artistSlugs) {
      const slug = 'credits/artist/' + artistSlug;
      urls.push({ loc: SITE_ORIGIN + pathFor('en', slug), priority: '0.5' });
      urls.push({ loc: SITE_ORIGIN + pathFor('fa', slug), priority: '0.5' });
    }
  }

  // The gallery photos are listed as images of the two gallery pages
  // (Google's image sitemap extension), so they're found and indexed.
  const galleryItems = await readGalleryReadOnly(env);
  const gallerySorted = galleryItems ? sortedGalleryItems(galleryItems) : [];
  const galleryImages = gallerySorted.map((e) => SITE_ORIGIN + e.src);
  const galleryLocs = new Set([SITE_ORIGIN + pathFor('en', 'gallery'), SITE_ORIGIN + pathFor('fa', 'gallery')]);
  // ...and each photo's own page, with just that photo.
  const photoPageImage = new Map();
  for (const e of gallerySorted) {
    for (const lang of ['en', 'fa']) {
      const loc = SITE_ORIGIN + pathFor(lang, 'gallery/' + galleryPhotoSlug(e));
      urls.push({ loc, priority: '0.4' });
      photoPageImage.set(loc, SITE_ORIGIN + e.src);
    }
  }

  const body = urls.map((u) => {
    const imgs = galleryLocs.has(u.loc) ? galleryImages : (photoPageImage.has(u.loc) ? [photoPageImage.get(u.loc)] : []);
    const images = imgs.map((img) => `<image:image><image:loc>${escapeHtmlAttr(img)}</image:loc></image:image>`).join('');
    return `  <url><loc>${escapeHtmlAttr(u.loc)}</loc><priority>${u.priority}</priority>${images}</url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`;
}

// ---------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------

async function routeAdminRequest(request, env, pathname) {
  if (!(await isAuthenticated(request, env))) {
    return html(loginPage(), 401);
  }
  if (pathname === '/admin' || pathname === '/admin/') {
    return serveAdminApp(env);
  }
  if (pathname === '/admin/api/credits' && request.method === 'GET') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleGetCredits(env);
  }
  if (pathname === '/admin/api/save' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleSave(request, env);
  }
  if (pathname === '/admin/api/homepage' && request.method === 'GET') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleGetHomepage(env);
  }
  if (pathname === '/admin/api/save-homepage' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleSaveHomepage(request, env);
  }
  if (pathname === '/admin/api/lyrics' && request.method === 'GET') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleGetLyrics(env);
  }
  if (pathname === '/admin/api/save-lyrics' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleSaveLyrics(request, env);
  }
  if (pathname === '/admin/api/upload-image' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleUploadImage(request, env);
  }
  if (pathname === '/admin/api/gallery' && request.method === 'GET') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleGetGallery(env);
  }
  if (pathname === '/admin/api/gallery/upload' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleUploadGalleryImage(request, env);
  }
  if (pathname === '/admin/api/gallery/save' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleSaveGallery(request, env);
  }
  if (pathname === '/admin/api/new-releases' && request.method === 'GET') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleGetNewReleases(env);
  }
  if (pathname === '/admin/api/save-new-releases' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleSaveNewReleases(request, env);
  }
  if (pathname === '/admin/api/upload-video' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleUploadVideo(request, env);
  }
  if (pathname === '/admin/api/comments' && request.method === 'GET') {
    return handleAdminListComments(env);
  }
  if (pathname === '/admin/api/comments/approve' && request.method === 'POST') {
    return handleAdminApproveComment(request, env);
  }
  if (pathname === '/admin/api/comments/delete' && request.method === 'POST') {
    return handleAdminDeleteComment(request, env);
  }
  if (pathname === '/admin/api/submissions' && request.method === 'GET') {
    return handleAdminListSubmissions(env);
  }
  if (pathname === '/admin/api/submissions/file' && (request.method === 'GET' || request.method === 'HEAD')) {
    return handleAdminSubmissionFile(request, env);
  }
  if (pathname === '/admin/api/submissions/mark' && request.method === 'POST') {
    return handleAdminMarkSubmission(request, env);
  }
  if (pathname === '/admin/api/submissions/delete' && request.method === 'POST') {
    return handleAdminDeleteSubmission(request, env);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // The artist page was renamed from /mirage to /miragesohi (and its
    // fa/ twin) when the MIRAGE alias became the artist's primary name.
    // A permanent redirect keeps every old bookmark/backlink working and
    // tells search engines to transfer the old URL's ranking signal to
    // the new one, rather than leaving /mirage to 404.
    if (pathname === '/mirage' || pathname === '/mirage.html' || pathname === '/mirage/') {
      return Response.redirect(SITE_ORIGIN + '/miragesohi', 301);
    }
    if (pathname === '/fa/mirage' || pathname === '/fa/mirage.html' || pathname === '/fa/mirage/') {
      return Response.redirect(SITE_ORIGIN + '/fa/miragesohi', 301);
    }

    // Uploaded New Release videos (see serveMedia above).
    const mediaMatch = pathname.match(MEDIA_ROUTE_RE);
    if (mediaMatch) {
      try {
        return await serveMedia(request, env, ctx, mediaMatch);
      } catch (err) {
        console.error('serveMedia failed', err && err.stack || err);
        return new Response('Video temporarily unavailable', { status: 502 });
      }
    }

    // Public song comments (see handlePostComment above).
    if (pathname === '/api/comments') {
      try {
        if (request.method === 'GET') return await handleGetComments(request, env, ctx);
        if (request.method === 'POST') return await handlePostComment(request, env);
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
      } catch (err) {
        console.error('comments failed', err && err.stack || err);
        return json({ error: 'Something went wrong — please try again.' }, 500);
      }
    }

    // Collaboration submissions from the /collaborate page (see
    // handlePostCollab above).
    if (pathname === '/api/collab') {
      // GET: only whether the notification email works (ok/error/time) —
      // never any submission content.
      if (request.method === 'GET') {
        const mail = env.COMMENTS ? await env.COMMENTS.get('collab:mailstatus', 'json').catch(() => null) : null;
        return json({ emailBinding: !!env.SEND_EMAIL, lastEmail: mail });
      }
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      try {
        return await handlePostCollab(request, env, ctx);
      } catch (err) {
        console.error('collab submission failed', err && err.stack || err);
        return json({ error: 'Something went wrong — please try again.', code: 'server' }, 500);
      }
    }

    try {
      if (pathname === '/admin/__diag') {
        // Temporary, unauthenticated-by-design diagnostic: reveals only
        // whether each secret binding is present, never its value or
        // length, so it's safe to leave reachable while debugging a
        // "not configured" report. Remove once the secrets are confirmed
        // wired up correctly.
        return json({
          hasAdminPassword: !!env.ADMIN_PASSWORD,
          hasGithubToken: !!env.GITHUB_TOKEN,
          hasSendEmail: !!env.SEND_EMAIL,
          // How the last collaboration notification email went (ok/error
          // text/time only — no submission content).
          lastCollabEmail: env.COMMENTS ? await env.COMMENTS.get('collab:mailstatus', 'json').catch(() => null) : null,
          collabSubmissions: env.COMMENTS ? (await env.COMMENTS.list({ prefix: 's:', limit: 1000 })).keys.length : null,
        });
      }
      if (pathname === '/admin/login' && request.method === 'POST') {
        return await handleLoginPost(request, env);
      }
      if (pathname === '/admin/logout' && request.method === 'POST') {
        return handleLogout();
      }
      if (pathname.startsWith('/admin')) {
        return await routeAdminRequest(request, env, pathname);
      }
    } catch (err) {
      // Never leak a raw stack trace — this is server logic reachable only
      // by an authenticated admin, but the error message alone is enough
      // to debug from, and nothing here should ever throw for the public
      // site path below.
      return json({ error: (err && err.message) || 'Internal error' }, 500);
    }

    if (pathname === '/sitemap.xml') {
      try {
        return new Response(await buildSitemapXml(env), {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      } catch (err) {
        // Fall through to the (now-absent) static asset, which 404s —
        // better than a broken sitemap crawlers might partially ingest.
      }
    }

    // An individual recording page (plan section 4) has no static asset
    // behind it at all — it's generated fresh from data/credits.json on
    // every request, so try that before the normal static-asset lookup
    // below (which would otherwise just 404 for these paths).
    try {
      const recordingResponse = await tryServeRecordingPage(env, pathname);
      if (recordingResponse) return recordingResponse;
    } catch (err) {
      console.error('tryServeRecordingPage failed', err && err.stack || err);
      // Fall through to the normal static-asset lookup below.
    }

    // A per-artist page (/credits/artist/<slug>) is generated the same
    // way — checked separately since it's a different path shape.
    try {
      const artistResponse = await tryServeArtistPage(env, pathname);
      if (artistResponse) return artistResponse;
    } catch (err) {
      console.error('tryServeArtistPage failed', err && err.stack || err);
    }

    // A track's dedicated "About this track" story page
    // (/credits/<slug>/about) — same generated-on-request pattern.
    try {
      const storyResponse = await tryServeStoryPage(env, pathname);
      if (storyResponse) return storyResponse;
    } catch (err) {
      console.error('tryServeStoryPage failed', err && err.stack || err);
    }

    // A song's lyrics page (/credits/<slug>/lyrics) — same pattern.
    try {
      const lyricsResponse = await tryServeLyricsPage(env, pathname);
      if (lyricsResponse) return lyricsResponse;
    } catch (err) {
      console.error('tryServeLyricsPage failed', err && err.stack || err);
    }

    // A gallery photo's own page (/gallery/<slug>) — same pattern.
    try {
      const photoResponse = await tryServeGalleryPhotoPage(env, pathname);
      if (photoResponse) return photoResponse;
    } catch (err) {
      console.error('tryServeGalleryPhotoPage failed', err && err.stack || err);
    }

    // Everything else: the public static site, with entity/structured-data
    // metadata injected server-side (see applyEntitySeo above). Any
    // failure here falls back to the untouched asset response rather than
    // breaking the page.
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 200) {
      try {
        return await applyEntitySeo(assetResponse, env, pathname);
      } catch (err) {
        return assetResponse;
      }
    }
    return assetResponse;
  },
};
