import { readFileSync } from "node:fs";
import { Effect } from "effect";
import {
  SimpleSemanticEnvironment,
  bootstrapFromSources,
  normalizeForm,
  recognizeForms,
} from "@formalang/ts/descriptor";
import { expandFormaImports } from "./forma-libraries.js";
export { formaLibrarySources } from "./forma-libraries.js";
import type {
  ActionChangeIR,
  ActionInputIR,
  ActionTypeIR,
  ActionValueIR,
  DatalogQueryIR,
  DatalogValueIR,
  LinkTypeIR,
  ObjectTypeIR,
  OntologyDeclarationIR,
  OntologyIR,
  OntologyValueTypeIR,
  PropertyIR,
  QueryTypeIR,
} from "./ir.js";
import { actionInputSchemaFromFields, materializeOntology } from "./materialize.js";
import { assertValueType, valueProblem } from "./value-types.js";
import type { OntologyDefinition } from "./model.js";

const readPrelude = (name: string): string =>
  readFileSync(new URL(`../preludes/${name}`, import.meta.url), "utf8");

/**
 * The compiler, ontology, and elaboration sources are vendored from Forma so the ontology
 * language remains Lisp-authored and inspectable. Query constructors use Forma's portable
 * `construct/object` primitive in the local copy instead of its application-host primitive,
 * and entity and relation fields also carry a `unique` option.
 */
export const ontologyPreludeSources = Object.freeze({
  compiler: readPrelude("compiler.lisp"),
  ontology: readPrelude("ontology.lisp"),
  elaboration: readPrelude("ontology-compiler.lisp"),
  viewSpecElaboration: readPrelude("viewspec-compiler.lisp"),
});

const bootstrappedOntology = bootstrapFromSources(
  ontologyPreludeSources.compiler,
  ontologyPreludeSources.ontology,
  ontologyPreludeSources.elaboration,
  ontologyPreludeSources.viewSpecElaboration,
);

/** Forma descriptions loaded from the vendored Lisp prelude. */
export const formaForms = bootstrappedOntology.descriptions;

/** Executable Lisp-authored meta-fns and descriptor-authored elaborations. */
export const ontologyElaboration = bootstrappedOntology.elaboration;

/** Declarative `define-elaboration` programs parsed from the Lisp prelude. */
export const ontologyElaborationDescriptors = bootstrappedOntology.elaborationDescriptors;

export const ontologyPreludeStats = bootstrappedOntology.stats;

type FormaMap = ReadonlyMap<string, unknown>;

const isFormaMap = (value: unknown): value is FormaMap => value instanceof Map;

const requireMap = (value: unknown, label: string): FormaMap => {
  if (!isFormaMap(value)) throw new TypeError(`${label} did not elaborate to an object`);
  return value;
};

const mapString = (map: FormaMap, key: string): string | undefined => {
  const value = map.get(key);
  return typeof value === "string" ? value : undefined;
};

const asMaps = (value: unknown): readonly FormaMap[] =>
  Array.isArray(value) ? value.map((item) => requireMap(item, "Prelude child")) : [];

const symbolName = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (!("_tag" in value) || value._tag !== "Sym" || !("name" in value)) return undefined;
  return typeof value.name === "string" ? value.name : undefined;
};

const listItems = (value: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  if (!("_tag" in value) || value._tag !== "List" || !("items" in value)) return undefined;
  return Array.isArray(value.items) ? value.items : undefined;
};

/** Built-in Forma type names, for suggestions when a type is misspelt. */
const formaTypeNames = [
  "String", "Symbol", "Ref", "Int", "Float", "Number", "Bool", "Boolean", "Instant", "DateTime",
  "Json", "Any", "Enum", "Decimal", "Quantity", "List", "Set",
] as const;

const typeArgumentExamples: Readonly<Record<string, string>> = {
  Enum: "(Enum open closed)",
  Decimal: "(Decimal 2)",
  Quantity: "(Quantity EA)",
};

