const ART_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/art") {
      return handleArt(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleArt(request, env, ctx) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  if (!q) {
    return new Response("Missing q parameter", { status: 400 });
  }

  // One cached response per distinct search term, served straight from Cloudflare's edge cache.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const searchUrl =
    "https://itunes.apple.com/search?term=" +
    encodeURIComponent(q) +
    "&entity=song&limit=1";

  let hit;
  try {
    const searchResp = await fetch(searchUrl);
    if (!searchResp.ok) {
      return new Response("iTunes lookup failed", { status: 502 });
    }
    const data = await searchResp.json();
    hit = data && data.results && data.results[0];
  } catch (err) {
    return new Response("iTunes lookup failed", { status: 502 });
  }

  if (!hit || !hit.artworkUrl100) {
    return new Response("Not found", { status: 404 });
  }

  const artworkUrl = hit.artworkUrl100.replace("100x100", "600x600");

  let imageResp;
  try {
    imageResp = await fetch(artworkUrl);
  } catch (err) {
    return new Response("Artwork fetch failed", { status: 502 });
  }
  if (!imageResp.ok) {
    return new Response("Not found", { status: 404 });
  }

  const contentType = imageResp.headers.get("content-type") || "image/jpeg";
  const response = new Response(imageResp.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${ART_MAX_AGE}, immutable`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
