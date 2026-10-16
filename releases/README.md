# Releases (the What's new showcase)

Roost shows people a short "What's new" the first time they open it after an update, and keeps every release on the What's new page.

- One file per version: `0.1.json`, `0.1.1.json`, `0.2.json`. Versions count slowly toward 1.0: small steps (0.1.1) for ordinary merges, the middle number (0.2) for a bigger milestone.
- `next.json` collects items for the release being built. **A pull request that changes what people see (a feature, a visible fix, a speed-up) adds an item here**: `title`, one or two short `text` sentences, and an `image` (a screenshot in `img/`, about 900 px wide, under 150 KB). Mark an item `"admin": true` if only admins use it. Internal changes (tests, refactors, docs, build) add nothing.
- When a PR merges, run `node scripts/release.js 0.1.1 "Title" "One line summary"` (or `--patch` / `--minor` instead of a version). It turns `next.json` into the new version file, stamps today's date, bumps `package.json` and empties `next.json`.
- `npm test` checks every file here: fields present, images exist and are small.
