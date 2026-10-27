import { Effect, Result, Schema } from "effect";
import { EntityId, KvTriples, Triples, string } from "@triplex-build/triplex";
import { describe, expect, it } from "vitest";
import { checkFormaSource } from "../scripts/check-model.js";
import {
  Change,
  Input,
  Ontology,
  Property,
  defineOntology,
  elaborateFormaOntology,
  makeOntologyRuntime,
  materializeOntology,
  ontologyToIR,
  toTriplexConfig,
  type OntologyRuntime,
} from "../src/index.js";

const source = `(define-entity Place
  (:field [place/code String {:required true}]))

(define-entity LedgerEntry
  (:field [ledger/place Place {:required true}])
  (:field [ledger/bucket (Enum custody prohibited committed) {:required true}])
  (:field [ledger/delta (Quantity EA) {:required true}])
  (:field [ledger/weight (Decimal 3)])
  (:field [ledger/mass (Quantity KG 3)])
  (:field [ledger/line Int]))

(define-action post-entry
  (:input [entry String {:required true}])
  (:input [place String {:required true}])
  (:input [bucket (Enum custody prohibited committed) {:required true}])
  (:input [delta (Quantity EA) {:required true}])
  (:input [weight (Decimal 3) {:required true}])
  (:input [line Int {:required true}])
  (:returns String)
  (:do (create LedgerEntry entry
         {:ledger/place place
          :ledger/bucket bucket
          :ledger/delta delta
          :ledger/weight weight
          :ledger/line line})))

(define-action hold
  (:input [entry String {:required true}])
  (:input [bucket String {:required true}])
  (:returns String)
  (:do (create LedgerEntry entry {:ledger/bucket bucket :ledger/delta -1})))
`;

const Place = Ontology.ObjectType("Place", {
  properties: { code: Property.make(":place/code", Schema.String).required() },
});
const LedgerEntry = Ontology.ObjectType("LedgerEntry", {
  properties: {
    place: Property.ref(":ledger/place", Place).required(),
    bucket: Property.enum(":ledger/bucket", ["custody", "prohibited", "committed"]).required(),
    delta: Property.quantity(":ledger/delta", "EA").required(),
    weight: Property.decimal(":ledger/weight", 3),
    mass: Property.quantity(":ledger/mass", "KG", 3),
    line: Property.int(":ledger/line"),
  },
});
const ledger = LedgerEntry.properties;
const typescript = defineOntology({ name: "ledger", version: "1" }, [
  Place,
  LedgerEntry,
  Ontology.ActionType("post-entry", {
    input: Schema.Struct({
      entry: Schema.String,
      place: Schema.String,
      bucket: ledger.bucket.schema,
      delta: ledger.delta.schema,
      weight: ledger.weight.schema,
      line: ledger.line.schema,
    }),
    changes: [Change.create(LedgerEntry, Input.value("entry"), {
      ":ledger/place": Input.value("place"),
      ":ledger/bucket": Input.value("bucket"),
      ":ledger/delta": Input.value("delta"),
      ":ledger/weight": Input.value("weight"),
      ":ledger/line": Input.value("line"),
    })],
  }),
  Ontology.ActionType("hold", {
    input: Schema.Struct({ entry: Schema.String, bucket: Schema.String }),
    changes: [Change.create(LedgerEntry, Input.value("entry"), {
      ":ledger/bucket": Input.value("bucket"),
      ":ledger/delta": -1,
    })],
  }),
]);

const ir = elaborateFormaOntology(source, { name: "ledger", version: "1" });
const valid = { entry: "entry:1", place: "place:a", bucket: "custody", delta: 10, weight: "1.5", line: 1 };

const withSeed = <A, E>(body: (runtime: OntologyRuntime) => Effect.Effect<A, E, Triples>) =>
  Effect.runPromise(Effect.gen(function* () {
    const triples = yield* Triples;
    yield* triples.transact([
      { op: "assert", entityId: EntityId.make("place:a"), entityType: "Place", attribute: ":place/code", value: string("A") },
    ]);
    return yield* body(makeOntologyRuntime(ir));
  }).pipe(Effect.provide(KvTriples.layer)));

