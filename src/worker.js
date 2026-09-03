// Static-asset passthrough for the public site, plus a password-gated
// /admin panel for editing data/credits.json. The panel itself is server
// rendered by this Worker (never a plain static asset) so it can enforce
// the password check before any admin HTML/JS ever reaches the browser,
// and its "Save" action commits straight to this repo's GitHub API using a
// server-side token the browser never sees.
//
// Required Cloudflare secrets (set via `wrangler secret put NAME`, or the
// dashboard — never committed to this repo):
//   ADMIN_PASSWORD  - the /admin login password
//   GITHUB_TOKEN    - a GitHub token with Contents read/write on this repo
//
// Nothing else here is sensitive: repo owner/name/branch and the data path
// are plain constants below.

const GITHUB_OWNER = 'merajmusic-hash';
const GITHUB_REPO = 'merajmirzaei-site';
const GITHUB_BRANCH = 'main';
// Both paths are repo-root-relative (for the GitHub Contents API) and live
// inside the static-assets directory, so they're also served publicly at
// /data/credits.json and /images/covers/<file> respectively.
const DATA_PATH = 'merajmirzaei-site (4)/data/credits.json';
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
  'album_name', 'year', 'label', 'cover_url', 'artist_image',
  'status_musicbrainz', 'status_discogs', 'status_genius', 'notes',
];
const BOOL_FIELDS = ['role_arrangement', 'role_production', 'role_mix', 'role_mastering'];
const RELEASE_TYPES = new Set(['single', 'album track', 'album']);
const STATUS_VALUES = new Set(['not started', 'pending', 'done']);

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

    // Everything else: the public static site, unchanged.
    return env.ASSETS.fetch(request);
  },
};