const scalarType = (name: string): OntologyValueTypeIR => {
  switch (name) {
    case "String":
    case "Symbol":
    case "Ref":
      return { kind: "string" };
    case "Int":
      return { kind: "integer" };
    case "Float":
    case "Number":
      return { kind: "number" };
    case "Bool":
    case "Boolean":
      return { kind: "boolean" };
    case "Instant":
    case "DateTime":
      return { kind: "datetime" };
    case "Json":
    case "Any":
      return { kind: "json" };
    default:
      if (name in typeArgumentExamples) {
        throw new TypeError(`${name} needs arguments, for example ${typeArgumentExamples[name]}`);
      }
      // validateIR rejects targets that name no declared entity.
      return { kind: "ref", target: name };
  }
};

/** A symbol or string literal in a type form, such as an enum value or a unit. */
const typeWord = (value: unknown): string | undefined => {
  if (value && typeof value === "object" && "_tag" in value && value._tag === "Str" && "value" in value) {
    return typeof value.value === "string" ? value.value : undefined;
  }
  return symbolName(value);
};

/** A number literal in a type form, such as a decimal scale. */
const typeNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "_tag" in value && value._tag === "Num" && "value" in value) {
    return typeof value.value === "number" ? value.value : undefined;
  }
  return undefined;
};

const formaType = (
  value: unknown,
): { readonly valueType: OntologyValueTypeIR; readonly cardinality: "one" | "many" } => {
  const direct = symbolName(value);
  if (direct) return { valueType: scalarType(direct), cardinality: "one" };

  const items = listItems(value);
  const constructor = symbolName(items?.[0]);
  const argument = symbolName(items?.[1]);
  const args = items?.slice(1) ?? [];
  if (constructor === "Ref" && argument) {
    return { valueType: { kind: "ref", target: argument }, cardinality: "one" };
  }
  if ((constructor === "List" || constructor === "Set") && items?.[1]) {
    return { valueType: formaType(items[1]).valueType, cardinality: "many" };
  }
  if (constructor === "Enum") {
    const values = args.flatMap((arg) => typeWord(arg) ?? []);
    if (values.length !== args.length) throw new TypeError("Enum values must be symbols or strings");
    return { valueType: assertValueType({ kind: "enum", values }), cardinality: "one" };
  }
  if (constructor === "Decimal") {
    const scale = typeNumber(args[0]);
    if (args.length !== 1 || scale === undefined) {
      throw new TypeError("Decimal takes one scale, for example (Decimal 2)");
    }
    return { valueType: assertValueType({ kind: "decimal", scale }), cardinality: "one" };
  }
  if (constructor === "Quantity") {
    const unit = typeWord(args[0]);
    const scale = typeNumber(args[1]);
    if (unit === undefined || args.length > 2 || (args.length === 2 && scale === undefined)) {
      throw new TypeError("Quantity takes a unit and an optional scale, for example (Quantity KG 3)");
    }
    return {
      valueType: assertValueType({ kind: "quantity", unit, ...(scale === undefined ? {} : { scale }) }),
      cardinality: "one",
    };
  }
  throw new TypeError(`Unsupported Forma ontology type ${String(direct ?? constructor ?? value)}`);
};

const propertyFromPrelude = (value: unknown): PropertyIR => {
  const field = requireMap(value, "Entity field");
  const rawName = mapString(field, "name");
  if (!rawName) throw new TypeError("An entity field is missing its name");
  const type = formaType(field.get("type"));
  const key = (rawName.startsWith(":") ? rawName : `:${rawName}`) as `:${string}/${string}`;
  if (!key.includes("/")) throw new TypeError(`Ontology property ${key} must be namespaced`);
  return {
    name: key.slice(key.indexOf("/") + 1),
    key,
    valueType: type.valueType,
    required: field.get("required") === true,
    cardinality: type.cardinality,
    unique: field.get("unique") === true,
  };
};

const description = (value: FormaMap): { readonly description?: string } => {
  const doc = mapString(value, "doc");
  return doc ? { description: doc } : {};
};

