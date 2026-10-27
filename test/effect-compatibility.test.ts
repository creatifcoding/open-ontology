import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Result, Schema } from "effect";
import { DatabaseId, EntityId, KvTriples, TransactionId, TripleId, Triples, string, type DatalogQuery } from "@triplex-build/triplex";
import { describe, expect, it } from "vitest";
import { Change, Input, Ontology, Property, defineOntology, makeOntologyRuntime, materializeOntology, ontologyToIR, toTriplexConfig } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const release = /^\d+\.\d+\.\d+$/;
// The Effect copy a pnpm-installed dependency resolves, as a real path.
const effectOf = (packageName: string): string =>
  realpathSync(`${realpathSync(`${root}node_modules/${packageName}`)}/${"../".repeat(packageName.split("/").length)}effect`);

describe("Effect 4 compatibility", () => {
  it("installs one Effect copy inside the declared peer range", () => {
    const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
      readonly peerDependencies: { readonly effect: string };
      readonly devDependencies: { readonly effect: string };
    };
    const range = manifest.peerDependencies.effect;
    expect(range).toMatch(/^\^4\.\d+\.\d+$/);
    const floor = range.slice(1);
    // The lockfile tests the floor; the CI job that resolves the newest 4.x release tests the ceiling.
    if (release.test(manifest.devDependencies.effect)) expect(manifest.devDependencies.effect).toBe(floor);
    const installed: string = JSON.parse(readFileSync(`${root}node_modules/effect/package.json`, "utf8")).version;
    expect(installed).toMatch(release);
    expect(installed.split(".")[0]).toBe("4");
    expect(installed.localeCompare(floor, undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
    const own = realpathSync(`${root}node_modules/effect`);
    expect(effectOf("@formalang/ts")).toBe(own);
    expect(effectOf("@triplex-build/triplex")).toBe(own);
  });

  it.each([Schema.Date, Schema.NumberFromString])("rejects nonportable action inputs: %s", (schema) => {
    const action = Ontology.ActionType("nonportable", {
      input: Schema.Struct({ value: schema }),
      changes: [],
    });
    expect(() => ontologyToIR(defineOntology({ name: "invalid" }, [action])))
      .toThrow("cannot be restored from portable JSON Schema");
  });

  it.each([
    ["non-Unicode patterns", Schema.String.check(Schema.isPattern(/^\S/))],
    ["UTF-16 length approximations", Schema.String.check(Schema.isMinLength(2))],
  ] as const)("rejects approximate JSON Schema checks: %s", (_name, schema) => {
    const action = Ontology.ActionType("approximate", {
      input: Schema.Struct({ value: schema }),
      changes: [],
    });
    expect(() => ontologyToIR(defineOntology({ name: "invalid" }, [action])))
      .toThrow("cannot be reflected to JSON Schema");
  });

  it("preserves Triplex branded-id constructors and schema validation", () => {
    const cases: readonly (readonly [
      Schema.Schema<string> & { readonly DecodingServices: never; readonly make: (value: string) => string; readonly decode: (value: string) => Effect.Effect<string, Schema.SchemaError> },
      string,
      string,
    ])[] = [
      [EntityId, "item:é", ""],
      [DatabaseId, "local-db", "INVALID"],
      [TripleId, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "short"],
      [TransactionId, "_tx/01ARZ3NDEKTSV4RRFFQ69G5FAV", "invalid"],
    ];
    for (const [schema, valid, invalid] of cases) {
      expect(schema.make(valid)).toBe(valid);
      expect(Effect.runSync(schema.decode(valid))).toBe(valid);
      expect(Schema.decodeUnknownSync(schema)(valid)).toBe(valid);
      expect(() => schema.make(invalid)).toThrow();
      expect(Result.isFailure(Effect.runSync(Effect.result(schema.decode(invalid))))).toBe(true);
    }
  });

  it("restores portable action checks and executes Triplex configuration and actions", async () => {
    const item = Ontology.ObjectType("Item", {
      properties: { title: Property.make(":item/title", Schema.String).required() },
    });
    const action = Ontology.ActionType("create-item", {
      input: Schema.Struct({
        id: Schema.String,
        title: Schema.String.check(Schema.isMinCodePoints(2), Schema.isPattern(/^\S/u)),
        priority: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        note: Schema.optional(Schema.String),
      }),
      changes: [Change.create(item, Input.value("id"), { ":item/title": Input.value("title") })],
    });
    const ir = ontologyToIR(defineOntology({ name: "compatibility" }, [item, action]));
    const restored = materializeOntology(JSON.parse(JSON.stringify(ir)));
    expect(ontologyToIR(restored)).toEqual(ir);
    const runtime = makeOntologyRuntime(restored);
    const result = await Effect.runPromise(Effect.gen(function* () {
      const nodes = yield* toTriplexConfig(ir).nodes;
      const valid = { id: "item:é", title: "Café", priority: 1 };
      for (const input of [
        { ...valid, title: "x" },
        { ...valid, title: " space" },
        { ...valid, priority: 0 },
        { ...valid, priority: 1.5 },
        { ...valid, note: 42 },
      ]) {
        expect(Result.isFailure(yield* Effect.result(runtime.invoke("create-item", input)))).toBe(true);
      }
      yield* runtime.invoke("create-item", valid);
      const triples = yield* Triples;
      return { nodes, facts: yield* triples.entity(EntityId.make(valid.id)) };
    }).pipe(Effect.provide(KvTriples.layer)));
    expect(result.nodes.length).toBeGreaterThan(1);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.value).toEqual(string("Café"));
  });

  it("continues query and entity cursors at their original snapshot and rejects invalid cursors", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const triples = yield* Triples;
      yield* triples.transact(["a", "b", "c"].map((id) => ({
        op: "assert" as const,
        entityId: EntityId.make(`item:${id}`),
        entityType: "Item",
        attribute: ":item/title",
        value: string(`Café ${id}`),
      })));
      const query: DatalogQuery = { find: ["?title"], where: [["?item", ":item/title", "?title"]] };
      const firstQuery = yield* triples.query(query, { pageSize: 1 });
      const firstEntities = yield* triples.entityPage({ entityType: "Item", limit: 1 });
      expect(firstQuery.nextCursor).toEqual(expect.any(String));
      expect(firstEntities.nextCursor).toEqual(expect.any(String));
      // A later commit must not enter either continuation's captured snapshot.
      yield* triples.transact([{
        op: "assert", entityId: EntityId.make("item:bb"), entityType: "Item",
        attribute: ":item/title", value: string("Café bb"),
      }]);
      const secondQuery = yield* triples.query(query, { pageSize: 1, cursor: firstQuery.nextCursor! });
      const thirdQuery = yield* triples.query(query, { pageSize: 1, cursor: secondQuery.nextCursor! });
      expect([firstQuery, secondQuery, thirdQuery].flatMap((page) => page.results)).toEqual([
        { "?title": "Café a" }, { "?title": "Café b" }, { "?title": "Café c" },
      ]);
      expect(thirdQuery.nextCursor).toBeUndefined();
      const remainingEntities = yield* triples.entityPage({ entityType: "Item", limit: 2, cursor: firstEntities.nextCursor! });
      expect(remainingEntities.entities.map((facts) => facts[0]?.entityId)).toEqual(["item:b", "item:c"]);
      expect(remainingEntities.snapshot).toEqual(firstEntities.snapshot);
      expect(remainingEntities.nextCursor).toBeUndefined();
      const malformedQuery = yield* Effect.result(triples.query(query, { cursor: "%%%" }));
      const malformedEntities = yield* Effect.result(triples.entityPage({ entityType: "Item", cursor: "%%%" }));
      const wrongEntityType = yield* Effect.result(triples.entityPage({ entityType: "Other", cursor: firstEntities.nextCursor! }));
      const wrongQuery = yield* Effect.result(triples.query({ find: ["?item"], where: query.where }, { pageSize: 1, cursor: firstQuery.nextCursor! }));
      for (const result of [malformedQuery, malformedEntities]) {
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PaginationCursorError", reason: "malformed" } });
      }
      for (const result of [wrongEntityType, wrongQuery]) {
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PaginationCursorError", reason: "query_mismatch" } });
      }
    }).pipe(Effect.provide(KvTriples.layer)));
  });
});
