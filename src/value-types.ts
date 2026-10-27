import { Schema } from "effect";
import type { OntologyValueTypeIR } from "./ir.js";

/**
 * Schema annotation that names a value type the schema's structure cannot show: a decimal is a
 * patterned string and a quantity is an integer. The TypeScript DSL reads it back from action
 * inputs; JSON Schema output ignores it.
 */
export const valueTypeAnnotation = "openOntology/valueType";

const isScale = (scale: unknown): scale is number => Number.isSafeInteger(scale) && Number(scale) >= 0;

/** Reject value types that no schema or Triplex attribute can represent. */
export const assertValueType = (type: OntologyValueTypeIR): OntologyValueTypeIR => {
  switch (type.kind) {
    case "enum":
      if (
        type.values.length === 0 ||
        type.values.some((value) => typeof value !== "string" || value.length === 0) ||
        new Set(type.values).size !== type.values.length
      ) {
        throw new TypeError("An enum needs one or more distinct, non-empty string values");
      }
      break;
    case "decimal":
      if (!isScale(type.scale)) throw new TypeError("A decimal scale must be a non-negative integer");
      break;
    case "quantity":
      if (typeof type.unit !== "string" || type.unit.length === 0) {
        throw new TypeError("A quantity needs a unit");
      }
      if (type.scale !== undefined && !isScale(type.scale)) {
        throw new TypeError("A quantity scale must be a non-negative integer");
      }
      break;
  }
  return type;
};

/** Decimals written with an optional sign, no leading zeros, and at most `scale` fraction digits. */
export const decimalPattern = (scale: number): RegExp =>
  new RegExp(`^-?(0|[1-9]\\d*)${scale === 0 ? "" : `(\\.\\d{1,${scale}})?`}$`, "u");

/** The stored form of a decimal: exactly `scale` fraction digits and no negative zero. */
export const canonicalDecimal = (value: string, scale: number): string => {
  const [whole = "", fraction = ""] = value.split(".");
  const digits = scale === 0 ? whole : `${whole}.${fraction.padEnd(scale, "0")}`;
  return /^-[0.]+$/.test(digits) ? digits.slice(1) : digits;
};

/** The executable schema for a property or action input of this value type. */
export const valueTypeSchema = (
  type: OntologyValueTypeIR,
): Schema.Schema<unknown> & { readonly DecodingServices: never } => {
  switch (type.kind) {
    case "string":
    case "ref":
      return Schema.String;
    case "integer":
      return Schema.Int;
    case "number":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
    case "datetime":
      return Schema.Union([Schema.Number, Schema.Date]);
    case "json":
      return Schema.Unknown;
    case "enum":
      assertValueType(type);
      return Schema.Literals(type.values);
    case "decimal":
      return Schema.String.check(Schema.isPattern(decimalPattern(type.scale)))
        .annotate({ [valueTypeAnnotation]: assertValueType(type) });
    case "quantity":
      return Schema.Int.annotate({ [valueTypeAnnotation]: assertValueType(type) });
  }
};

/** The type as the checker prints it. */
export const valueTypeLabel = (type: OntologyValueTypeIR): string => {
  switch (type.kind) {
    case "ref":
      return type.target;
    case "enum":
      return `enum(${type.values.join("|")})`;
    case "decimal":
      return `decimal(${type.scale})`;
    case "quantity":
      return `quantity(${type.unit}${type.scale === undefined ? "" : `, ${type.scale}`})`;
    default:
      return type.kind;
  }
};

/** Why `value` cannot be written as this value type, or undefined when it can. */
export const valueProblem = (type: OntologyValueTypeIR, value: unknown): string | undefined => {
  const valid =
    type.kind === "integer" || type.kind === "quantity" ? Number.isSafeInteger(value)
    : type.kind === "enum" ? typeof value === "string" && type.values.includes(value)
    : type.kind === "decimal" ? typeof value === "string" && decimalPattern(type.scale).test(value)
    : true;
  return valid ? undefined : `expects ${valueTypeLabel(type)}; received ${JSON.stringify(value)}`;
};
