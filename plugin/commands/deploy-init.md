---
description: Install the deploy scaffold — digest-pinned Dockerfile, compose, terraform skeleton, environment-branch workflows, smoke script — and wire forge.json
---

Install the deploy layer into this repo (spec §10). Ask the user for the app name (default: repo name) and healthcheck path (default: `/healthz`) if not obvious, then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy/init.mjs" --stack node --app "<name>" --healthcheck "/healthz"
```

The script never overwrites existing files — it places only what's missing and reports both lists. After it finishes, relay the three human steps it prints (environment branches + protection, cloud deploy insert points, repo variables) — those are owner actions the platform must not do itself.
