# Open Ontology

`@open-ontology/ontology` defines a portable ontology model, compiles TypeScript and Forma sources to the same JSON-safe IR, and runs actions and named Datalog queries on Triplex.

Maturity: **experimental (v0.1)**. One package, four executable examples, and a local in-memory runtime; no durable server or npm release yet.

The selected implementation was adapted from the [historical Open Ontology repository](https://github.com/bjacobso/open-ontology-legacy) at [commit `7c2ff8a`](https://github.com/bjacobso/open-ontology-legacy/commit/7c2ff8a614b9f06a6e530aa80d0c7311dc81a323), especially its `packages/ontology` directory. The current code removes its server convenience method and does not bring over the old workspace or runtime.

Join the community on [Discord](https://discord.gg/cjW4gxsdXK).

## Run

Requires Node 22 or later and pnpm 10.11.0.

```sh
git clone https://github.com/bjacobso/open-ontology.git
cd open-ontology
pnpm install --frozen-lockfile
pnpm check
pnpm example
pnpm example:support-desk
pnpm example:github
pnpm example:onboarded
pnpm model:check examples/support-desk/model.lisp
```

`pnpm example` loads [the TypeScript model](examples/field-service/model.ts) and [the Forma model](examples/field-service/model.lisp), checks their IR for equivalence, seeds an in-memory Triplex host, invokes `assign-work-order`, and prints the `assigned-work` query result. `pnpm example:support-desk` runs a Forma-only model that exercises `create`, `clear` followed by `set`, reference fields, relations, negation, ordering, and aggregates.

`pnpm model:check <model.lisp | model.ts>` elaborates a model, applies the runtime's naming and input-schema rules, and reports errors with `file:line:col`. It also warns about models that compile but misbehave: queries that match undeclared attributes or find unbound variables, optional inputs used by changes, single-valued fields set without a preceding `clear`, and changes that target a fixed object id. Pass `--json` for machine-readable output.

## Git and GitHub libraries

Forma models can write `(import "/std/git")` for shared repositories, branches, commits, ancestry, forks, and dependencies, or `(import "/github")` for that graph plus GitHub accounts, hosting records, issues, pull requests, memberships, and collaborators. Imports load bundled Lisp sources once per model. A future `/gitlab` can reuse `/std/git`; it is not bundled yet.

`pnpm example:github` runs [a local GitHub graph](examples/github/model.lisp), including a PR from a fork, a referenced issue, dependency links, and merge parents. These are synthetic facts, with no GitHub API connection. See [Git libraries](docs/git-libraries.md) for the vocabulary, id conventions, and extension pattern.

## Onboarded domain study

The unlisted `/onboarded` page presents an illustrative account language for Onboarded, informed directionally by supplied schema and API context. [`northwind.account.lisp`](examples/onboarded/northwind.account.lisp) configures one synthetic account end to end, covering attributes, forms, policies, automations, access, integrations, and scenarios, in nine verbs. The Forma reader parses it; example code in [`examples/onboarded/account`](examples/onboarded/account) checks it with located errors, lowers it to directional resources, evaluates policies with three-valued logic, and plays scenarios day by day. The check fails on a failing scenario or on any policy or automation decision that no scenario sees both true and false.

```sh
pnpm account:check examples/onboarded/northwind.account.lisp
```

The page also explores [a working TypeScript ontology](examples/onboarded/model.ts) of the underlying domain, with a recorded local Triplex transcript from `pnpm example:onboarded`. See [the study notes](examples/onboarded/README.md) for the vocabulary, checks, and simplifications. The account elaborator is not a Forma prelude or package export; its resource shapes are not production formats, and nothing calls Onboarded or deploys configuration.

After changing the account program, model, scenario, or graph views, run `pnpm site:export-onboarded` to refresh the checked-in browser artifacts. Tests verify that they match the checked-in sources.

## Package boundary

The package exports the TypeScript DSL, portable IR, Forma elaborator, and Triplex runtime adapter. The checked-in Forma preludes and domain libraries are loaded at runtime and included in the package tarball. See [architecture](docs/architecture.md) for the boundary and current operational limits.

## Website

The static site in [apps/site](apps/site) adapts the visual design of the historical repository's `packages/web/app/routes/home.*`. Its primary reader is an agent modeling a domain on someone's behalf. The homepage points agents to [`llms-full.txt`](apps/site/public/llms-full.txt), a single plain-text authoring guide covering the grammar, a modeling procedure, the checker, runtime semantics, and limits, and to its [`llms.txt`](apps/site/public/llms.txt) index. `test/agent-guide.test.ts` keeps the guide honest: every Forma block must check without warnings, and the quoted checker and example output must match what the commands print. Run `pnpm site:check` to validate local links and assets, or `pnpm site:dev` to preview it with Wrangler.

The [site deployment workflow](.github/workflows/deploy-site.yml) checks pull requests and deploys merges to `main` to the personal Cloudflare account as the `open-ontology-site` Worker, which serves `open-ontology.com`. It needs `CLOUDFLARE_ACCOUNT_ID` and a scoped `CLOUDFLARE_API_TOKEN` GitHub secret. The token needs Workers Scripts Write for the account and Workers Routes Write for the `open-ontology.com` zone when attaching or changing the custom domain.

Effect is a peer dependency with the range `^4.0.3`. 4.0.3 is the floor because earlier 4.0 releases cannot reflect `Schema.isMinCodePoints` to JSON Schema. The lockfile pins the floor as a dev dependency, so `pnpm check` runs against 4.0.3, and a second CI job reinstalls with the latest Effect 4 release and runs the type checks and tests again. Forma and Triplex still declare an older Effect RC, so version-scoped pnpm overrides point those two packages at this repository's own Effect version (`$effect`) and the install keeps one Effect copy; a test fails if they drift apart. The checked-in [Triplex patch](patches/@triplex-build__triplex@0.2.0.patch) migrates its cursor encoding to `Base64Url` from `effect/encoding` and preserves its branded-id constructors with Effect's getter-backed schema objects. Frozen installs apply the patch.

Materialized actions retain their source JSON Schema document because Effect's importer can change its AST and re-exported shape. Action checks that Effect marks as approximate are rejected; use `Schema.isMinCodePoints` for portable string-length checks and Unicode regular expressions (`/.../u`) for portable patterns. The tests cover Forma elaboration, portable schema validation, Triplex configuration and actions, and cursor continuation and rejection. The overrides and patch are still a compatibility exception: package consumers need the same overrides and patch until Forma and Triplex release Effect 4 support. Foldkit and Effect companion packages are not used here.

## Next checkpoint

The executable example is a local, in-memory contract check. Before presenting a server as a product host, add SQLite persistence, policy authorization, versioned config release/deploy, restart and historical-query tests, attribution and idempotency verification, and a local migration or rebuild procedure. HTTP reflection and OpenAPI follow that runtime checkpoint.

MIT licensed; see [LICENSE](LICENSE). Part of the [WorldVM](https://worldvm.com) family of experiments.
