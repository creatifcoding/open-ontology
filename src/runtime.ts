import { Effect, Schema } from "effect";
import {
  EntityId,
  Triples,
  boolean,
  datetime,
  json,
  number,
  ref,
  string,
  type DatalogQuery,
  type QueryResponse,
  type TransactOp,
  type TransactionMeta,
  type TripleValue,
} from "@triplex-build/triplex";
import {
  Attribute as ConfigAttribute,
  ConfigNode,
  EntityType,
  GraphConstraint,
} from "@triplex-build/triplex/config";
import type {
  ActionTypeDefinition,
  ActionValue,
  LinkTypeDefinition,
  OntologyDefinition,
  PropertyDefinition,
  QueryTypeDefinition,
} from "./model.js";
import { isOntologyIR, type OntologyIR } from "./ir.js";
import { materializeOntology, ontologyToIR } from "./materialize.js";

export interface ActionInvocationOptions {
  readonly actor?: string;
  readonly commandId?: string;
  readonly correlationId?: string;
  readonly now?: number;
  readonly configSnapshot?: TransactionMeta["configSnapshot"];
  /**
   * Constraints checked against the transaction's post-state. Defaults to the ontology's
   * single-value, unique, and reference-target constraints; pass `false` to write unchecked.
   */
  readonly enforce?: TransactionMeta["enforce"] | false;
}

export type OntologyQueryResponse<Row> = Omit<QueryResponse, "results"> & {
  readonly results: readonly Row[];
};

type QueryRow<Reference> =
  Reference extends QueryTypeDefinition<infer Row> ? Row : Readonly<Record<string, unknown>>;

const resolveQuery = (
  ontology: OntologyDefinition,
  reference: string | DatalogQuery | QueryTypeDefinition<any>,
): DatalogQuery | undefined => {
  if (typeof reference === "string") return ontology.queryTypes.get(reference)?.query;
  if ("_tag" in reference && reference._tag === "QueryType") {
    return (reference as QueryTypeDefinition<any>).query;
  }
  return reference as DatalogQuery;
};

type TriplexEntityType = EntityType.EntityType<string, any>;
type EntityDefinition = {
  readonly name: string;
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
};

export interface TriplexOntologyConfig {
  readonly objectTypes: ReadonlyMap<string, TriplexEntityType>;
  readonly linkTypes: ReadonlyMap<string, TriplexEntityType>;
  readonly nodes: Effect.Effect<readonly ConfigNode.ConfigNode[], Error>;
  readonly constraints: readonly GraphConstraint.Definition[];
}

const triplexAttribute = (
  property: PropertyDefinition,
  objectTypes: ReadonlyMap<string, TriplexEntityType>,
) => {
  switch (property.kind) {
    case "string":
      return ConfigAttribute.text(property.key);
    case "number":
      return ConfigAttribute.number(property.key);
    case "boolean":
      return ConfigAttribute.boolean(property.key);
    case "datetime":
      return ConfigAttribute.instant(property.key);
    case "ref": {
      const target = property.target && objectTypes.get(property.target.name);
      if (!target) throw new TypeError(`Reference ${property.key} has no compiled target`);
      return ConfigAttribute.ref(property.key, target);
    }
    case "json":
      throw new TypeError(
        `Triplex configuration does not yet expose a JSON attribute: ${property.key}`,
      );
  }
};

const compileEntity = (
  definition: EntityDefinition,
  objectTypes: ReadonlyMap<string, TriplexEntityType>,
) => {
  const attributes = Object.fromEntries(
    Object.entries(definition.properties).map(([alias, property]) => [
      alias,
      ConfigAttribute.use(triplexAttribute(property, objectTypes), {
        required: property.isRequired,
        cardinality: property.cardinality,
        unique: property.isUnique,
      }),
    ]),
  );
  return EntityType.make(definition.name, { attributes });
};

const linkEntityName = (link: LinkTypeDefinition): string =>
  `${link.name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Link`;

const entityConstraints = (definition: EntityDefinition): GraphConstraint.Definition[] =>
  Object.values(definition.properties).flatMap((property) => [
    ...(property.isRequired ? [GraphConstraint.required(definition.name, property.key)] : []),
    ...(property.cardinality === "one"
      ? [GraphConstraint.cardinality(definition.name, property.key, 1)]
      : []),
    ...(property.isUnique ? [GraphConstraint.unique(definition.name, property.key)] : []),
    ...(property.kind === "ref" && property.target
      ? [GraphConstraint.referenceTarget(definition.name, property.key, property.target.name)]
      : []),
  ]);

