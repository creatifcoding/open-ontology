export { Change, Input, Ontology, Property, S, defineOntology } from "./dsl.js";
export { Datalog } from "./datalog.js";
export type { DatalogResult, QueryTerm, QueryVariable, QueryVariables, QueryVariableSource, TypedDatalogQuery } from "./datalog.js";
export type { ActionChange, ActionTypeDefinition, ActionValue, LinkTypeDefinition, ObjectTypeDefinition, OntologyDeclaration, OntologyDefinition, PropertyDefinition, PropertyKind, QueryTypeDefinition } from "./model.js";
export type { ActionChangeIR, ActionInputIR, ActionTypeIR, ActionValueIR, DatalogQueryIR, DatalogValueIR, LinkTypeIR, ObjectTypeIR, OntologyDeclarationIR, OntologyIR, OntologyScalarTypeIR, OntologyValueTypeIR, PropertyIR, QueryTypeIR } from "./ir.js";
export { isOntologyIR } from "./ir.js";
export { materializeOntology, ontologyToIR } from "./materialize.js";
export { compileFormaOntology, elaborateFormaOntology, formaForms, formaLibrarySources, ontologyElaboration, ontologyElaborationDescriptors, ontologyPreludeSources, ontologyPreludeStats } from "./forma.js";
export { integrityConstraints, makeOntologyRuntime, toTriplexConfig, type ActionInvocationOptions, type OntologyQueryResponse, type OntologyRuntime } from "./runtime.js";
