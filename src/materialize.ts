import { Schema, SchemaRepresentation } from "effect";
import type { DatalogQuery } from "@triplex-build/triplex";
import { Change, Input, Ontology, Property, defineOntology } from "./dsl.js";
import type {
  ActionChange,
  ActionValue,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDeclaration,
  OntologyDefinition,
  PropertyDefinition,
} from "./model.js";
import type {
  ActionChangeIR,
  ActionInputIR,
  ActionTypeIR,
  ActionValueIR,
  DatalogQueryIR,
  OntologyIR,
  PropertyIR,
} from "./ir.js";
import { assertValueType, valueTypeSchema } from "./value-types.js";

const valueToIR = (value: ActionValue): ActionValueIR => {
  if (typeof value !== "object" || value === null) return value;
  return value._tag === "Now" ? { kind: "now" } : { kind: "input", name: value.name };
};

const valueFromIR = (value: ActionValueIR): ActionValue => {
  if (typeof value !== "object" || value === null) return value;
  return value.kind === "now" ? Input.now : Input.value(value.name);
};

const propertyToIR = (_name: string, property: PropertyDefinition): PropertyIR => ({
  name: property.key.slice(property.key.indexOf("/") + 1),
  key: property.key,
  valueType:
    property.kind === "ref"
      ? { kind: "ref", target: property.target?.name ?? "Object" }
      : property.valueType,
  required: property.isRequired,
  cardinality: property.cardinality,
  unique: property.isUnique,
});

const changeToIR = (change: ActionChange): ActionChangeIR => {
  switch (change._tag) {
    case "CreateObject":
      return {
        kind: "create-object",
        objectType: change.objectType.name,
        id: valueToIR(change.id),
        properties: Object.fromEntries(
          Object.entries(change.properties).map(([key, value]) => [key, valueToIR(value)]),
        ),
      };
    case "SetProperty":
      return {
        kind: "set-property",
        object: valueToIR(change.object),
        property: change.property.key,
        value: valueToIR(change.value),
      };
    case "ClearProperty":
      return {
        kind: "clear-property",
        object: valueToIR(change.object),
        property: change.property.key,
      };
    case "CreateLink":
      return {
        kind: "create-link",
        linkType: change.linkType.name,
        from: valueToIR(change.from),
        to: valueToIR(change.to),
        properties: Object.fromEntries(
          Object.entries(change.properties).map(([key, value]) => [key, valueToIR(value)]),
        ),
      };
  }
};

type PortableAst = {
  readonly _tag?: string;
  readonly encoding?: readonly unknown[];
  readonly checks?: readonly {
    readonly annotations?: {
      readonly toJsonSchema?: (context: {
        readonly type: string;
        readonly schemas: readonly unknown[];
      }) => unknown;
    };
  }[];
  readonly encodingChecks?: readonly unknown[];
  readonly propertySignatures?: readonly { readonly type: PortableAst }[];
  readonly indexSignatures?: readonly {
    readonly parameter: PortableAst;
    readonly type: PortableAst;
  }[];
  readonly types?: readonly PortableAst[];
  readonly elements?: readonly PortableAst[];
  readonly rest?: readonly PortableAst[];
};

const assertPortableActionSchema = (ast: PortableAst, path: string): void => {
  if (
    ast._tag === "Declaration" ||
    (ast.encoding?.length ?? 0) > 0 ||
    (ast.encodingChecks?.length ?? 0) > 0
  ) {
    throw new TypeError(
      `Action input ${path} uses a declaration or transform that cannot be restored from portable JSON Schema`,
    );
  }
  const type =
    ast._tag === "Arrays"
      ? "array"
      : ast._tag === "Objects"
        ? "object"
        : (ast._tag?.toLowerCase() ?? "unknown");
  for (const check of ast.checks ?? []) {
    let reflected: unknown;
    try {
      reflected = check.annotations?.toJsonSchema?.({ type, schemas: [] });
    } catch {
      throw new TypeError(
        `Action input ${path} has a check that cannot be reflected to JSON Schema`,
      );
    }
    if (
      typeof reflected !== "object" ||
      reflected === null ||
      // Effect 4 marks approximate check exports as [schema, true].
      // They cannot preserve the action's validation after a JSON round trip.
      Array.isArray(reflected) ||
      Object.keys(reflected).length === 0
    ) {
      throw new TypeError(
        `Action input ${path} has a check that cannot be reflected to JSON Schema`,
      );
    }
  }
  for (const property of ast.propertySignatures ?? []) {
    assertPortableActionSchema(property.type, path);
  }
  for (const index of ast.indexSignatures ?? []) {
    assertPortableActionSchema(index.parameter, path);
    assertPortableActionSchema(index.type, path);
  }
  for (const member of [...(ast.types ?? []), ...(ast.elements ?? []), ...(ast.rest ?? [])]) {
    assertPortableActionSchema(member, path);
  }
};