const objectTypeFromPrelude = (value: FormaMap): ObjectTypeIR => {
  // The vendored prelude accepts these slots, but the IR has nowhere to carry them yet.
  for (const [slot, key] of [["role", "role"], ["id-pattern", "idPattern"]] as const) {
    if (value.get(key) != null) {
      throw new TypeError(`(:${slot} ...) is not yet supported by the Triplex ontology adapter`);
    }
  }
  return {
    kind: "object-type",
    name: mapString(value, "name") ?? "anonymous-entity",
    ...description(value),
    properties: asMaps(value.get("fields")).map(propertyFromPrelude),
  };
};

const linkTypeFromPrelude = (value: FormaMap): LinkTypeIR => ({
  kind: "link-type",
  name: mapString(value, "name") ?? "anonymous-relation",
  from: mapString(value, "source") ?? "",
  to: mapString(value, "target") ?? "",
  ...description(value),
  properties: asMaps(value.get("fields")).map(propertyFromPrelude),
});

const runtimeLiteral = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(runtimeLiteral);
  if (!isFormaMap(value)) return value;
  if (value.get("$openOntology.runtimeExpr") === "string-literal") return value.get("value");
  if (value.get("kind") === "raw-expr") return runtimeLiteral(value.get("expr"));
  return Object.fromEntries([...value].map(([key, item]) => [key, runtimeLiteral(item)]));
};

