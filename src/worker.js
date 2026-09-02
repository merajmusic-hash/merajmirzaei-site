// Pure static-asset passthrough. All cover-art/data lookups now happen at
// build time (see scripts/fetch-artwork.mjs), so this Worker has no custom
// routes of its own — it only exists so Cloudflare's Workers Builds
// pipeline (configured for this repo as a Worker, not Pages) has a script
// to deploy alongside the static assets binding.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