/**
 * The required, single-value, unique, and reference-target constraints an ontology declares, in
 * the form Triplex enforces on write. Matches `toTriplexConfig(...).constraints` and also covers
 * JSON properties, which Triplex configuration cannot compile yet.
 */
export const integrityConstraints = (
  source: OntologyDefinition | OntologyIR,
): readonly GraphConstraint.Definition[] => {
  const ontology = isOntologyIR(source) ? materializeOntology(source) : source;
  return [
    ...[...ontology.objectTypes.values()].flatMap(entityConstraints),
    ...[...ontology.linkTypes.values()].flatMap((link) =>
      entityConstraints({
        name: linkEntityName(link),
        properties: { ...link.endpoints, ...link.properties },
      }),
    ),
  ];
};

/** Compile ontology entities and their portable definition into one Triplex configuration snapshot. */
export const toTriplexConfig = (source: OntologyDefinition | OntologyIR): TriplexOntologyConfig => {
  const ir = isOntologyIR(source) ? source : ontologyToIR(source);
  const ontology = isOntologyIR(source) ? materializeOntology(source) : source;
  const objectTypes = new Map<string, TriplexEntityType>();

  // Scalar object types establish the reference targets used by later passes.
  for (const definition of ontology.objectTypes.values()) {
    const withoutRefs: EntityDefinition = {
      ...definition,
      properties: Object.fromEntries(
        Object.entries(definition.properties).filter(([, property]) => property.kind !== "ref"),
      ),
    };
    objectTypes.set(definition.name, compileEntity(withoutRefs, objectTypes));
  }
  for (const definition of ontology.objectTypes.values()) {
    objectTypes.set(definition.name, compileEntity(definition, objectTypes));
  }

  const linkTypes = new Map<string, TriplexEntityType>();
  for (const link of ontology.linkTypes.values()) {
    const from = objectTypes.get(link.from.name);
    const to = objectTypes.get(link.to.name);
    if (!from || !to) throw new TypeError(`Link ${link.name} has an unresolved endpoint`);
    const definition: EntityDefinition = {
      name: linkEntityName(link),
      properties: { ...link.endpoints, ...link.properties },
    };
    linkTypes.set(link.name, compileEntity(definition, objectTypes));
  }

  const entities = [...objectTypes.values(), ...linkTypes.values()];
  return {
    objectTypes,
    linkTypes,
    nodes: Effect.mapError(
      Effect.gen(function* () {
        const groups = yield* Effect.all(entities.map((entity) => entity.nodes));
        const sourceNode = yield* ConfigNode.make({
          kind: "open-ontology.definition",
          key: ir.name,
          attrs: { formatVersion: 1, source: JSON.stringify(ir) },
        });
        return [...groups.flat(), sourceNode];
      }),
      (error) => (error instanceof Error ? error : new Error(String(error))),
    ),
    constraints: entities.flatMap((entity) => entity.constraints),
  };
};

const resolveValue = (
  value: ActionValue,
  input: Readonly<Record<string, unknown>>,
  now: number,
): unknown => {
  if (typeof value !== "object" || value === null) return value;
  if (value._tag === "Now") return now;
  if (!(value.name in input)) throw new TypeError(`Missing action input: ${value.name}`);
  return input[value.name];
};

const encodeValue = (property: PropertyDefinition, value: unknown): TripleValue => {
  switch (property.kind) {
    case "string":
      return string(String(value));
    case "number":
      return number(Number(value));
    case "boolean":
      return boolean(Boolean(value));
    case "datetime":
      return datetime(value instanceof Date ? value : Number(value));
    case "ref":
      return ref(EntityId.make(String(value)));
    case "json":
      return json(value);
  }
};

const assertion = (
  objectType: string,
  object: unknown,
  property: PropertyDefinition,
  value: unknown,
): TransactOp => ({
  op: "assert",
  entityId: EntityId.make(String(object)),
  entityType: objectType,
  attribute: property.key,
  value: encodeValue(property, value),
});

const propertyByKey = (
  properties: Readonly<Record<string, PropertyDefinition>>,
  key: string,
): PropertyDefinition => {
  const property = Object.values(properties).find((candidate) => candidate.key === key);
  if (!property) throw new TypeError(`Unknown property ${key}`);
  return property;
};