const actionValue = (value: unknown, inputs: ReadonlySet<string>): ActionValueIR => {
  if (isFormaMap(value) && value.get("$openOntology.runtimeExpr") === "string-literal") {
    const literal = value.get("value");
    if (typeof literal === "string") return literal;
  }
  if (typeof value === "string") {
    if (value === "now") return { kind: "now" };
    if (inputs.has(value)) return { kind: "input", name: value };
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  throw new TypeError("Action values must be literals, input names, or now");
};

const actionProperties = (
  value: unknown,
  inputs: ReadonlySet<string>,
): Readonly<Record<string, ActionValueIR>> => {
  if (!isFormaMap(value)) return {};
  return Object.fromEntries(
    [...value].map(([rawKey, item]) => [
      rawKey.startsWith(":") ? rawKey : `:${rawKey}`,
      actionValue(item, inputs),
    ]),
  );
};

const actionChanges = (
  value: unknown,
  inputs: readonly ActionInputIR[],
): readonly ActionChangeIR[] => {
  const expression =
    isFormaMap(value) && value.get("kind") === "raw-expr" ? value.get("expr") : value;
  if (!Array.isArray(expression)) throw new TypeError("An action :do body must be a change form");
  const forms = expression[0] === "changes" ? expression.slice(1) : [expression];
  const inputNames = new Set(inputs.map(({ name }) => name));

  return forms.map((form): ActionChangeIR => {
    if (!Array.isArray(form) || typeof form[0] !== "string") {
      throw new TypeError("Every action change must be a list");
    }
    const operation = form[0].split("/").at(-1);
    if (operation === "create") {
      const [, objectType, id, properties] = form;
      if (typeof objectType !== "string") throw new TypeError("create needs an object type");
      return {
        kind: "create-object",
        objectType,
        id: actionValue(id, inputNames),
        properties: actionProperties(properties, inputNames),
      };
    }
    if (operation === "set") {
      const [, object, property, nextValue] = form;
      if (typeof property !== "string") throw new TypeError("set needs a property key");
      return {
        kind: "set-property",
        object: actionValue(object, inputNames),
        property: (property.startsWith(":") ? property : `:${property}`) as `:${string}/${string}`,
        value: actionValue(nextValue, inputNames),
      };
    }
    if (operation === "clear") {
      const [, object, property] = form;
      if (typeof property !== "string") throw new TypeError("clear needs a property key");
      return {
        kind: "clear-property",
        object: actionValue(object, inputNames),
        property: (property.startsWith(":") ? property : `:${property}`) as `:${string}/${string}`,
      };
    }
    if (operation === "link") {
      const [, linkType, from, to, properties] = form;
      if (typeof linkType !== "string") throw new TypeError("link needs a relation type");
      return {
        kind: "create-link",
        linkType,
        from: actionValue(from, inputNames),
        to: actionValue(to, inputNames),
        properties: actionProperties(properties, inputNames),
      };
    }
    throw new TypeError(`Unknown ontology action change ${String(operation)}`);
  });
};

const actionTypeFromPrelude = (value: FormaMap): ActionTypeIR => {
  const inputs: readonly ActionInputIR[] = asMaps(value.get("inputs")).map((input) => {
    const type = formaType(input.get("type"));
    return {
      name: mapString(input, "name") ?? "anonymous-input",
      valueType: type.valueType,
      ...(type.cardinality === "many" ? { cardinality: "many" as const } : {}),
      ...(input.get("required") === true ? {} : { optional: true }),
    };
  });
  return {
    kind: "action-type",
    name: mapString(value, "name") ?? "anonymous-action",
    ...description(value),
    input: inputs,
    inputSchema: actionInputSchemaFromFields(inputs),
    changes: actionChanges(value.get("do"), inputs),
  };
};

const datalogValue = (value: unknown): DatalogValueIR => {
  const literal = runtimeLiteral(value);
  if (
    literal === null ||
    typeof literal === "string" ||
    typeof literal === "number" ||
    typeof literal === "boolean"
  ) {
    return literal;
  }
  if (Array.isArray(literal)) return literal.map(datalogValue);
  if (literal && typeof literal === "object") {
    return Object.fromEntries(
      Object.entries(literal).map(([key, item]) => [key, datalogValue(item)]),
    );
  }
  throw new TypeError("Datalog values must be JSON-serializable");
};

const queryTypeFromPrelude = (value: FormaMap): QueryTypeIR => {
  const datalog = runtimeLiteral(value.get("datalog"));
  if (!datalog || typeof datalog !== "object" || Array.isArray(datalog)) {
    throw new TypeError("define-datalog-query must elaborate a query object");
  }
  const raw = datalog as Record<string, unknown>;
  if (!Array.isArray(raw["find"]) || !Array.isArray(raw["where"])) {
    throw new TypeError("A Datalog query requires :find and :where arrays");
  }
  const lowered = datalogValue(raw);
  if (!lowered || typeof lowered !== "object" || Array.isArray(lowered)) {
    throw new TypeError("define-datalog-query must lower to a query object");
  }
  const query = lowered as unknown as DatalogQueryIR;
  return {
    kind: "query-type",
    name: mapString(value, "name") ?? "anonymous-query",
    ...description(value),
    query,
  };
};

const declarationFromPrelude = (value: unknown): OntologyDeclarationIR => {
  const declaration = requireMap(value, "Ontology declaration");
  switch (mapString(declaration, "kind")) {
    case "Entity":
      return objectTypeFromPrelude(declaration);
    case "Relation":
      return linkTypeFromPrelude(declaration);
    case "Action":
    case "Mutation":
      return actionTypeFromPrelude(declaration);
    case "Query":
      if (declaration.has("datalog")) return queryTypeFromPrelude(declaration);
      throw new TypeError("Use define-datalog-query for Triplex queries");
    default:
      throw new TypeError(`Unsupported ontology declaration ${String(declaration.get("kind"))}`);
  }
};

type SourceLocation = { readonly start: number; readonly end: number; readonly line: number; readonly col: number; readonly source?: string };

const locatedError = (message: string, loc?: SourceLocation): TypeError =>
  Object.assign(new TypeError(message), { loc, ...(loc?.source === undefined ? {} : { source: loc.source }) });

/** A Forma reader node, as carried on a normalized form's `rawExpr`. */
interface ReaderNode {
  readonly _tag?: string;
  readonly name?: string;
  readonly items?: readonly ReaderNode[];
  readonly pairs?: readonly (readonly [ReaderNode, ReaderNode])[];
  readonly loc?: SourceLocation;
}

const optionKeys: Readonly<Record<string, readonly string[]>> = {
  ":field": [":required", ":unique"],
  ":input": [":required"],
};

/** Forma's normalizer drops unknown keys from field and input option maps, so reject them here. */
const assertKnownOptions = (rawExpr: unknown, loc: SourceLocation): void => {
  // Reader nodes are plain objects produced in-process by Forma's reader.
  for (const clause of (rawExpr as ReaderNode).items ?? []) {
    const [head, ...rest] = clause.items ?? [];
    const allowed = optionKeys[head?.name ?? ""];
    if (!allowed) continue;
    const parts = rest.flatMap((item) => (item._tag === "Vector" ? (item.items ?? []) : [item]));
    for (const [key] of parts.flatMap((item) => (item._tag === "Map" ? (item.pairs ?? []) : []))) {
      if (key.name !== undefined && !allowed.includes(key.name)) {
        throw locatedError(
          `${head!.name} option ${key.name} is not supported by the Triplex ontology adapter; use ${allowed.join(" or ")}`,
          { ...loc, ...key.loc },
        );
      }
    }
  }
};

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [row, leftChar] of [...left].entries()) {
    const current = [row + 1];
    for (const [column, rightChar] of [...right].entries()) {
      current.push(Math.min(previous[column + 1]! + 1, current[column]! + 1, previous[column]! + (leftChar === rightChar ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length]!;
};

/** "has unknown type X", with the closest built-in or declared type name when one is near. */
const unknownType = (name: string, objects: ReadonlySet<string>): string => {
  const [suggestion] = [...formaTypeNames, ...objects]
    .map((candidate) => ({ candidate, distance: editDistance(name.toLowerCase(), candidate.toLowerCase()) }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance);
  return suggestion
    ? `has unknown type ${name}; did you mean ${suggestion.candidate}?`
    : `has unknown type ${name}; declare (define-entity ${name} ...) or use a built-in type`;
};

const validateIR = (ir: OntologyIR, locations: ReadonlyMap<string, SourceLocation>): OntologyIR => {
  const errorAt = (name: string, message: string): never => {
    throw locatedError(message, locations.get(name));
  };
  const objects = new Set(ir.objectTypes.map(({ name }) => name));
  const links = new Set(ir.linkTypes.map(({ name }) => name));
  const propertyKeys = new Set(
    ir.objectTypes.flatMap(({ properties }) => properties.map(({ key }) => key)),
  );
  const seen = new Set<string>();
  for (const declaration of [
    ...ir.objectTypes,
    ...ir.linkTypes,
    ...ir.actionTypes,
    ...ir.queryTypes,
  ]) {
    const identity = `${declaration.kind}:${declaration.name}`;
    if (seen.has(identity))
      errorAt(declaration.name, `Duplicate ontology declaration ${declaration.name}`);
    seen.add(identity);
  }
  for (const declaration of [...ir.objectTypes, ...ir.linkTypes]) {
    for (const property of declaration.properties) {
      if (property.valueType.kind === "ref" && !objects.has(property.valueType.target)) {
        errorAt(declaration.name, `Property ${property.key} ${unknownType(property.valueType.target, objects)}`);
      }
    }
  }
  for (const link of ir.linkTypes) {
    if (!objects.has(link.from) || !objects.has(link.to)) {
      errorAt(link.name, `Link ${link.name} has unknown endpoints ${link.from} -> ${link.to}`);
    }
  }
  const objectProperties = new Map(ir.objectTypes.map((object) => [object.name, object.properties]));
  const linkProperties = new Map(ir.linkTypes.map((link) => [link.name, link.properties]));
  const allProperties = ir.objectTypes.flatMap(({ properties }) => properties);
  for (const action of ir.actionTypes) {
    for (const input of action.input) {
      if (input.valueType.kind === "ref" && !objects.has(input.valueType.target)) {
        errorAt(action.name, `Action ${action.name} input ${input.name} ${unknownType(input.valueType.target, objects)}`);
      }
    }
    const checkLiterals = (
      properties: readonly PropertyIR[],
      values: Readonly<Record<string, ActionValueIR>>,
    ) => {
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "object" && value !== null) continue;
        const property = properties.find((candidate) => candidate.key === key);
        const problem = property && valueProblem(property.valueType, value);
        if (problem) errorAt(action.name, `Action ${action.name} writes ${key}, which ${problem}`);
      }
    };
    for (const change of action.changes) {
      if (change.kind === "create-object" && !objects.has(change.objectType)) {
        errorAt(action.name, `Action ${action.name} references unknown object ${change.objectType}`);
      }
      if (change.kind === "create-link" && !links.has(change.linkType)) {
        errorAt(action.name, `Action ${action.name} references unknown link ${change.linkType}`);
      }
      if (
        (change.kind === "set-property" || change.kind === "clear-property") &&
        !propertyKeys.has(change.property)
      ) {
        errorAt(action.name, `Action ${action.name} references unknown property ${change.property}`);
      }
      if (change.kind === "create-object") {
        checkLiterals(objectProperties.get(change.objectType) ?? [], change.properties);
      }
      if (change.kind === "set-property") {
        checkLiterals(allProperties, { [change.property]: change.value });
      }
      if (change.kind === "create-link") {
        checkLiterals(linkProperties.get(change.linkType) ?? [], change.properties);
      }
    }
  }
  return ir;
};

const supportedForms = new Set([
  "define-entity",
  "define-relation",
  "define-action",
  "define-mutation",
  "define-datalog-query",
]);

/** Parse canonical Forma forms and execute their Lisp-authored hooks into portable ontology IR. */
export const elaborateFormaOntology = (
  source: string,
  options: { readonly name: string; readonly version?: string },
): OntologyIR => {
  const forms = expandFormaImports(source).map(({ expression, library }) => {
    const loc = { ...expression.loc, ...(library === undefined ? {} : { source: library }) };
    const [recognized] = recognizeForms([expression], formaForms);
    if (!recognized) {
      throw locatedError("Source contains a form that is not part of the vendored Forma ontology DSL", loc);
    }
    try {
      return { ...normalizeForm(recognized, formaForms), loc };
    } catch (error) {
      if (error instanceof Error) throw locatedError(error.message, loc);
      throw error;
    }
  });
  const semanticEnv = new SimpleSemanticEnvironment();
  for (const form of forms) {
    if (!supportedForms.has(form.formName)) {
      throw locatedError(`${form.formName} is not yet supported by the Triplex ontology adapter`, form.loc);
    }
    assertKnownOptions(form.rawExpr, form.loc);
    const name = form.identifiers.get("name");
    if (name) semanticEnv.declareGlobal(name, form.formName);
  }

  const locations = new Map<string, SourceLocation>();
  const declarations = forms.map((form): OntologyDeclarationIR => {
    const name = form.identifiers.get("name");
    if (name) locations.set(name, form.loc);
    if (form.descriptor.elaboration.kind !== "hook") {
      throw locatedError(`Ontology form ${form.formName} does not name a construct hook`, form.loc);
    }
    const effect = ontologyElaboration.construct(form.descriptor.elaboration.fn, {
      formName: form.formName,
      descriptor: form.descriptor,
      normalizedSlots: form.slots,
      identifiers: form.identifiers,
      semanticEnv,
      loc: form.loc,
      rawExpr: form.rawExpr,
    });
    try {
      return declarationFromPrelude(Effect.runSync(effect as Parameters<typeof Effect.runSync>[0]));
    } catch (error) {
      if (error instanceof Error) throw locatedError(error.message, form.loc);
      throw error;
    }
  });

  return validateIR({
    kind: "ontology",
    name: options.name,
    version: options.version ?? "0.1.0",
    objectTypes: declarations.filter((item): item is ObjectTypeIR => item.kind === "object-type"),
    linkTypes: declarations.filter((item): item is LinkTypeIR => item.kind === "link-type"),
    actionTypes: declarations.filter((item): item is ActionTypeIR => item.kind === "action-type"),
    queryTypes: declarations.filter((item): item is QueryTypeIR => item.kind === "query-type"),
  }, locations);
};

/** Convenience: elaborate first, then materialize the executable Effect model. */
export const compileFormaOntology = (
  source: string,
  options: { readonly name: string; readonly version?: string },
): OntologyDefinition => materializeOntology(elaborateFormaOntology(source, options));
