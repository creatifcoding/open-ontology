import { readFileSync } from "node:fs";
import { Effect, Result, Schema } from "effect";
import { EntityId, KvTriples, Triples, string } from "@triplex-build/triplex";
import { GraphConstraint } from "@triplex-build/triplex/config";
import { describe, expect, it } from "vitest";
import { githubSource } from "../examples/github/scenario.js";
import { checkFormaSource } from "../scripts/check-model.js";
import {
  Ontology,
  Property,
  defineOntology,
  elaborateFormaOntology,
  integrityConstraints,
  makeOntologyRuntime,
  ontologyToIR,
  toTriplexConfig,
  type ActionInvocationOptions,
} from "../src/index.js";

const entities = `(define-entity Place
  (:field [place/code String {:required true :unique true}])
  (:field [place/label String]))

(define-entity Entry
  (:field [entry/place Place {:required true}])
  (:field [entry/note String]))
`;

const source = `${entities}
(define-relation stocked-at Entry Place
  (:field [stocked-at/note String]))

(define-action add-place
  (:input [place String {:required true}])
  (:input [code String {:required true}])
  (:returns String)
  (:do (create Place place {:place/code code})))

(define-action label-place
  (:input [place String {:required true}])
  (:input [label String {:required true}])
  (:returns String)
  (:do (set place :place/label label)))

(define-action post-entry
  (:input [entry String {:required true}])
  (:input [place String {:required true}])
  (:returns String)
  (:do (create Entry entry {:entry/place place})))

(define-action note-entry
  (:input [entry String {:required true}])
  (:input [note String {:required true}])
  (:returns String)
  (:do (create Entry entry {:entry/note note})))

(define-action stock
  (:input [entry String {:required true}])
  (:input [place String {:required true}])
  (:input [note String {:required true}])
  (:returns String)
  (:do (link stocked-at entry place {:stocked-at/note note})))
`;

const ir = elaborateFormaOntology(source, { name: "integrity", version: "1" });

/**
 * Run invocations in order on one fresh store and report each as "ok" or its failure tag. Each
 * transaction gets its own instant, so constraints are checked at distinct valid-time boundaries.
 */
const run = (
  invocations: readonly (readonly [string, Readonly<Record<string, unknown>>, ActionInvocationOptions?])[],
  runtime = makeOntologyRuntime(ir),
): Promise<readonly string[]> =>
  Effect.runPromise(Effect.gen(function* () {
    const outcomes: string[] = [];
    for (const [action, input, options] of invocations) {
      const result = yield* Effect.result(runtime.invoke(action, input, options));
      outcomes.push(Result.isSuccess(result) ? "ok" : result.failure._tag);
      yield* Effect.sleep("2 millis");
    }
    return outcomes;
  }).pipe(Effect.provide(KvTriples.layer)));