const ownerOf = (ontology: OntologyDefinition, property: PropertyDefinition): string =>
  [...ontology.objectTypes.values()].find((objectType) =>
    Object.values(objectType.properties).some(
      (candidate) => candidate === property || candidate.key === property.key,
    ),
  )?.name ?? "Object";

const changesToOperations = (
  ontology: OntologyDefinition,
  action: ActionTypeDefinition,
  input: Readonly<Record<string, unknown>>,
  now: number,
): readonly TransactOp[] => {
  const operations: TransactOp[] = [];
  for (const change of action.changes) {
    switch (change._tag) {
      case "CreateObject": {
        const id = resolveValue(change.id, input, now);
        for (const [key, expression] of Object.entries(change.properties)) {
          const property = propertyByKey(change.objectType.properties, key);
          operations.push(
            assertion(change.objectType.name, id, property, resolveValue(expression, input, now)),
          );
        }
        break;
      }
      case "SetProperty":
        operations.push(
          assertion(
            ownerOf(ontology, change.property),
            resolveValue(change.object, input, now),
            change.property,
            resolveValue(change.value, input, now),
          ),
        );
        break;
      case "ClearProperty":
        operations.push({
          op: "retract-pattern",
          pattern: {
            entityId: EntityId.make(String(resolveValue(change.object, input, now))),
            attribute: change.property.key,
          },
        });
        break;
      case "CreateLink": {
        const from = String(resolveValue(change.from, input, now));
        const to = String(resolveValue(change.to, input, now));
        const id = `link:${change.linkType.name}:${from}:${to}`;
        const entityType = linkEntityName(change.linkType);
        operations.push(assertion(entityType, id, change.linkType.endpoints.from, from));
        operations.push(assertion(entityType, id, change.linkType.endpoints.to, to));
        for (const [key, expression] of Object.entries(change.properties)) {
          operations.push(
            assertion(
              entityType,
              id,
              propertyByKey(change.linkType.properties, key),
              resolveValue(expression, input, now),
            ),
          );
        }
        break;
      }
    }
  }
  return operations;
};

/**
 * Bind an ontology's named actions and queries to a caller-provided Triplex layer. Actions
 * enforce single-value, unique, and reference-target constraints unless invoked with
 * `enforce: false`.
 */
export const makeOntologyRuntime = (source: OntologyDefinition | OntologyIR) => {
  const ontology = isOntologyIR(source) ? materializeOntology(source) : source;
  // Required constraints stay opt-in. `clear` retracts a value for all valid time, and Triplex
  // checks every valid-time boundary, so clear-then-set would fail at each earlier boundary.
  const integrity = GraphConstraint.enforcement(
    integrityConstraints(ontology).filter(({ rule }) => rule._tag !== "Required"),
  );
  return {
    invoke: <I>(
      actionRef: string | ActionTypeDefinition<I>,
      rawInput: I,
      options: ActionInvocationOptions = {},
    ) =>
      Effect.gen(function* () {
        const action =
          typeof actionRef === "string" ? ontology.actionTypes.get(actionRef) : actionRef;
        if (!action) throw new TypeError(`Unknown action type: ${String(actionRef)}`);
        const input = yield* Schema.decodeUnknownEffect(action.input)(rawInput);
        const triples = yield* Triples;
        const now = options.now ?? Date.now();
        return yield* triples.transact(
          changesToOperations(ontology, action, input as Readonly<Record<string, unknown>>, now),
          {
            ...(options.actor === undefined ? {} : { actor: options.actor }),
            ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
            ...(options.correlationId === undefined
              ? {}
              : { correlationId: options.correlationId }),
            ...(options.configSnapshot === undefined
              ? {}
              : { configSnapshot: options.configSnapshot }),
            ...(options.enforce === false ? {} : { enforce: options.enforce ?? integrity }),
          },
        );
      }),
    query: <Reference extends string | DatalogQuery | QueryTypeDefinition<any>>(
      queryRef: Reference,
    ) =>
      Effect.gen(function* () {
        const query = resolveQuery(ontology, queryRef);
        if (!query) throw new TypeError(`Unknown query type: ${String(queryRef)}`);
        const triples = yield* Triples;
        return (yield* triples.queryAll(query)) as OntologyQueryResponse<QueryRow<Reference>>;
      }),
  };
};

export type OntologyRuntime = ReturnType<typeof makeOntologyRuntime>;
