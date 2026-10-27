import { Schema } from "effect";
import type { DatalogQuery } from "@triplex-build/triplex";
import { Datalog, type DatalogResult, type TypedDatalogQuery } from "./datalog.js";
import type { ActionInputIR, OntologyValueTypeIR } from "./ir.js";
import type {
  ActionChange,
  ActionTypeDefinition,
  ActionValue,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDeclaration,
  OntologyDefinition,
  PropertyDefinition,
  PropertyKind,
  QueryTypeDefinition,
  LinkEndpoints,
  PropertyQueryType,
} from "./model.js";
import { assertValueType, valueTypeAnnotation, valueTypeSchema } from "./value-types.js";

const PROPERTY_KEY = /^:[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;
const OBJECT_TYPE = /^[A-Z][A-Za-z0-9]*$/;
const DECLARATION_NAME = /^[a-z][a-z0-9-]*$/;

type SchemaAst = {
  readonly _tag?: string;
  readonly literal?: unknown;
  readonly types?: readonly SchemaAst[];
  readonly propertySignatures?: readonly {
    readonly name: PropertyKey;
    readonly type: SchemaAst;
  }[];
  readonly context?: { readonly isOptional?: boolean };
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly checks?: readonly { readonly annotations?: Readonly<Record<string, unknown>> }[];
};

/**
 * Value types the structure of a schema shows: an annotated decimal or quantity, an integer
 * check, or a union of string literals. Other schemas fall back to their AST tag.
 */
const refinedValueType = (ast: SchemaAst): OntologyValueTypeIR | undefined => {
  const checks = ast.checks ?? [];
  const annotated = checks.map((check) => check.annotations?.[valueTypeAnnotation]).findLast(Boolean);
  // Only valueTypeSchema writes this annotation, and always with a validated value type.
  if (annotated) return annotated as OntologyValueTypeIR;
  if (
    ast._tag === "Number" &&
    checks.some((check) => {
      const representation = check.annotations?.["representation"];
      return typeof representation === "object" && representation !== null &&
        "id" in representation && representation.id === "effect/schema/isInt";
    })
  ) {
    return { kind: "integer" };
  }
  const members = ast._tag === "Union" ? (ast.types ?? []) : [];
  const values = members.flatMap((member) =>
    member._tag === "Literal" && typeof member.literal === "string" ? [member.literal] : []);
  if (members.length > 1 && values.length === members.length) return { kind: "enum", values };
  return undefined;
};

const schemaValueType = (schema: Schema.Schema<unknown>): OntologyValueTypeIR => {
  const ast = schema.ast as SchemaAst;
  const refined = refinedValueType(ast);
  if (refined) return refined;
  switch (ast._tag) {
    case "String":
    case "Literal":
      return { kind: "string" };
    case "Number":
      return { kind: "number" };
    case "Boolean":
      return { kind: "boolean" };
    default:
      return { kind: "json" };
  }
};

const valueTypeFromAst = (ast: SchemaAst): OntologyValueTypeIR => {
  const refined = refinedValueType(ast);
  if (refined) return refined;
  switch (ast._tag) {
    case "String":
      return { kind: "string" };
    case "Number":
      return { kind: "number" };
    case "Boolean":
      return { kind: "boolean" };
    case "Literal":
      return { kind: typeof ast.literal === "number" ? "number" : "string" };
    case "Declaration":
      return { kind: "datetime" };
    case "Union": {
      const members = (ast.types ?? []).filter((member) => member._tag !== "Undefined");
      return members.length === 1 ? valueTypeFromAst(members[0]!) : { kind: "json" };
    }
    default:
      return { kind: "json" };
  }
};

const actionInputFields = (schema: Schema.Schema<unknown>): readonly ActionInputIR[] => {
  const ast = schema.ast as SchemaAst;
  if (ast._tag !== "Objects") {
    throw new TypeError("Action input must be an Effect Schema.Struct");
  }
  return (ast.propertySignatures ?? []).map((property) => ({
    name: String(property.name),
    valueType: valueTypeFromAst(property.type),
    ...(property.type.context?.isOptional === true ||
    property.type.types?.some((member) => member._tag === "Undefined")
      ? { optional: true }
      : {}),
  }));
};

/** A schema that decodes without services, so it can also type an action input field. */
type DecodableSchema<A> = Schema.Schema<A> & { readonly DecodingServices: never };

class PropertyBuilder<A, QueryValue = A> implements PropertyDefinition<A, QueryValue> {
  readonly _tag = "Property" as const;
  declare readonly [PropertyQueryType]?: QueryValue;
  #required = false;
  #cardinality: "one" | "many" = "one";
  #unique = false;
  readonly target?: ObjectTypeDefinition;

  constructor(
    readonly key: `:${string}/${string}`,
    readonly schema: DecodableSchema<A>,
    readonly valueType: OntologyValueTypeIR,
    target?: ObjectTypeDefinition,
  ) {
    if (!PROPERTY_KEY.test(key)) {
      throw new TypeError(`Property key must be a lowercase namespaced keyword; received ${key}`);
    }
    if (target !== undefined) this.target = target;
  }

  get kind(): PropertyKind {
    return this.valueType.kind;
  }

  get isRequired(): boolean {
    return this.#required;
  }

  get cardinality(): "one" | "many" {
    return this.#cardinality;
  }

  get isUnique(): boolean {
    return this.#unique;
  }

  required(): this {
    this.#required = true;
    return this;
  }

  many(): this {
    this.#cardinality = "many";
    return this;
  }

  unique(): this {
    this.#unique = true;
    return this;
  }
}

// valueTypeSchema returns an untyped schema; each caller below names the type it decodes to.
const typedSchema = <A>(valueType: OntologyValueTypeIR) => valueTypeSchema(valueType) as DecodableSchema<A>;

export const Property = {
  make: <A>(key: `:${string}/${string}`, schema: DecodableSchema<A>): PropertyBuilder<A> =>
    new PropertyBuilder(key, schema, schemaValueType(schema as Schema.Schema<unknown>)),
  instant: (key: `:${string}/${string}`): PropertyBuilder<number | Date, Date> =>
    new PropertyBuilder(key, Schema.Union([Schema.Number, Schema.Date]), { kind: "datetime" }),
  /** A safe integer. */
  int: (key: `:${string}/${string}`): PropertyBuilder<number> =>
    new PropertyBuilder(key, Schema.Int, { kind: "integer" }),
  /** One of a closed set of strings. */
  enum: <const V extends string>(
    key: `:${string}/${string}`,
    values: readonly [V, ...V[]],
  ): PropertyBuilder<V> =>
    new PropertyBuilder(key, Schema.Literals(values), assertValueType({ kind: "enum", values })),
  /** An exact decimal string with at most `scale` fraction digits. */
  decimal: (key: `:${string}/${string}`, scale: number): PropertyBuilder<string> => {
    const valueType = assertValueType({ kind: "decimal", scale });
    return new PropertyBuilder(key, typedSchema<string>(valueType), valueType);
  },
  /** A safe integer count of `unit`, or of its 10^-scale fraction when `scale` is given. */
  quantity: (key: `:${string}/${string}`, unit: string, scale?: number): PropertyBuilder<number> => {
    const valueType = assertValueType({ kind: "quantity", unit, ...(scale === undefined ? {} : { scale }) });
    return new PropertyBuilder(key, typedSchema<number>(valueType), valueType);
  },
  ref: <Target extends ObjectTypeDefinition>(
    key: `:${string}/${string}`,
    target: Target,
  ): PropertyBuilder<
    string,
    import("./model.js").OntologyEntityId<import("./model.js").ObjectTypeIdentity<Target["name"]>>
  > => new PropertyBuilder(key, Schema.String, { kind: "ref", target: target.name }, target),
};

export const Input = {
  value: (name: string) => ({ _tag: "Input", name }) as const,
  now: { _tag: "Now" } as const,
};

export const Change = {
  create: (
    objectType: ObjectTypeDefinition,
    id: ActionValue,
    properties: Readonly<Record<string, ActionValue>>,
  ): ActionChange => ({ _tag: "CreateObject", objectType, id, properties }),
  set: (object: ActionValue, property: PropertyDefinition, value: ActionValue): ActionChange => ({
    _tag: "SetProperty",
    object,
    property,
    value,
  }),
  clear: (object: ActionValue, property: PropertyDefinition): ActionChange => ({
    _tag: "ClearProperty",
    object,
    property,
  }),
  link: (
    linkType: LinkTypeDefinition,
    from: ActionValue,
    to: ActionValue,
    properties: Readonly<Record<string, ActionValue>> = {},
  ): ActionChange => ({ _tag: "CreateLink", linkType, from, to, properties }),
};

const assertObjectTypeName = (name: string): void => {
  if (!OBJECT_TYPE.test(name)) {
    throw new TypeError(`Object type names must be PascalCase; received ${name}`);
  }
};

const assertDeclarationName = (name: string): void => {
  if (!DECLARATION_NAME.test(name)) {
    throw new TypeError(`Link, action, and query names must be kebab-case; received ${name}`);
  }
};

export const Ontology = {
  ObjectType: <const Name extends string, P extends Readonly<Record<string, PropertyDefinition>>>(
    name: Name,
    options: { readonly properties: P; readonly description?: string },
  ): ObjectTypeDefinition<Name, P> => {
    assertObjectTypeName(name);
    return {
      _tag: "ObjectType",
      name,
      entity: { _tag: "Entity", name },
      ...options,
    } as unknown as ObjectTypeDefinition<Name, P>;
  },

  LinkType: <
    const Name extends string,
    From extends ObjectTypeDefinition,
    To extends ObjectTypeDefinition,
    P extends Readonly<Record<string, PropertyDefinition>>,
  >(
    name: Name,
    options: {
      readonly from: From;
      readonly to: To;
      readonly properties?: P;
      readonly description?: string;
    },
  ): LinkTypeDefinition<Name, From, To, P> => {
    assertDeclarationName(name);
    const properties = options.properties ?? ({} as P);
    if ("from" in properties || "to" in properties) {
      throw new TypeError(`Link ${name} properties cannot use the reserved aliases from or to`);
    }
    if (
      Object.values(properties).some(
        (property) => property.key === `:${name}/from` || property.key === `:${name}/to`,
      )
    ) {
      throw new TypeError(`Link ${name} properties cannot use endpoint keys`);
    }
    const from = Property.ref(`:${name}/from`, options.from).required();
    const to = Property.ref(`:${name}/to`, options.to).required();
    return {
      _tag: "LinkType",
      name,
      entity: { _tag: "Entity", name },
      from: options.from,
      to: options.to,
      properties,
      endpoints: { from, to } as unknown as LinkEndpoints<Name, From, To>,
      ...(options.description === undefined ? {} : { description: options.description }),
    } as unknown as LinkTypeDefinition<Name, From, To, P>;
  },

  ActionType: <I>(
    name: string,
    options: {
      readonly input: Schema.Schema<I> & { readonly DecodingServices: never };
      readonly changes: readonly ActionChange[];
      readonly description?: string;
    },
  ): ActionTypeDefinition<I> => {
    assertDeclarationName(name);
    return {
      _tag: "ActionType",
      name,
      ...options,
      inputFields: actionInputFields(options.input as Schema.Schema<unknown>),
    };
  },

  QueryType: <const Query extends DatalogQuery | TypedDatalogQuery<any>>(
    name: string,
    options: { readonly query: Query; readonly description?: string },
  ): QueryTypeDefinition<DatalogResult<Query>> => {
    assertDeclarationName(name);
    return {
      _tag: "QueryType",
      name,
      ...options,
      // Typed variables and result metadata disappear at this single serialization boundary.
      query: Datalog.toDatalog(options.query as TypedDatalogQuery<DatalogResult<Query>>),
    } as unknown as QueryTypeDefinition<DatalogResult<Query>>;
  },
};

export const defineOntology = (
  options: { readonly name: string; readonly version?: string },
  declarations: readonly OntologyDeclaration[],
): OntologyDefinition => {
  const objectTypes = new Map<string, ObjectTypeDefinition>();
  const linkTypes = new Map<string, LinkTypeDefinition>();
  const actionTypes = new Map<string, ActionTypeDefinition>();
  const queryTypes = new Map<string, QueryTypeDefinition>();

  const register = <T>(map: Map<string, T>, name: string, value: T): void => {
    if (map.has(name)) throw new TypeError(`Duplicate ontology declaration: ${name}`);
    map.set(name, value);
  };

  for (const declaration of declarations) {
    switch (declaration._tag) {
      case "ObjectType":
        register(objectTypes, declaration.name, declaration);
        break;
      case "LinkType":
        register(linkTypes, declaration.name, declaration);
        break;
      case "ActionType":
        register(actionTypes, declaration.name, declaration);
        break;
      case "QueryType":
        register(queryTypes, declaration.name, declaration);
        break;
    }
  }

  for (const link of linkTypes.values()) {
    if (!objectTypes.has(link.from.name) || !objectTypes.has(link.to.name)) {
      throw new TypeError(`Link ${link.name} references object types outside this ontology`);
    }
  }

  return {
    name: options.name,
    version: options.version ?? "0.1.0",
    objectTypes,
    linkTypes,
    actionTypes,
    queryTypes,
  };
};

export { Schema as S } from "effect";
