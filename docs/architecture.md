# Architecture

Forma and the TypeScript DSL produce `OntologyIR`. The IR is JSON-safe and names object types, link types, actions, and queries. `materializeOntology` restores the executable Effect Schema model. `makeOntologyRuntime` converts action changes into Triplex transactions, checks each against the ontology's single-value, unique, and reference-target constraints, and runs named Datalog queries. `toTriplexConfig` emits Triplex configuration nodes and constraints; `integrityConstraints` returns the same constraints without compiling configuration.

```text
TypeScript DSL ──┐
                ├──> OntologyIR ──> Triplex adapter ──> selected host
Forma source ───┘
```

The package does not own an HTTP server or UI. The initial example uses Triplex's in-memory `KvTriples.layer` only. It is not durable and does not enforce a product policy. Those host responsibilities are required for the next checkpoint.

The Forma bridge uses its reader and descriptor/elaboration API. The checked-in Lisp preludes provide the ontology-specific forms needed to bootstrap that bridge. The adapter accepts `define-entity`, `define-relation`, `define-action`, `define-mutation`, and `define-datalog-query`; unsupported recognized forms are rejected. Parser and ontology validation errors expose source locations through `error.loc` where available.

Before descriptor recognition, `(import "/std/git")` and `(import "/github")` expand the checked-in domain sources in `libraries/`. `/github` imports `/std/git`. Imports use an explicit bundled registry, never filesystem or network resolution, and load each library once per elaboration. Imported declarations and caller declarations undergo the same validation; duplicate declaration names remain errors. Source locations are retained, with `error.source` identifying a bundled library when applicable. The final IR contains ordinary declarations, so materialization and the Triplex adapter need no library-aware runtime.

The Git vocabulary is independent of a provider. `GitHubRepository` is a hosting record referencing `GitRepository`, while PR base/head references point to repository-scoped `GitBranch` objects. Commit objects can be shared across repositories, with ordered parent relations for merge ancestry. `/std/git` alone can support another hosting model. [Git libraries](git-libraries.md) documents the current vocabulary and limits.