// Effect's JSON Schema importer can change the AST and emitted document shape.
// Retain the source document for restored schemas to keep IR round trips lossless.
const restoredInputSchemas = new WeakMap<
  Schema.Schema<unknown>,
  NonNullable<ActionTypeIR["inputSchema"]>
>();

const actionInputSchema = (schema: Schema.Schema<unknown>, name: string) => {
  const restored = restoredInputSchemas.get(schema);
  if (restored) return restored;
  assertPortableActionSchema(schema.ast as PortableAst, name);
  return Schema.toJsonSchemaDocument(schema);
};

/** Project the Effect authoring surface into the same JSON-safe IR produced by Forma. */
export const ontologyToIR = (ontology: OntologyDefinition): OntologyIR => ({
  kind: "ontology",
  name: ontology.name,
  version: ontology.version,
  objectTypes: [...ontology.objectTypes.values()].map((object) => ({
    kind: "object-type",
    name: object.name,
    ...(object.description === undefined ? {} : { description: object.description }),
    properties: Object.entries(object.properties).map(([name, property]) =>
      propertyToIR(name, property),
    ),
  })),
  linkTypes: [...ontology.linkTypes.values()].map((link) => ({
    kind: "link-type",
    name: link.name,
    from: link.from.name,
    to: link.to.name,
    ...(link.description === undefined ? {} : { description: link.description }),
    properties: Object.entries(link.properties).map(([name, property]) =>
      propertyToIR(name, property),
    ),
  })),
  actionTypes: [...ontology.actionTypes.values()].map((action) => ({
    kind: "action-type",
    name: action.name,
    ...(action.description === undefined ? {} : { description: action.description }),
    input: action.inputFields,
    inputSchema: actionInputSchema(action.input, action.name),
    changes: action.changes.map(changeToIR),
  })),
  queryTypes: [...ontology.queryTypes.values()].map((query) => ({
    kind: "query-type",
    name: query.name,
    ...(query.description === undefined ? {} : { description: query.description }),
    query: query.query as DatalogQueryIR,
  })),
});

const actionSchemaFromFields = (inputs: readonly ActionInputIR[]) =>
  Schema.Struct(
    Object.fromEntries(
      inputs.map((input) => [
        input.name,
        input.optional
          ? Schema.optional(
              input.cardinality === "many"
                ? Schema.Array(valueTypeSchema(input.valueType))
                : valueTypeSchema(input.valueType),
            )
          : input.cardinality === "many"
            ? Schema.Array(valueTypeSchema(input.valueType))
            : valueTypeSchema(input.valueType),
      ]),
    ),
  );

export const actionInputSchemaFromFields = (inputs: readonly ActionInputIR[]) =>
  Schema.toJsonSchemaDocument(actionSchemaFromFields(inputs));

const propertyFromIR = (
  property: PropertyIR,
  objects: ReadonlyMap<string, ObjectTypeDefinition>,
): PropertyDefinition => {
  const type = assertValueType(property.valueType);
  let definition =
    type.kind === "ref"
      ? Property.ref(
          property.key,
          objects.get(type.target) ??
            (() => {
              throw new TypeError(
                `Property ${property.key} references unknown object type ${type.target}`,
              );
            })(),
        )
      : type.kind === "datetime"
        ? Property.instant(property.key)
        : type.kind === "integer"
          ? Property.int(property.key)
          : type.kind === "enum"
            ? Property.enum(property.key, type.values as readonly [string, ...string[]])
            : type.kind === "decimal"
              ? Property.decimal(property.key, type.scale)
              : type.kind === "quantity"
                ? Property.quantity(property.key, type.unit, type.scale)
                : Property.make(property.key, valueTypeSchema(type));
  if (property.required) definition = definition.required();
  if (property.cardinality === "many") definition = definition.many();
  if (property.unique) definition = definition.unique();
  return definition;
};

