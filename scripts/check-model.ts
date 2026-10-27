/**
 * Check an ontology source file and report what an authoring agent needs next: a located error,
 * a one-line-per-declaration summary, and warnings for mistakes that compile but misbehave at run time.
 *
 *   pnpm model:check <model.lisp | model.ts> [--name <name>] [--version <version>] [--json]
 */
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  elaborateFormaOntology,
  materializeOntology,
  ontologyToIR,
  type DatalogValueIR,
  type OntologyDefinition,
  type OntologyIR,
  type OntologyValueTypeIR,
  type PropertyIR,
} from "../src/index.js";
import { valueTypeLabel } from "../src/value-types.js";

export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly line?: number;
  readonly col?: number;
  readonly source?: string;
}

export interface ModelCheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly summary: readonly string[];
  readonly ir?: OntologyIR;
}

const OPERATORS = new Set([">", ">=", "<", "<=", "=", "!="]);

const locate = (source: string | undefined, name: string): Pick<Diagnostic, "line" | "col"> => {
  if (!source) return {};
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\(define-[a-z-]+\\s+${escaped}(?=[\\s)])`).exec(source)
    ?? new RegExp(`(?<![\\w/-])${escaped}(?![\\w/-])`).exec(source);
  if (!match) return {};
  const before = source.slice(0, match.index).split("\n");
  return { line: before.length, col: before.at(-1)!.length + 1 };
};

const propertyLabel = (property: PropertyIR): string => {
  const type = valueTypeLabel(property.valueType);
  return `${property.key} ${property.cardinality === "many" ? `[${type}]` : type}${property.required ? "!" : ""}${property.unique ? " unique" : ""}`;
};

const summarize = (ir: OntologyIR): string[] => [
  ...ir.objectTypes.map((object) =>
    `object  ${object.name}  ${object.properties.map(propertyLabel).join(", ")}`),
  ...ir.linkTypes.map((link) =>
    `link    ${link.name}  ${link.from} -> ${link.to}${link.properties.length ? `  ${link.properties.map(propertyLabel).join(", ")}` : ""}`),
  ...ir.actionTypes.map((action) => {
    const inputs = action.input
      .map((input) => `${input.name} ${valueTypeLabel(input.valueType)}${input.optional ? "" : "!"}`)
      .join(", ");
    const changes = action.changes.map((change) => {
      switch (change.kind) {
        case "create-object": return `create ${change.objectType}`;
        case "set-property": return `set ${change.property}`;
        case "clear-property": return `clear ${change.property}`;
        case "create-link": return `link ${change.linkType}`;
      }
    });
    return `action  ${action.name}(${inputs})  ${changes.join(", ")}`;
  }),
  ...ir.queryTypes.map((query) =>
    `query   ${query.name}  find ${query.query.find.map((term) => String(term)).join(" ")}`),
];

const isPattern = (clause: readonly DatalogValueIR[]): boolean =>
  (clause.length === 3 || clause.length === 4) &&
  typeof clause[0] === "string" && !OPERATORS.has(clause[0]) && clause[0] !== "not" &&
  typeof clause[1] === "string";

const patterns = (clauses: readonly (readonly DatalogValueIR[])[]): (readonly DatalogValueIR[])[] =>
  clauses.flatMap((clause) => {
    if (clause[0] === "not" || clause[0] === "or") {
      return patterns(clause.slice(1).filter(Array.isArray) as (readonly DatalogValueIR[])[]);
    }
    return isPattern(clause) ? [clause] : [];
  });

const variablesIn = (value: DatalogValueIR, into: Set<string>): Set<string> => {
  if (typeof value === "string" && value.startsWith("?")) into.add(value);
  if (Array.isArray(value)) for (const item of value) variablesIn(item, into);
  return into;
};

/** Warnings for models that elaborate cleanly but return nothing, fail on invocation, or keep stale values. */
const lint = (ir: OntologyIR, source?: string): Diagnostic[] => {
  const warnings: Diagnostic[] = [];
  const warn = (name: string, message: string) =>
    warnings.push({ severity: "warning", message, ...locate(source, name) });

  const attributes = new Set<string>([
    ...ir.objectTypes.flatMap((object) => object.properties.map(({ key }) => key)),
    ...ir.linkTypes.flatMap((link) => [
      `:${link.name}/from`, `:${link.name}/to`, ...link.properties.map(({ key }) => key),
    ]),
  ]);

  const valueTypes = new Map<string, OntologyValueTypeIR>([
    ...ir.objectTypes.flatMap((object) => object.properties),
    ...ir.linkTypes.flatMap((link) => link.properties),
  ].map((property) => [property.key, property.valueType]));

  for (const { name, query } of ir.queryTypes) {
    const clauses = [...query.where, ...(query.rules ?? []).flatMap((rule) => rule.body)];
    const decimals = new Map<string, string>();
    for (const clause of patterns(clauses)) {
      const attribute = clause[1] as string;
      if (!attribute.startsWith("?") && !attributes.has(attribute)) {
        warn(name, `Query ${name} matches ${attribute}, which no object or link declares; it will match nothing`);
      }
      if (valueTypes.get(attribute)?.kind === "decimal" && typeof clause[2] === "string") {
        decimals.set(clause[2], attribute);
      }
    }
    // Decimals are stored as strings, so Datalog orders them as text and cannot add them.
    for (const [fn, source] of query.aggregate ?? []) {
      const attribute = typeof source === "string" ? decimals.get(source) : undefined;
      if (attribute && fn !== "count") {
        warn(name, `Query ${name} applies ${String(fn)} to ${String(source)}, but ${attribute} holds decimal strings; the result is not a decimal ${String(fn)}`);
      }
    }
    for (const clause of clauses) {
      const [op, ...operands] = clause;
      if (typeof op !== "string" || !OPERATORS.has(op) || op === "=" || op === "!=") continue;
      const attribute = operands.map((operand) => typeof operand === "string" ? decimals.get(operand) : undefined).find(Boolean);
      if (attribute) {
        warn(name, `Query ${name} compares with ${op}, but ${attribute} holds decimal strings, which compare as text`);
      }
    }
    const bound = variablesIn([...query.where, ...(query.aggregate ?? [])] as DatalogValueIR, new Set());
    for (const variable of variablesIn(query.find as DatalogValueIR, new Set())) {
      if (!bound.has(variable)) warn(name, `Query ${name} finds ${variable}, which no :where clause binds`);
    }
  }

  for (const action of ir.actionTypes) {
    const optional = new Set(action.input.filter((input) => input.optional).map(({ name }) => name));
    const cleared = new Set<string>();
    for (const change of action.changes) {
      const values = change.kind === "create-object" ? [change.id, ...Object.values(change.properties)]
        : change.kind === "set-property" ? [change.object, change.value]
        : change.kind === "clear-property" ? [change.object]
        : [change.from, change.to, ...Object.values(change.properties)];
      for (const value of values) {
        if (typeof value === "object" && value !== null && value.kind === "input" && optional.has(value.name)) {
          warn(action.name, `Action ${action.name} uses optional input ${value.name} in a change; invoking without it fails with "Missing action input: ${value.name}". Mark it {:required true}`);
          optional.delete(value.name);
        }
      }
      const targets = change.kind === "create-object" ? [change.id]
        : change.kind === "create-link" ? [change.from, change.to]
        : [change.object];
      for (const target of targets) {
        if (typeof target === "string") {
          warn(action.name, `Action ${action.name} targets the fixed object id "${target}"; an unquoted name that is not a declared input becomes a literal. Declare (:input [${target} String {:required true}]) if you meant an input`);
        }
      }
      if (change.kind === "clear-property") cleared.add(`${JSON.stringify(change.object)} ${change.property}`);
      if (change.kind === "set-property" && !cleared.has(`${JSON.stringify(change.object)} ${change.property}`)) {
        const property = ir.objectTypes.flatMap((object) => object.properties).find(({ key }) => key === change.property);
        if (property?.cardinality === "one") {
          warn(action.name, `Action ${action.name} sets ${change.property} without clearing it first; once the field has a value, the write fails its single-value constraint. Add (clear ... ${change.property}) before the set to replace it`);
        }
      }
    }
  }
  return warnings.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
};

const failure = (error: unknown, source?: string): ModelCheckResult => {
  const message = error instanceof Error ? error.message : String(error);
  const loc = (error as { loc?: { line?: number; col?: number } } | undefined)?.loc;
  const sourceName = (error as { source?: string } | undefined)?.source;
  const received = /received (\S+)$/.exec(message)?.[1];
  const position = loc?.line !== undefined
    ? { line: loc.line, ...(loc.col === undefined ? {} : { col: loc.col }) }
    : received ? locate(source, received) : {};
  return { ok: false, summary: [], diagnostics: [{ severity: "error", message, ...position,
    ...(sourceName === undefined ? {} : { source: sourceName }),
  }] };
};

const verified = (ir: OntologyIR, source?: string): ModelCheckResult => {
  try {
    // Materializing applies the naming rules and input schemas that the runtime enforces.
    materializeOntology(ir);
  } catch (error) {
    return failure(error, source);
  }
  return { ok: true, ir, summary: summarize(ir), diagnostics: lint(ir, source) };
};

/** Check Forma source text. */
export const checkFormaSource = (
  source: string,
  options: { readonly name: string; readonly version?: string },
): ModelCheckResult => {
  let ir: OntologyIR;
  try {
    ir = elaborateFormaOntology(source, options);
  } catch (error) {
    return failure(error, source);
  }
  return verified(ir, source);
};

const isOntologyDefinition = (value: unknown): value is OntologyDefinition =>
  typeof value === "object" && value !== null &&
  "objectTypes" in value && value.objectTypes instanceof Map &&
  "actionTypes" in value && value.actionTypes instanceof Map;

/** Check a `.lisp` Forma file or a `.ts` module that exports a `defineOntology(...)` result. */
export const checkModelFile = async (
  path: string,
  options: { readonly name?: string; readonly version?: string } = {},
): Promise<ModelCheckResult> => {
  if (extname(path) === ".ts") {
    let module: Record<string, unknown>;
    try {
      module = await import(pathToFileURL(resolve(path)).href);
    } catch (error) {
      return failure(error);
    }
    const ontology = Object.values(module).find(isOntologyDefinition);
    if (!ontology) return failure(new Error("The module exports no defineOntology(...) result"));
    try {
      return verified(ontologyToIR(ontology));
    } catch (error) {
      return failure(error);
    }
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return failure(error);
  }
  return checkFormaSource(source, {
    name: options.name ?? basename(path, extname(path)),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
};

const usage = "Usage: pnpm model:check <model.lisp | model.ts> [--name <name>] [--version <version>] [--json]";

const main = async (args: readonly string[]): Promise<number> => {
  const flags = new Map<string, string | true>();
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") flags.set("json", true);
    else if (arg === "--name" || arg === "--version") {
      const value = args[index + 1];
      if (value === undefined) break;
      flags.set(arg.slice(2), value);
      index += 1;
    } else if (arg.startsWith("--")) {
      console.error(`Unknown option ${arg}\n${usage}`);
      return 2;
    } else files.push(arg);
  }
  if (files.length !== 1) {
    console.error(usage);
    return 2;
  }
  const file = files[0]!;
  const name = flags.get("name");
  const version = flags.get("version");
  const result = await checkModelFile(file, {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof version === "string" ? { version } : {}),
  });

  if (flags.has("json")) {
    // Diagnostics lead so a truncated read still sees them; the IR is last.
    const { ok, diagnostics, summary, ir } = result;
    console.log(JSON.stringify({ file, ok, diagnostics, summary, ir }, null, 2));
    return result.ok ? 0 : 1;
  }
  const where = (diagnostic: Diagnostic) =>
    diagnostic.line === undefined ? (diagnostic.source ?? file)
      : `${diagnostic.source ?? file}:${diagnostic.line}:${diagnostic.col ?? 1}`;
  for (const diagnostic of result.diagnostics) {
    console.error(`${where(diagnostic)}: ${diagnostic.severity}: ${diagnostic.message}`);
  }
  if (!result.ok || !result.ir) return 1;
  const warnings = result.diagnostics.length;
  console.log(`ok ${file} (${result.ir.name}@${result.ir.version})`);
  for (const line of result.summary) console.log(`  ${line}`);
  console.log(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
