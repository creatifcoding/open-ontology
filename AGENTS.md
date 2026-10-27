# Working on Open Ontology

Open Ontology is experimental (v0.1): one package with a local in-memory Triplex runtime, not a durable server or an npm release.

## Setup and checks

Use Node 24 (as in CI) and pnpm 10.11.0, pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs TypeScript checks, Vitest tests, the package build, and static-site checks, including the agent index and guide. There is no separate formatter or linter configured.

For focused work, use `pnpm typecheck`, `pnpm test`, `pnpm build`, or `pnpm site:check`. Try the runtime with `pnpm example` and `pnpm example:support-desk`; check a model with `pnpm model:check examples/support-desk/model.lisp`. Preview the static site with `pnpm site:dev`.

## Layout

- `src/`: TypeScript DSL, JSON-safe IR, Forma elaborator, and Triplex runtime adapter.
- `preludes/`: checked-in Forma sources, loaded at runtime and shipped with the package.
- `examples/`: field-service (TypeScript and Forma equivalence) and support-desk (Forma) scenarios.
- `scripts/check-model.ts`: model checker with source diagnostics and warnings.
- `test/`: Vitest coverage, including executable blocks and transcripts from the agent guide.
- `docs/architecture.md`: package boundary and operational limits.
- `apps/site/public/`: directly served static assets, including `llms.txt` and `llms-full.txt`; no docs build.
- `apps/site/check.mjs`: static assets, agent-file structure, and local/repository link checks.
- `.github/workflows/deploy-site.yml`: checks PRs, reruns type checks and tests against the newest Effect 4 release, and deploys the static site after merges to `main`.

## Conventions and boundaries

Keep changes small and follow the existing TypeScript ESM style: `.js` import specifiers, double quotes, semicolons, and strict types. Keep the portable IR JSON-safe and both authoring paths equivalent. Add behavior coverage when changing the model or runtime; keep guide examples and transcripts in sync with the code.

Edit the agent files in `apps/site/public/` directly. Describe what ships today and its experimental maturity; prefer absolute URLs and raw Markdown documentation. Local links must name actual files, and the site must retain its `404-page` handling rather than an SPA fallback.

Do not import sibling project source; use packages. Do not add a framework for the static site or claim persistence, authorization, or a server exists. Do not hand-deploy, publish packages, or merge a PR; deployment uses the existing pipeline.
