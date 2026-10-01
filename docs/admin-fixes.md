## Admin data and rollout

The seven reviewed issues are fixed in the admin app and Worker. Run:

```sh
node --test scripts/test-admin.mjs
python scripts/optimize-covers.py --check
node scripts/validate-seo.mjs http://localhost:8787
```

The cover check requires Pillow. The artwork workflow installs it and runs the optimizer after downloading covers. Admin cover uploads resize to 1200px before upload; the Worker rejects covers over 1MiB. The old PNG URL redirects to its optimized WebP.

Deploy using Wrangler 4.36.0 or newer so the `ADMIN_LOGIN_LIMITER` binding in `wrangler.toml` is recognized. No new password or KV namespace is required. The limiter allows ten attempts per IP per minute at each Cloudflare location; it is not a global account lockout. Login fails closed if the binding is missing.

### Private credits migration

Notes and MusicBrainz/Discogs/Genius statuses now live in the existing private `COMMENTS` KV, under `admin:credits:<revision>`. GitHub holds only public credits plus an opaque revision on the first row. That revision makes notes-only edits change the file SHA, so stale saves still conflict. Each save writes a new private revision before updating GitHub. A failed GitHub write cannot overwrite another revision's private data.

For the initial rollout, the first row points to `legacy-5c413fbe10ada42b55a6068600791b05dde5eaec`. Until the first admin Save, the authenticated loader recovers existing notes from that immutable GitHub commit. The initial migration preserves the original 104 rows. Before merging, check that main's credits have not changed since this baseline. If there are newer admin edits, refresh the migration commit and public data together rather than replacing them with the older snapshot.

After deployment, sign in and verify the old notes appear. Save the Credits tab once (an edit marks it dirty); that persists the recovered notes to a new private KV revision. If KV data cannot be read, the panel refuses to load credits instead of showing blank notes. KV propagation can cause a temporary load error after saving; retry rather than editing an empty table.

Public `/data/credits.json` and its encoded/extensionless aliases are filtered independently of the static asset. Public release backups exclude all private fields. Authenticated Export JSON/CSV still include notes and statuses; the backup link is labelled Public backups.

Previously published notes remain in older GitHub commits and old release snapshots. This change prevents new disclosure; it does not rewrite repository history or delete old backups. Preserve the migration source until its notes are safely stored in KV and exported privately.

### Other behavior

- Saves validate all upload/loading conditions before sending requests, disable both Save buttons while pending, retain newer edits, and track successful requests even when another request fails.
- Gallery reads are pinned to the commit used as their parent. Every retry checks the original gallery SHA again; concurrent gallery edits return 409. Unrelated branch changes can be retried safely.
- Collaboration records load in pages of 50 after scanning all KV metadata pages. The panel provides Load older submissions; search applies to loaded records. Comments also traverse every KV metadata page.
- A media HEAD never starts a full video cache download. A full GET reuses its existing response for caching.
- Admin responses are private/no-store; diagnostics require login, and the public collaboration status no longer exposes internal email errors.

Tests mock GitHub, KV and browser requests. A real browser visual check and production checks are separate from these behavioral regressions.
