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
const MIRAGE_ID = SITE_ORIGIN + '/mirage#mirage';
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
    jobTitle: 'Mix and Mastering Engineer',
    description: 'Mix and mastering engineer, music producer and sound designer based in London, with over 20 years of work across Persian, electronic and international music.',
  },
  fa: {
    jobTitle: 'مهندس میکس و مسترینگ',
    description: 'معراج میرزایی (MIRAGE) — مهندس میکس و مسترینگ، تهیه‌کننده و ساند دیزاینر در لندن. بیش از ۲۰ سال کار در موسیقی ایرانی، الکترونیک و بین‌المللی.',
  },
};

function buildPersonNode(lang) {
  const loc = PERSON_LOCALIZED[lang];
  return {
    '@type': 'Person',
    '@id': PERSON_ID,
    name: 'Meraj Mirzaei',
    alternateName: ['معراج میرزایی', 'MIRAGE'],
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
    name: 'MIRAGE',
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
  credits: { en: 'Credits', fa: 'کارنامه' },
  releases: { en: 'Releases', fa: 'ریلیزها' },
  mirage: { en: 'MIRAGE', fa: 'MIRAGE' },
  gallery: { en: 'Gallery', fa: 'گالری' },
  services: { en: 'Services', fa: 'خدمات' },
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
        name: lang === 'fa' ? 'معراج میرزایی — مهندس میکس و مسترینگ، لندن' : 'Meraj Mirzaei — Mix & Mastering Engineer, London',
        inLanguage: lang,
        mainEntity: { '@id': PERSON_ID },
      };
    case 'credits':
      return {
        '@type': 'CollectionPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'credits') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'credits'),
        name: lang === 'fa' ? 'کارنامه — معراج میرزایی | مهندس میکس و مسترینگ' : 'Credits — Meraj Mirzaei | Mix & Mastering Engineer',
        inLanguage: lang,
        about: { '@id': PERSON_ID },
      };
    case 'releases':
      return {
        '@type': 'CollectionPage',
        '@id': SITE_ORIGIN + pathFor(lang, 'releases') + '#webpage',
        url: SITE_ORIGIN + pathFor(lang, 'releases'),
        name: lang === 'fa' ? 'ریلیزهای جدید — MIRAGE | معراج میرزایی' : 'New Releases — MIRAGE | Meraj Mirzaei',
        inLanguage: lang,
        about: { '@id': MIRAGE_ID },
      };
    case 'mirage':
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
  if (entry.artist_en === 'MIRAGE') {
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
  en: { listenSpotify: 'Listen on Spotify', watchYoutube: 'Watch on YouTube', partOf: 'From the release', year: 'Year', home: 'Studio home', artistSpotify: 'Artist on Spotify', aboutTrack: 'About this track', backToTrack: 'Back to track' },
  fa: { listenSpotify: 'شنیدن در اسپاتیفای', watchYoutube: 'تماشا در یوتیوب', partOf: 'بخشی از', year: 'سال', home: 'صفحه اصلی استودیو', artistSpotify: 'صفحه هنرمند در اسپاتیفای', aboutTrack: 'درباره این قطعه', backToTrack: 'بازگشت به قطعه' },
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
      : `«${title}» از ${artist}${yearPart} — از کارنامه معراج میرزایی، مهندس میکس و مسترینگ.`;
  }
  return roleName
    ? `"${title}" by ${artist}${yearPart} — Meraj Mirzaei's credit: ${roleName}.`
    : `"${title}" by ${artist}${yearPart} — from Meraj Mirzaei's mix & mastering credits.`;
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
function renderRecordingDetailContent(entry, lang, hub, story) {
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
  // below, as its own button instead. MIRAGE has no per-artist page of
  // its own (that's what /mirage already is), so on releases its name
  // stays plain text.
  const artistPageHref = hub === 'credits' && entry.artist_en && entry.artist_en !== 'MIRAGE'
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
    linkButtons.push(`<a class="btn" href="${escapeHtmlAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtmlAttr(l.label || l.url)}</a>`);
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

function buildArtistPageContent(entries, lang, artistSlug) {
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
    return '<div class="trackcard-wrap"><a class="trackcard" href="' + escapeHtmlAttr(href) + '">'
      + cover
      + '<div class="tc-body">'
      + `<span class="tc-title">${escapeHtmlAttr(title)}</span>`
      + (titleAlt ? `<span class="tc-title-alt">${escapeHtmlAttr(titleAlt)}</span>` : '')
      + rolesBlock
      + '</div></a></div>';
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

  const breadcrumb = buildBreadcrumb(lang, slug);
  if (breadcrumb) nodes.push(breadcrumb);

  if (slug === 'credits' || slug === 'releases') {
    const creditsData = await readCreditsReadOnly(env);
    if (creditsData) {
      const { nodes: recNodes, usesMirage } = buildRecordingsGraph(creditsData, slug, lang);
      if (usesMirage && slug !== 'mirage') nodes.push(buildMirageNode());
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

  const rewriter = new HTMLRewriter()
    .on('script[type="application/ld+json"]', new RemoveElement())
    .on('link[rel="alternate"][hreflang="en"]', new SetAttribute('href', SITE_ORIGIN + enPath))
    .on('link[rel="alternate"][hreflang="fa"]', new SetAttribute('href', SITE_ORIGIN + faPath))
    .on('link[rel="alternate"][hreflang="x-default"]', new SetAttribute('href', SITE_ORIGIN + enPath))
    .on('head', new HeadInjector(injection))
    .on('script#langRedirect', new ReplaceScriptBody(langRedirectBody))
    .on('a#langtog', new LangtogRewriter(langtogHref))
    .on('a[href$=".html"]', new InternalLinkRewriter(lang));

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

  const titleText = buildRecordingTitleText(entry, lang);
  const descText = buildRecordingDescriptionText(entry, lang);
  const mainHtml = renderRecordingDetailContent(entry, lang, hub, story);
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
  const mainHtml = buildArtistPageContent(entries, lang, artistSlug);
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
  'home', 'credits', 'releases', 'mirage', 'gallery', 'services', 'journal',
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

        if (hub === 'credits' && entry.artist_en && entry.artist_en !== 'MIRAGE') {
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

  const body = urls.map((u) => `  <url><loc>${escapeHtmlAttr(u.loc)}</loc><priority>${u.priority}</priority></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
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
  if (pathname === '/admin/api/upload-image' && request.method === 'POST') {
    if (!env.GITHUB_TOKEN) return json({ error: 'Admin not fully configured (missing GITHUB_TOKEN)' }, 503);
    return handleUploadImage(request, env);
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

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