describe("value types", () => {
  it("elaborates Int, Enum, Decimal, and Quantity the same from Forma and TypeScript", () => {
    expect(ir.objectTypes[1]?.properties.map(({ valueType }) => valueType)).toEqual([
      { kind: "ref", target: "Place" },
      { kind: "enum", values: ["custody", "prohibited", "committed"] },
      { kind: "quantity", unit: "EA" },
      { kind: "decimal", scale: 3 },
      { kind: "quantity", unit: "KG", scale: 3 },
      { kind: "integer" },
    ]);
    expect(ontologyToIR(typescript)).toEqual(ir);
    expect(Property.make(":a/b", Schema.Int).valueType).toEqual({ kind: "integer" });
    expect(Property.make(":a/b", Schema.Literals(["x", "y"])).valueType).toEqual({ kind: "enum", values: ["x", "y"] });
  });

  it("round-trips the new kinds through JSON and compiles them to Triplex configuration", async () => {
    const restored = materializeOntology(JSON.parse(JSON.stringify(ir)));
    expect(ontologyToIR(restored)).toEqual(ir);
    expect(ir.actionTypes[0]?.inputSchema?.schema).toMatchObject({
      properties: {
        bucket: { type: "string", enum: ["custody", "prohibited", "committed"] },
        delta: { type: "integer" },
        weight: { type: "string", pattern: "^-?(0|[1-9]\\d*)(\\.\\d{1,3})?$" },
        line: { type: "integer" },
      },
    });
    const nodes = await Effect.runPromise(toTriplexConfig(ir).nodes);
    expect(nodes.length).toBeGreaterThan(1);
  });

  it("stores integers and quantities as numbers, enums as strings, and decimals in canonical form", async () => {
    const facts = await withSeed((runtime) => Effect.gen(function* () {
      yield* runtime.invoke("post-entry", valid);
      yield* runtime.invoke("post-entry", { ...valid, entry: "entry:2", weight: "-0", delta: -3 });
      yield* runtime.invoke("hold", { entry: "entry:3", bucket: "committed" });
      const triples = yield* Triples;
      const values = (id: string) =>
        triples.entity(EntityId.make(id)).pipe(Effect.map((rows) =>
          Object.fromEntries(rows.map((row) => [row.attribute, row.value]))));
      return yield* Effect.all([values("entry:1"), values("entry:2"), values("entry:3")]);
    }));
    expect(facts[0]).toMatchObject({
      ":ledger/bucket": { type: "string", value: "custody" },
      ":ledger/delta": { type: "number", value: 10 },
      ":ledger/weight": { type: "string", value: "1.500" },
      ":ledger/line": { type: "number", value: 1 },
    });
    expect(facts[1]).toMatchObject({ ":ledger/weight": { value: "0.000" }, ":ledger/delta": { value: -3 } });
    expect(facts[2]).toMatchObject({ ":ledger/bucket": { value: "committed" }, ":ledger/delta": { value: -1 } });
  });

  it.each([
    ["a fractional integer", { line: 1.5 }],
    ["a fractional quantity", { delta: 2.5 }],
    ["an enum value outside the set", { bucket: "lost" }],
    ["a decimal with too many digits", { weight: "1.2345" }],
    ["a decimal number", { weight: 1.5 }],
  ] as const)("rejects %s before writing", async (_name, change) => {
    const outcome = await withSeed((runtime) => Effect.result(runtime.invoke("post-entry", { ...valid, ...change })));
    expect(Result.isFailure(outcome)).toBe(true);
  });

  it("checks values that reach a typed property through an untyped input", async () => {
    await expect(withSeed((runtime) => runtime.invoke("hold", { entry: "entry:1", bucket: "lost" })))
      .rejects.toThrow('Property :ledger/bucket expects enum(custody|prohibited|committed); received "lost"');
  });

  it("summarizes the new kinds in model:check", () => {
    expect(checkFormaSource(source, { name: "ledger" }).summary.slice(1, 3)).toEqual([
      "object  LedgerEntry  :ledger/place Place!, :ledger/bucket enum(custody|prohibited|committed)!, :ledger/delta quantity(EA)!, :ledger/weight decimal(3), :ledger/mass quantity(KG, 3), :ledger/line integer",
      "action  post-entry(entry string!, place string!, bucket enum(custody|prohibited|committed)!, delta quantity(EA)!, weight decimal(3)!, line integer!)  create LedgerEntry",
    ]);
  });

  const entity = "(define-entity Item (:field [item/code String]))\n";
  it.each([
    ["a misspelt type", "(define-entity Item (:field [item/weight Deciml]))", "Property :item/weight has unknown type Deciml; did you mean Decimal?"],
    ["an undeclared type", "(define-entity Item (:field [item/bin Warehouse]))", "Property :item/bin has unknown type Warehouse; declare (define-entity Warehouse ...) or use a built-in type"],
    ["a misspelt input type", `${entity}(define-action a (:input [n Strng {:required true}]) (:returns String) (:do (create Item "item:1" {:item/code "a"})))`, "Action a input n has unknown type Strng; did you mean String?"],
    ["a bare Decimal", "(define-entity Item (:field [item/weight Decimal]))", "Decimal needs arguments, for example (Decimal 2)"],
    ["a Decimal without a scale", "(define-entity Item (:field [item/weight (Decimal)]))", "Decimal takes one scale, for example (Decimal 2)"],
    ["a negative scale", "(define-entity Item (:field [item/weight (Decimal -1)]))", "A decimal scale must be a non-negative integer"],
    ["a Quantity without a unit", "(define-entity Item (:field [item/qty (Quantity)]))", "Quantity takes a unit and an optional scale, for example (Quantity KG 3)"],
    ["a repeated enum value", "(define-entity Item (:field [item/state (Enum open open)]))", "An enum needs one or more distinct, non-empty string values"],
    ["an enum literal outside the set", "(define-entity Item (:field [item/state (Enum open closed)]))\n(define-action a (:input [i String {:required true}]) (:returns String) (:do (create Item i {:item/state \"opne\"})))", "Action a writes :item/state, which expects enum(open|closed); received \"opne\""],
    ["a fractional integer literal", "(define-entity Item (:field [item/count Int]))\n(define-action a (:input [i String {:required true}]) (:returns String) (:do (set i :item/count 1.5)))", "Action a writes :item/count, which expects integer; received 1.5"],
  ] as const)("reports %s", (_name, model, message) => {
    const result = checkFormaSource(model, { name: "types" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([message]);
  });

  it("warns when a query does arithmetic or ordering on decimal strings", () => {
    const query = `${source}
(define-datalog-query heavy
  (:query {:find ["?total"]
           :where [["?e" ":ledger/weight" "?w"] [">" "?w" "1.000"]]
           :aggregate [["sum" "?w" "?total"]]}))`;
    expect(checkFormaSource(query, { name: "ledger" }).diagnostics.map(({ message }) => message)).toEqual([
      "Query heavy applies sum to ?w, but :ledger/weight holds decimal strings; the result is not a decimal sum",
      "Query heavy compares with >, but :ledger/weight holds decimal strings, which compare as text",
    ]);
  });
});