const propertiesFromIR = (
  properties: readonly PropertyIR[],
  objects: ReadonlyMap<string, ObjectTypeDefinition>,
  includeRefs = true,
): Readonly<Record<string, PropertyDefinition>> =>
  Object.fromEntries(
    properties
      .filter((property) => includeRefs || property.valueType.kind !== "ref")
      .map((property) => [property.name, propertyFromIR(property, objects)]),
  );

const propertyByKey = (
  objects: ReadonlyMap<string, ObjectTypeDefinition>,
  key: string,
): PropertyDefinition => {
  for (const object of objects.values()) {
    const property = Object.values(object.properties).find((candidate) => candidate.key === key);
    if (property) return property;
  }
  throw new TypeError(`Action references unknown property ${key}`);
};

const changeFromIR = (
  change: ActionChangeIR,
  objects: ReadonlyMap<string, ObjectTypeDefinition>,
  links: ReadonlyMap<string, LinkTypeDefinition>,
): ActionChange => {
  switch (change.kind) {
    case "create-object": {
      const objectType = objects.get(change.objectType);
      if (!objectType) throw new TypeError(`Unknown object type ${change.objectType}`);
      return Change.create(
        objectType,
        valueFromIR(change.id),
        Object.fromEntries(
          Object.entries(change.properties).map(([key, value]) => [key, valueFromIR(value)]),
        ),
      );
    }
    case "set-property":
      return Change.set(
        valueFromIR(change.object),
        propertyByKey(objects, change.property),
        valueFromIR(change.value),
      );
    case "clear-property":
      return Change.clear(valueFromIR(change.object), propertyByKey(objects, change.property));
    case "create-link": {
      const link = links.get(change.linkType);
      if (!link) throw new TypeError(`Unknown link type ${change.linkType}`);
      return Change.link(
        link,
        valueFromIR(change.from),
        valueFromIR(change.to),
        Object.fromEntries(
          Object.entries(change.properties).map(([key, value]) => [key, valueFromIR(value)]),
        ),
      );
    }
  }
};

/** Materialize portable ontology IR as executable Effect Schema definitions. */
export const materializeOntology = (ir: OntologyIR): OntologyDefinition => {
  const objects = new Map<string, ObjectTypeDefinition>();
  for (const object of ir.objectTypes) {
    objects.set(
      object.name,
      Ontology.ObjectType(object.name, {
        properties: propertiesFromIR(object.properties, objects, false),
        ...(object.description === undefined ? {} : { description: object.description }),
      }),
    );
  }
  for (const object of ir.objectTypes) {
    objects.set(
      object.name,
      Ontology.ObjectType(object.name, {
        properties: propertiesFromIR(object.properties, objects),
        ...(object.description === undefined ? {} : { description: object.description }),
      }),
    );
  }

  const links = new Map<string, LinkTypeDefinition>();
  for (const link of ir.linkTypes) {
    const from = objects.get(link.from);
    const to = objects.get(link.to);
    if (!from || !to) throw new TypeError(`Link ${link.name} has unknown endpoints`);
    links.set(
      link.name,
      Ontology.LinkType(link.name, {
        from,
        to,
        properties: propertiesFromIR(link.properties, objects),
        ...(link.description === undefined ? {} : { description: link.description }),
      }),
    );
  }

  const declarations: OntologyDeclaration[] = [...objects.values(), ...links.values()];
  for (const action of ir.actionTypes) {
    const input = (action.inputSchema
      ? SchemaRepresentation.fromJsonSchemaDocument(action.inputSchema, { patterns: "apply" })
      : actionSchemaFromFields(action.input)) as unknown as Schema.Schema<
      Record<string, unknown>
    > & {
      readonly DecodingServices: never;
    };
    if (action.inputSchema) restoredInputSchemas.set(input, action.inputSchema);
    declarations.push({
      ...Ontology.ActionType(action.name, {
        input,
        changes: action.changes.map((change) => changeFromIR(change, objects, links)),
        ...(action.description === undefined ? {} : { description: action.description }),
      }),
      // Restoring JSON Schema can change its AST representation. Keep the portable
      // field types (including reference targets and cardinality) from the input IR.
      inputFields: action.input,
    });
  }
  for (const query of ir.queryTypes) {
    declarations.push(
      Ontology.QueryType(query.name, {
        query: query.query as DatalogQuery,
        ...(query.description === undefined ? {} : { description: query.description }),
      }),
    );
  }
  return defineOntology({ name: ir.name, version: ir.version }, declarations);
};