describe("integrity", () => {
  it("carries :unique from Forma into the IR, matching the TypeScript DSL", () => {
    const Place = Ontology.ObjectType("Place", {
      properties: {
        code: Property.make(":place/code", Schema.String).required().unique(),
        label: Property.make(":place/label", Schema.String),
      },
    });
    const Entry = Ontology.ObjectType("Entry", {
      properties: {
        place: Property.ref(":entry/place", Place).required(),
        note: Property.make(":entry/note", Schema.String),
      },
    });
    const forma = elaborateFormaOntology(entities, { name: "integrity", version: "1" });
    expect(forma.objectTypes[0]?.properties[0]).toMatchObject({ key: ":place/code", required: true, unique: true });
    expect(forma).toEqual(ontologyToIR(defineOntology({ name: "integrity", version: "1" }, [Place, Entry])));
    expect(checkFormaSource(entities, { name: "integrity" }).summary[0])
      .toBe("object  Place  :place/code string! unique, :place/label string");
  });

  it.each([
    ["an unknown field option", "(define-entity Place (:field [place/code String {:required true :primary true}]))", ":field option :primary is not supported by the Triplex ontology adapter; use :required or :unique", 1, 65],
    ["an index hint", "(define-entity Place\n  (:field [place/code String {:indexed true}]))", ":field option :indexed is not supported by the Triplex ontology adapter; use :required or :unique", 2, 31],
    ["a relation field option", "(define-entity Place (:field [place/code String]))\n(define-relation near Place Place (:field [near/km Int {:many true}]))", ":field option :many is not supported by the Triplex ontology adapter; use :required or :unique", 2, 57],
    ["an input option", "(define-entity Place (:field [place/code String]))\n(define-action add (:input [place String {:required true :unique true}]) (:returns String) (:do (create Place place {:place/code \"a\"})))", ":input option :unique is not supported by the Triplex ontology adapter; use :required", 2, 58],
  ] as const)("rejects %s at its location instead of dropping it", (_name, model, message, line, col) => {
    expect(checkFormaSource(model, { name: "options" }).diagnostics).toEqual([{ severity: "error", message, line, col }]);
  });

  it.each([
    ["role", "(define-entity Place (:role \"site\") (:field [place/code String]))"],
    ["id-pattern", "(define-entity Place (:id-pattern \"place:{code}\") (:field [place/code String]))"],
  ] as const)("rejects the entity slot %s, which the IR cannot carry", (slot, model) => {
    expect(checkFormaSource(model, { name: "slots" }).diagnostics).toEqual([
      { severity: "error", message: `(:${slot} ...) is not yet supported by the Triplex ontology adapter`, line: 1, col: 1 },
    ]);
  });

  it("derives the same constraints as the Triplex configuration for every compilable example", () => {
    const models = [
      ir,
      elaborateFormaOntology(readFileSync(new URL("../examples/field-service/model.lisp", import.meta.url), "utf8"), { name: "field-service" }),
      elaborateFormaOntology(readFileSync(new URL("../examples/support-desk/model.lisp", import.meta.url), "utf8"), { name: "support-desk" }),
      elaborateFormaOntology(githubSource, { name: "github" }),
    ];
    for (const model of models) {
      expect(integrityConstraints(model).map(({ key }) => key).sort())
        .toEqual(toTriplexConfig(model).constraints.map(({ key }) => key).sort());
    }
    expect(integrityConstraints(ir).map(({ rule }) => rule._tag).sort()).toEqual([
      "Cardinality", "Cardinality", "Cardinality", "Cardinality",
      "Cardinality", "Cardinality", "Cardinality",
      "ReferenceTarget", "ReferenceTarget", "ReferenceTarget",
      "Required", "Required", "Required", "Required",
      "Unique",
    ]);
  });

  it("rejects dangling references, duplicate unique values, and a second value on a single-valued field", async () => {
    expect(await run([
      ["add-place", { place: "place:a", code: "A1" }],
      ["post-entry", { entry: "entry:1", place: "place:a" }],
      ["post-entry", { entry: "entry:2", place: "place:missing" }],
      ["add-place", { place: "place:b", code: "A1" }],
      ["label-place", { place: "place:a", label: "Dock" }],
      ["label-place", { place: "place:a", label: "Bay" }],
      ["stock", { entry: "entry:1", place: "place:a", note: "first" }],
      ["stock", { entry: "entry:1", place: "place:missing", note: "first" }],
      ["stock", { entry: "entry:1", place: "place:a", note: "again" }],
    ])).toEqual([
      "ok",
      "ok",
      "ConstraintViolationError",
      "ConstraintViolationError",
      "ok",
      "ConstraintViolationError",
      "ok",
      "ConstraintViolationError",
      "ConstraintViolationError",
    ]);
  });

  it("writes the same invocations unchecked with enforce: false", async () => {
    const unchecked = { enforce: false } as const;
    expect(await run([
      ["add-place", { place: "place:a", code: "A1" }, unchecked],
      ["post-entry", { entry: "entry:2", place: "place:missing" }, unchecked],
      ["add-place", { place: "place:b", code: "A1" }, unchecked],
      ["label-place", { place: "place:a", label: "Dock" }, unchecked],
      ["label-place", { place: "place:a", label: "Bay" }, unchecked],
    ])).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("checks references to seeded objects by their entity type", async () => {
    const runtime = makeOntologyRuntime(ir);
    const outcomes = await Effect.runPromise(Effect.gen(function* () {
      const triples = yield* Triples;
      yield* triples.transact([
        { op: "assert", entityId: EntityId.make("place:typed"), entityType: "Place", attribute: ":place/code", value: string("T") },
        { op: "assert", entityId: EntityId.make("place:untyped"), attribute: ":place/code", value: string("U") },
      ]);
      return yield* Effect.forEach(["place:typed", "place:untyped"], (place) =>
        Effect.result(runtime.invoke("post-entry", { entry: `entry:${place}`, place })).pipe(
          Effect.map((result) => (Result.isSuccess(result) ? "ok" : result.failure._tag)),
        ));
    }).pipe(Effect.provide(KvTriples.layer)));
    expect(outcomes).toEqual(["ok", "ConstraintViolationError"]);
  });

  it("leaves required fields unenforced unless the caller opts in", async () => {
    const withRequired = { enforce: GraphConstraint.enforcement(integrityConstraints(ir)) };
    expect(await run([
      ["note-entry", { entry: "entry:1", note: "no place" }],
      ["note-entry", { entry: "entry:2", note: "no place" }, withRequired],
    ])).toEqual(["ok", "ConstraintViolationError"]);
  });

  it("keeps clear-then-set replacing a required value under the default constraints", async () => {
    const replace = elaborateFormaOntology(`(define-entity Ticket
  (:field [ticket/title String {:required true}])
  (:field [ticket/status String {:required true}]))

(define-action open-ticket
  (:input [ticket String {:required true}])
  (:returns String)
  (:do (create Ticket ticket {:ticket/title "VPN drops" :ticket/status "open"})))

(define-action close-ticket
  (:input [ticket String {:required true}])
  (:returns String)
  (:do (changes
    (clear ticket :ticket/status)
    (set ticket :ticket/status "closed"))))
`, { name: "replace" });
    const runtime = makeOntologyRuntime(replace);
    const withRequired = { enforce: GraphConstraint.enforcement(integrityConstraints(replace)) };
    expect(await run([
      ["open-ticket", { ticket: "ticket:1" }],
      ["close-ticket", { ticket: "ticket:1" }],
      ["open-ticket", { ticket: "ticket:2" }],
      // Clear retracts the old status for all valid time, so the ticket lacks one when it opened.
      ["close-ticket", { ticket: "ticket:2" }, withRequired],
    ], runtime)).toEqual(["ok", "ok", "ok", "ConstraintViolationError"]);
  });
});
