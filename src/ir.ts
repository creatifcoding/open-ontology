/** A JSON-safe ontology representation shared by every authoring surface and backend. */
import type { JsonSchema } from "effect";

export type OntologyScalarTypeIR = "string" | "integer" | "number" | "boolean" | "datetime" | "json";

export type OntologyValueTypeIR =
  | { readonly kind: OntologyScalarTypeIR }
  | { readonly kind: "ref"; readonly target: string }
  /** One of a closed set of string values. */
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** An exact decimal with at most `scale` fraction digits, carried as a canonical string. */
  | { readonly kind: "decimal"; readonly scale: number }
  /** A safe integer count of `unit`, or of its 10^-scale fraction when `scale` is set. */
  | { readonly kind: "quantity"; readonly unit: string; readonly scale?: number };

export interface PropertyIR {
  readonly name: string;
  readonly key: `:${string}/${string}`;
  readonly valueType: OntologyValueTypeIR;
  readonly required: boolean;
  readonly cardinality: "one" | "many";
  readonly unique: boolean;
}

export interface ObjectTypeIR {
  readonly kind: "object-type";
  readonly name: string;
  readonly description?: string;
  readonly properties: readonly PropertyIR[];
}

export interface LinkTypeIR {
  readonly kind: "link-type";
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly description?: string;
  readonly properties: readonly PropertyIR[];
}

export interface ActionInputIR {
  readonly name: string;
  readonly valueType: OntologyValueTypeIR;
  readonly cardinality?: "one" | "many";
  readonly optional?: boolean;
}

export interface InputValueIR {
  readonly kind: "input";
  readonly name: string;
}

export interface NowValueIR {
  readonly kind: "now";
}

export type ActionValueIR = InputValueIR | NowValueIR | string | number | boolean | null;

export type ActionChangeIR =
  | {
      readonly kind: "create-object";
      readonly objectType: string;
      readonly id: ActionValueIR;
      readonly properties: Readonly<Record<string, ActionValueIR>>;
    }
  | {
      readonly kind: "set-property";
      readonly object: ActionValueIR;
      readonly property: `:${string}/${string}`;
      readonly value: ActionValueIR;
    }
  | {
      readonly kind: "clear-property";
      readonly object: ActionValueIR;
      readonly property: `:${string}/${string}`;
    }
  | {
      readonly kind: "create-link";
      readonly linkType: string;
      readonly from: ActionValueIR;
      readonly to: ActionValueIR;
      readonly properties: Readonly<Record<string, ActionValueIR>>;
    };

export interface ActionTypeIR {
  readonly kind: "action-type";
  readonly name: string;
  readonly description?: string;
  readonly input: readonly ActionInputIR[];
  /** Portable transport contract. Retains nested fields, unions, literals, and JSON Schema checks. */
  readonly inputSchema?: JsonSchema.Document<"draft-2020-12">;
  readonly changes: readonly ActionChangeIR[];
}

export type DatalogValueIR =
  | string
  | number
  | boolean
  | null
  | readonly DatalogValueIR[]
  | { readonly [key: string]: DatalogValueIR };

export interface DatalogQueryIR {
  readonly find: readonly DatalogValueIR[];
  readonly where: readonly (readonly DatalogValueIR[])[];
  readonly aggregate?: readonly (readonly DatalogValueIR[])[];
  readonly having?: readonly (readonly DatalogValueIR[])[];
  readonly orderBy?: readonly {
    readonly variable: string;
    readonly direction?: "asc" | "desc";
  }[];
  readonly limit?: number;
  readonly offset?: number;
  readonly rules?: readonly {
    readonly name: string;
    readonly body: readonly (readonly DatalogValueIR[])[];
    readonly maxDepth?: number;
  }[];
  readonly optionalProjection?: {
    readonly rowBinding: string;
    readonly fields: readonly {
      readonly attribute: string;
      readonly variable: string;
    }[];
  };
}

export interface QueryTypeIR {
  readonly kind: "query-type";
  readonly name: string;
  readonly description?: string;
  readonly query: DatalogQueryIR;
}

export type OntologyDeclarationIR = ObjectTypeIR | LinkTypeIR | ActionTypeIR | QueryTypeIR;

export interface OntologyIR {
  readonly kind: "ontology";
  readonly name: string;
  readonly version: string;
  readonly objectTypes: readonly ObjectTypeIR[];
  readonly linkTypes: readonly LinkTypeIR[];
  readonly actionTypes: readonly ActionTypeIR[];
  readonly queryTypes: readonly QueryTypeIR[];
}

export const isOntologyIR = (value: unknown): value is OntologyIR =>
  typeof value === "object" && value !== null && "kind" in value && value.kind === "ontology";
