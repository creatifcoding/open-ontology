import { Schema } from "effect";
import type { DatalogQuery } from "@triplex-build/triplex";
import type { ActionInputIR, OntologyValueTypeIR } from "./ir.js";

declare const entityIdentityType: unique symbol;
declare const entitySourceType: unique symbol;
export declare const PropertyQueryType: unique symbol;
declare const propertyOwnerType: unique symbol;
declare const queryRowType: unique symbol;

export interface ObjectTypeIdentity<Name extends string = string> {
  readonly kind: "object";
  readonly name: Name;
}

export interface LinkTypeIdentity<Name extends string = string> {
  readonly kind: "link";
  readonly name: Name;
}

/** An entity id branded only for query authoring. At runtime this is a string. */
export type OntologyEntityId<Identity> = string & {
  readonly [entityIdentityType]: Identity;
};

/** Source for a query variable bound to an object or link instance. */
export interface EntityQuerySource<Identity> {
  readonly _tag: "Entity";
  readonly name: string;
  readonly [entitySourceType]: Identity;
}

export type PropertyKind = OntologyValueTypeIR["kind"];

export interface PropertyDefinition<A = any, QueryValue = A> {
  readonly _tag: "Property";
  readonly key: `:${string}/${string}`;
  readonly schema: Schema.Schema<A>;
  readonly kind: PropertyKind;
  /** The portable value type, including enum values, decimal scale, and quantity unit. */
  readonly valueType: OntologyValueTypeIR;
  readonly isRequired: boolean;
  readonly cardinality: "one" | "many";
  readonly isUnique: boolean;
  readonly target?: ObjectTypeDefinition;
  readonly [PropertyQueryType]?: QueryValue;
}

export type PropertyQueryValue<P> =
  P extends PropertyDefinition<any, infer QueryValue> ? QueryValue : never;

export type OwnedProperty<P, Owner> = P & {
  readonly [propertyOwnerType]: Owner;
};

export type PropertyOwner<P> = P extends { readonly [propertyOwnerType]: infer Owner }
  ? Owner
  : unknown;

export type OwnedProperties<P, Owner> = {
  readonly [Key in keyof P]: OwnedProperty<P[Key], Owner>;
};

export interface ObjectTypeDefinition<
  Name extends string = string,
  P extends Readonly<Record<string, PropertyDefinition>> = Readonly<
    Record<string, PropertyDefinition<any, any>>
  >,
> {
  readonly _tag: "ObjectType";
  readonly name: Name;
  readonly description?: string;
  readonly entity: EntityQuerySource<ObjectTypeIdentity<Name>>;
  readonly properties: OwnedProperties<P, ObjectTypeIdentity<Name>>;
}

export type LinkEndpoints<
  Name extends string,
  From extends ObjectTypeDefinition,
  To extends ObjectTypeDefinition,
> = {
  readonly from: OwnedProperty<
    PropertyDefinition<string, OntologyEntityId<ObjectTypeIdentity<From["name"]>>>,
    LinkTypeIdentity<Name>
  >;
  readonly to: OwnedProperty<
    PropertyDefinition<string, OntologyEntityId<ObjectTypeIdentity<To["name"]>>>,
    LinkTypeIdentity<Name>
  >;
};

export interface LinkTypeDefinition<
  Name extends string = string,
  From extends ObjectTypeDefinition = ObjectTypeDefinition,
  To extends ObjectTypeDefinition = ObjectTypeDefinition,
  P extends Readonly<Record<string, PropertyDefinition>> = Readonly<
    Record<string, PropertyDefinition<any, any>>
  >,
> {
  readonly _tag: "LinkType";
  readonly name: Name;
  readonly from: From;
  readonly to: To;
  readonly description?: string;
  readonly entity: EntityQuerySource<LinkTypeIdentity<Name>>;
  readonly properties: OwnedProperties<P, LinkTypeIdentity<Name>>;
  readonly endpoints: LinkEndpoints<Name, From, To>;
}

export interface InputValue {
  readonly _tag: "Input";
  readonly name: string;
}

export interface NowValue {
  readonly _tag: "Now";
}

export type ActionValue = InputValue | NowValue | string | number | boolean | null;

export type ActionChange =
  | {
      readonly _tag: "CreateObject";
      readonly objectType: ObjectTypeDefinition;
      readonly id: ActionValue;
      readonly properties: Readonly<Record<string, ActionValue>>;
    }
  | {
      readonly _tag: "SetProperty";
      readonly object: ActionValue;
      readonly property: PropertyDefinition;
      readonly value: ActionValue;
    }
  | {
      readonly _tag: "ClearProperty";
      readonly object: ActionValue;
      readonly property: PropertyDefinition;
    }
  | {
      readonly _tag: "CreateLink";
      readonly linkType: LinkTypeDefinition;
      readonly from: ActionValue;
      readonly to: ActionValue;
      readonly properties: Readonly<Record<string, ActionValue>>;
    };

export interface ActionTypeDefinition<I = unknown> {
  readonly _tag: "ActionType";
  readonly name: string;
  readonly description?: string;
  readonly input: Schema.Schema<I> & { readonly DecodingServices: never };
  readonly inputFields: readonly ActionInputIR[];
  readonly changes: readonly ActionChange[];
}

export interface QueryTypeDefinition<Row = Readonly<Record<string, unknown>>> {
  readonly _tag: "QueryType";
  readonly name: string;
  readonly description?: string;
  readonly query: DatalogQuery;
  readonly [queryRowType]: Row;
}

export interface OntologyDefinition {
  readonly name: string;
  readonly version: string;
  readonly objectTypes: ReadonlyMap<string, ObjectTypeDefinition<any, any>>;
  readonly linkTypes: ReadonlyMap<string, LinkTypeDefinition<any, any, any, any>>;
  readonly actionTypes: ReadonlyMap<string, ActionTypeDefinition>;
  readonly queryTypes: ReadonlyMap<string, QueryTypeDefinition>;
}

export type OntologyDeclaration =
  | ObjectTypeDefinition<any, any>
  | LinkTypeDefinition<any, any, any, any>
  | ActionTypeDefinition
  | QueryTypeDefinition<any>;
