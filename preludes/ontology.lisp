; ontology.lisp
; -----------------------------------------------------------------------------
; Domain ontology prelude — defines the ontology language constructs.
;
; This file uses the compiler's meta forms (define-form, meta-fn) to define
; the domain-specific constructs that ontology authors use.
;
; See ontology-compiler.lisp for the elaboration hooks (meta-fn implementations).
;
; Forms defined here:
;
; HTTP APIs:  define-schema, define-error, define-api-group, endpoint, param
; Structure:  define-entity, define-relation, define-record, define-link
; Queries:    define-query, define-view
; Navigation: define-workspace
; Compliance: define-constraint, resolution
; Operations: define-action, define-mutation
; Processes:  define-process, trigger, node, edge, guard
; Documents:  define-document, page, field, completion-mutation, option
; L10n:       define-document-locale, role, section, locale-field, define-document-localized
; PDF:        define-pdf-mapping, direct, computed, switch, case, set
;
; Depends on: compiler.lisp (define-form, meta-fn, etc.)
;
; Authoring rules for humans and agents:
; - Use the canonical `define-*` forms. Older forms such as `def-entity`,
;   `def-action`, `def-rule`, bare `entity`, and bare `query` are legacy
;   spellings and should be rewritten.
; - Field names are usually namespace-qualified symbols such as
;   `employee/name`, which lower to runtime attributes like `:employee/name`.
; - Type references use symbols (`String`, `Bool`, `Employee`) or compound
;   type forms such as `(Ref Department)`.
; - Runtime behavior for `:do`, `:where`, and ViewSpec bindings is ordinary
;   Lisp checked by the compiler hooks in ontology-compiler.lisp.
;
; Minimal authoring example:
;
;   (define-entity Employee
;     (:field [employee/name String {:required true}])
;     (:field [employee/department (Ref Department)]))
;
;   (define-record "emp:alice" Employee
;     (:field [employee/name "Alice"]))
;
;   (define-query employees
;     (:from Employee)
;     (:select [employee/name employee/department]))
;
; Status: executable (parsed by lisp-v2, meta-fn bodies run at compile time)
; -----------------------------------------------------------------------------

; =============================================================================
; SECTION 2 — ONTOLOGY CORE FORMS
; =============================================================================
;
; These are roughly the current canonical forms, but expressed as the desired
; end-state authoring model: descriptor-first, meta-hook-aware, and all in one
; file.
;
; Unclear point:
; - some of these might eventually factor through reusable form families
;   instead of each spelling out all structure.

(define-payload-contract KindPayload
  (:required-fields [kind])
  (:string-fields [kind]))

(define-payload-contract NamedKindPayload
  (:contract KindPayload)
  (:required-fields [name])
  (:string-fields [name]))

(define-payload-contract ArrayFieldsPayload
  (:required-fields [fields])
  (:array-fields [fields]))

(define-payload-contract ObjectFieldsPayload
  (:required-fields [fields])
  (:object-fields [fields]))

(define-payload-contract SourceTargetPayload
  (:required-fields [source target])
  (:string-fields [source target]))

(define-payload-contract NamedSourceTargetFieldsPayload
  (:contract [NamedKindPayload SourceTargetPayload ArrayFieldsPayload]))

(define-payload-contract SchemaPayload
  (:contract NamedKindPayload)
  (:literal-fields [[kind "Schema"]]))

(define-payload-contract HttpApiPayload
  (:contract NamedKindPayload)
  (:literal-fields [[kind "HttpApi"]]))

(define-payload-contract IdentityDeclarationPayload
  (:contract NamedKindPayload)
  (:required-fields [identityKind])
  (:literal-fields [[kind "IdentityDeclaration"]])
  (:string-fields [identityKind]))

(define-payload-contract RoleIdentityPayload
  (:contract IdentityDeclarationPayload)
  (:literal-fields [[identityKind "role"]]))

(define-payload-contract GroupIdentityPayload
  (:contract IdentityDeclarationPayload)
  (:literal-fields [[identityKind "group"]]))

(define-payload-contract MembershipIdentityPayload
  (:contract IdentityDeclarationPayload)
  (:required-fields [member group])
  (:literal-fields [[identityKind "membership"]])
  (:string-fields [member group]))

(define-payload-contract ContextualRoleIdentityPayload
  (:contract IdentityDeclarationPayload)
  (:literal-fields [[identityKind "contextual-role"]]))

(define-payload-contract FieldSchemaPayload
  (:contract [NamedKindPayload ArrayFieldsPayload]))

(define-payload-contract EntityPayload
  (:contract FieldSchemaPayload)
  (:literal-fields [[kind "Entity"]]))

(define-payload-contract MetaEntityPayload
  (:contract FieldSchemaPayload)
  (:literal-fields [[kind "MetaEntity"]]))

(define-payload-contract RelationPayload
  (:contract NamedSourceTargetFieldsPayload)
  (:literal-fields [[kind "Relation"]]))

(define-payload-contract RecordPayload
  (:contract [KindPayload ObjectFieldsPayload])
  (:required-fields [id entity])
  (:literal-fields [[kind "Record"]])
  (:string-fields [id entity]))

(define-payload-contract LinkPayload
  (:contract [KindPayload SourceTargetPayload ArrayFieldsPayload])
  (:required-fields [relation])
  (:literal-fields [[kind "Link"]])
  (:string-fields [relation]))

(define-payload-contract QueryPayload
  (:contract NamedKindPayload)
  (:required-fields [from])
  (:literal-fields [[kind "Query"]]))

(define-payload-contract DatalogQueryPayload
  (:contract QueryPayload)
  (:required-fields [datalog])
  (:string-fields [from])
  (:object-fields [datalog]))

(define-payload-contract QueryPresetPayload
  (:contract NamedKindPayload)
  (:required-fields [queryRef defaults])
  (:literal-fields [[kind "QueryPreset"]])
  (:object-fields [queryRef])
  (:array-fields [defaults]))

(define-payload-contract ViewPayload
  (:contract NamedKindPayload)
  (:required-fields [columns])
  (:literal-fields [[kind "View"]])
  (:array-fields [columns]))

(define-payload-contract WorkspacePayload
  (:contract NamedKindPayload)
  (:required-fields [views])
  (:literal-fields [[kind "Workspace"]])
  (:array-fields [views]))

(define-payload-contract PermissionPayload
  (:contract NamedKindPayload)
  (:required-fields [principal action resource effect])
  (:literal-fields [[kind "PermissionDeclaration"]])
  (:string-fields [principal action resource effect]))

(define-payload-contract ConstraintPayload
  (:contract NamedKindPayload)
  (:required-fields [entity severity when message resolutions])
  (:literal-fields [[kind "Constraint"]])
  (:string-fields [entity severity])
  (:array-fields [resolutions]))

(define-payload-contract OperationPayload
  (:contract NamedKindPayload)
  (:required-fields [inputs do])
  (:array-fields [inputs]))

(define-payload-contract ActionPayload
  (:contract OperationPayload)
  (:literal-fields [[kind "Action"]]))

(define-payload-contract MutationPayload
  (:contract OperationPayload)
  (:literal-fields [[kind "Mutation"]]))

(define-payload-contract ProcessPayload
  (:contract NamedKindPayload)
  (:required-fields [trigger nodes edges])
  (:literal-fields [[kind "Process"]])
  (:object-fields [trigger])
  (:array-fields [nodes edges]))

(define-payload-contract TaskPayload
  (:contract NamedKindPayload)
  (:required-fields [title inputs])
  (:literal-fields [[kind "TaskDefinition"]])
  (:string-fields [title])
  (:array-fields [inputs]))

(define-payload-contract DocumentPayload
  (:contract NamedKindPayload)
  (:required-fields [pages])
  (:literal-fields [[kind "Document"]])
  (:array-fields [pages]))

(define-payload-contract DocumentLocalePayload
  (:contract KindPayload)
  (:required-fields [documentName locale roles sections fields])
  (:literal-fields [[kind "DocumentLocale"]])
  (:string-fields [documentName locale])
  (:array-fields [roles sections fields]))

(define-payload-contract DocumentLocalizedPayload
  (:contract KindPayload)
  (:required-fields [documentName locales])
  (:literal-fields [[kind "DocumentLocalized"]])
  (:string-fields [documentName])
  (:array-fields [locales]))

(define-payload-contract PdfMappingPayload
  (:contract NamedKindPayload)
  (:required-fields [templateBlob mappings])
  (:literal-fields [[kind "PdfMapping"]])
  (:string-fields [templateBlob])
  (:array-fields [mappings]))

; HTTP API authoring forms are the declarative slice of the API DSL. They lower
; to canonical HttpApi IR while handlers still live in TypeScript.
(define-form define-schema
  (:phase domain)
  (:doc "Named schema declaration for generated HTTP API contracts.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot kind value (:required true))
    (slot identifier value)
    (slot doc value)
    (slot brand value)
    (slot pattern value)
    (slot fields value (:many true))
    (slot field value (:many true))
    (slot variants value (:many true))
    (slot items value)
    (slot value value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type SchemaDecl)))
  (:extensions
    (:artifact
      (:validators [http])
      (:payload (:contract SchemaPayload))))
  (:construct-fn http-schema/construct)
  (:result-type (constant SchemaDecl)))

(define-form define-error
  (:phase domain)
  (:doc "Tagged error schema declaration with transport annotations.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot fields value (:many true))
    (slot field value (:many true))
    (slot status value (:required true))
    (slot identifier value)
    (slot doc value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type SchemaDecl)))
  (:extensions
    (:artifact
      (:validators [http])
      (:payload (:contract SchemaPayload))))
  (:construct-fn http-error/construct)
  (:result-type (constant SchemaDecl)))

(define-form param
  (:phase domain)
  (:doc "HTTP path parameter declaration.")
  (:identifiers
    (identifier name Symbol)
    (identifier type Symbol)))

(define-form endpoint
  (:phase domain)
  (:doc "HTTP endpoint declaration nested inside define-api-group.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot method value (:required true))
    (slot path value (:required true))
    (slot payload value)
    (slot query value (:many true))
    (slot headers value (:many true))
    (slot success value (:required true))
    (slot errors value (:many true))
    (slot openapi value (:many true))))

(define-form define-api-group
  (:phase domain)
  (:doc "Declarative HTTP API group that emits canonical HttpApi IR.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot path-params value (:many true))
    (slot openapi value (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type HttpApiDecl)))
  (:extensions
    (:artifact
      (:validators [http])
      (:payload (:contract HttpApiPayload))))
  (:construct-fn http-api-group/construct)
  (:result-type (constant HttpApiDecl)))

; System attributes are platform-level facts shared across entity types.
; They are not usually authored in application ontologies, but they use the
; same descriptor machinery as user-facing forms.
(define-form define-system-attribute
  (:phase domain)
  (:doc "Cross-cutting platform attribute declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot doc value)
    (slot value-type value (:required true))
    (slot required value)
    (slot enum value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type SchemaDecl)))
  (:construct-fn system-attribute/construct)
  (:construct
    [kind "SystemAttribute"]
    [name (or declaration-name "anonymous-system-attribute")]
    [loc loc])
  (:result-type (constant SchemaDecl)))

; Entity definitions declare the shape of facts that can be asserted for a
; type. The `field` slot is repeated and normally uses vector shorthand:
;   (:field [employee/name String {:required true}])
; The first vector item is the attribute name, the second is the type, and the
; optional map carries field metadata.
(define-form define-entity
  (:phase domain)
  (:doc "Canonical entity/schema declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot doc value)
    (slot role value)
    (slot id-pattern value)
    (slot field value
      (:many true)
      (:required true)
      (:child-form field)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)
      (:child-slot unique value)
      (:child-slot indexed value)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type SchemaDecl)))
  (:bindings-fn entity/bindings)
  (:extensions
    (:artifact
      (:payload (:contract EntityPayload))))
  (:construct-fn entity/construct)
  (:construct
    [kind "Entity"]
    [name (or declaration-name "anonymous-entity")]
    [fields (entity-fields field)]
    [loc loc])
  (:declaration-type (row))
  (:result-type (constant SchemaDecl)))

; Meta entities are compiler/runtime bootstrap declarations. Application
; ontologies should prefer `define-entity`; this form exists so the system can
; describe its own internal catalog with the same machinery.
(define-form define-meta-entity
  (:phase domain)
  (:doc "Bootstrap-tier meta-schema declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot doc value)
    (slot role value)
    (slot id-pattern value)
    (slot field value
      (:many true)
      (:required true)
      (:child-form field)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)
      (:child-slot indexed value)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type SchemaDecl)))
  (:bindings-fn entity/bindings)
  (:extensions
    (:artifact
      (:payload (:contract MetaEntityPayload))))
  (:construct-fn meta-entity/construct)
  (:construct
    [kind "MetaEntity"]
    [name (or declaration-name "anonymous-meta-entity")]
    [fields (entity-fields field)]
    [loc loc])
  (:declaration-type (row))
  (:result-type (constant SchemaDecl)))

; Relations declare typed edges between two entity types. Relation instances
; are authored separately with `define-link`, while relation fields describe
; metadata about the edge itself.
(define-form define-relation
  (:phase domain)
  (:doc "Canonical relationship type declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true))
    (identifier source Symbol)
    (identifier target Symbol))
  (:slots
    (slot field value
      (:many true)
      (:child-form field)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)
      (:child-slot unique value)
      (:child-slot indexed value)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type RelationDef)))
  (:extensions
    (:artifact
      (:payload (:contract RelationPayload))))
  (:construct-fn relation/construct)
  (:construct
    [kind "Relation"]
    [name (or declaration-name "anonymous-relation")]
    [source (identifier source)]
    [target (identifier target)]
    [sourceRef (identifier-ref Entity source)]
    [targetRef (identifier-ref Entity target)]
    [fields (entity-fields field)]
    [loc loc])
  (:result-type (constant RelationDef)))

; Records are seed data. They assert one entity id, its entity type, and a
; repeated set of field values.
(define-form define-record
  (:phase domain)
  (:doc "Canonical entity assertion/seed record.")
  (:identifiers
    (identifier id String (:declaration true))
    (identifier entity Symbol))
  (:slots
    (slot field value
      (:many true)
      (:child-form field)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)
      (:child-slot indexed value)))
  (:bindings
    (bind bind-declaration-name (:identifier id) (:type RecordDef)))
  (:check-fn record/check)
  (:extensions
    (:artifact
      (:payload (:contract RecordPayload))))
  (:construct-fn record/construct)
  (:construct
    [kind "Record"]
    [id (or declaration-name (identifier id))]
    [entity (identifier entity)]
    [entityRef (identifier-ref Entity entity)]
    [fields (assignments field)]
    [loc loc])
  (:result-type (constant RecordDef)))

; Links are seed relationship instances. Source and target are entity ids,
; not entity type names.
(define-form define-link
  (:phase domain)
  (:doc "Canonical relationship assertion/link instance.")
  (:identifiers
    (identifier relation Symbol)
    (identifier source String)
    (identifier target String))
  (:slots
    (slot field value
      (:many true)
      (:child-form field)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)
      (:child-slot indexed value)))
  (:extensions
    (:artifact
      (:payload (:contract LinkPayload))))
  (:construct-fn link/construct)
  (:construct
    [kind "Link"]
    [relation (identifier relation)]
    [relationRef (identifier-ref Relation relation)]
    [sourceId (identifier source)]
    [targetId (identifier target)]
    [fields (assignments field)]
    [loc loc])
  (:result-type (constant LinkDef)))

; Queries are saved typed query declarations. `:from` chooses the row type,
; optional `:where` must evaluate to Bool, and optional `:select` projects
; fields from the row.
(define-form define-query
  (:phase domain)
  (:doc "Canonical query declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot from value (:required true))
    (slot where expr)
    (slot select value))
  (:bindings-fn query/bindings)
  (:result-type-fn query/result-type)
  (:infer-fn query/infer)
  (:validate-fn query/validate)
  (:extensions
    (:artifact
      (:payload
        (:contract QueryPayload))))
  (:construct-fn query/construct)
  )

; Raw Datalog queries are saved query declarations for cross-entity joins and
; graph traversals that are not expressible through the typed row-oriented
; `define-query` surface yet.
(define-form define-datalog-query
  (:phase domain)
  (:doc "Canonical raw Datalog saved query declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot query expr (:required true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type QueryDef)))
  (:result-type (constant QueryDef))
  (:extensions
    (:artifact
      (:payload (:contract DatalogQueryPayload))))
  (:construct-fn datalog-query/construct))

; Query presets are named partial applications of query parameters. They allow
; product surfaces to reuse one query with different default inputs.
(define-form define-query-preset
  (:phase domain)
  (:doc "Canonical named partial parameter application over a query.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot query value (:required true))
    (slot merge-policy value)
    (slot param value
      (:many true)
      (:child-form param)
      (:child-identifier name Symbol)
      (:child-slot value expr (:positional true))))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type QueryPresetDef)))
  (:extensions
    (:artifact
      (:payload (:contract QueryPresetPayload))))
  (:construct-fn query-preset/construct)
  (:result-type (constant QueryPresetDef)))

(define-form define-role
  (:phase domain)
  (:doc "Canonical principal role declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot description value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type IdentityDef)))
  (:extensions
    (:artifact
      (:payload (:contract RoleIdentityPayload))))
  (:construct-fn role/identity-construct)
  (:result-type (constant IdentityDef)))

(define-form define-group
  (:phase domain)
  (:doc "Canonical principal group declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot description value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type IdentityDef)))
  (:extensions
    (:artifact
      (:payload (:contract GroupIdentityPayload))))
  (:construct-fn group/identity-construct)
  (:result-type (constant IdentityDef)))

(define-form define-membership
  (:phase domain)
  (:doc "Canonical membership declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot member value (:required true))
    (slot group value (:required true))
    (slot description value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type IdentityDef)))
  (:extensions
    (:artifact
      (:payload (:contract MembershipIdentityPayload))))
  (:construct-fn membership/identity-construct)
  (:result-type (constant IdentityDef)))

(define-form define-contextual-role
  (:phase domain)
  (:doc "Canonical contextual role resolver declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot principal value)
    (slot resource value)
    (slot resolver expr)
    (slot description value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type IdentityDef)))
  (:extensions
    (:artifact
      (:payload (:contract ContextualRoleIdentityPayload))))
  (:construct-fn contextual-role/identity-construct)
  (:result-type (constant IdentityDef)))

(define-form define-permission
  (:phase domain)
  (:doc "Canonical permission declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot principal value (:required true))
    (slot action value (:required true))
    (slot resource value (:required true))
    (slot effect value)
    (slot condition expr)
    (slot description value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type PermissionDef)))
  (:extensions
    (:artifact
      (:payload (:contract PermissionPayload))))
  (:construct-fn permission/construct)
  (:result-type (constant PermissionDef)))

(define-form define-view
  (:phase domain)
  (:doc "Canonical query-backed view declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot query value)
    (slot title value)
    (slot description value)
    (slot subject value)
    (slot mode value)
    (slot column value
      (:many true)
      (:child-form column)
      (:child-identifier name Value))
    (slot default-sort value)
    (slot row-action expr)
    (slot empty-state value)
    (slot where expr (:type Bool))
    ;; Extended ViewSpec slots
    (slot state value (:many true)
      (:child-form state)
      (:child-identifier name Symbol)
      (:child-slot initial expr (:positional true))
      (:child-slot type value))
    (slot input-param value (:many true)
      (:child-form input-param)
      (:child-identifier name Symbol)
      (:child-slot type value (:positional true)))
    (slot named-query value (:many true)
      (:child-form named-query)
      (:child-identifier name Symbol)
      (:child-slot ref value)
      (:child-slot params expr)
      (:child-slot depends-on value (:many true)))
    (slot def value (:many true)
      (:child-form def)
      (:child-identifier name Symbol)
      (:child-slot layout expr (:positional true)))
    (slot layout expr))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type ViewDef))
    (bind bind-slot-declaration-result (:slot query) (:as row)))
  (:elaborates
    (elaborate resolve-slot-declaration-result (:slot query) (:declaration-kind Query) (:binding-name row)))
  (:validate-fn view/validate)
  (:extensions
    (:artifact
      (:payload
        (:contract ViewPayload))))
  (:construct-fn view/construct)
  (:construct
    [kind "View"]
    [name (or declaration-name "anonymous-view")]
    [query (named-text query)]
    [queryRef (slot-ref query)]
    [where (slot-expr where) {:optional true}]
    [resultType (query-ref-result-type query)]
    [loc loc])
  (:result-type (declaration-ref-result query)))

(define-form define-view-component
  (:phase domain)
  (:doc "Reusable embeddable view fragment declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot query value)
    (slot title value)
    (slot description value)
    (slot subject value)
    (slot mode value)
    (slot column value
      (:many true)
      (:child-form column)
      (:child-identifier name Value))
    (slot default-sort value)
    (slot row-action expr)
    (slot empty-state value)
    (slot where expr (:type Bool))
    (slot state value (:many true)
      (:child-form state)
      (:child-identifier name Symbol)
      (:child-identifier initial Value))
    (slot input-param value (:many true)
      (:child-form input-param)
      (:child-identifier name Symbol)
      (:child-slot type value (:positional true)))
    (slot named-query value (:many true)
      (:child-form named-query)
      (:child-identifier name Symbol)
      (:child-slot ref value)
      (:child-slot params expr)
      (:child-slot depends-on value (:many true)))
    (slot layout expr))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type ViewDef))
    (bind bind-slot-declaration-result (:slot query) (:as row)))
  (:elaborates
    (elaborate resolve-slot-declaration-result (:slot query) (:declaration-kind Query) (:binding-name row)))
  (:validate-fn view/validate)
  (:extensions
    (:artifact
      (:payload
        (:contract ViewPayload))))
  (:construct-fn view/construct)
  (:construct
    [kind "View"]
    [name (or declaration-name "anonymous-view-component")]
    [query (named-text query)]
    [queryRef (slot-ref query)]
    [where (slot-expr where) {:optional true}]
    [resultType (query-ref-result-type query)]
    [loc loc])
  (:result-type (declaration-ref-result query)))

(define-form define-workspace
  (:phase domain)
  (:doc "Canonical workspace declaration. Pure metadata + view references.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot title value)
    (slot persona value)
    (slot subject value)
    (slot home value)
    (slot view value (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type WorkspaceDef)))
  (:extensions
    (:artifact
      (:payload (:contract WorkspacePayload))))
  (:construct-fn workspace/construct)
  (:result-type (constant WorkspaceDef)))

(define-form resolution
  (:phase domain)
  (:doc "Constraint resolution path attached to a canonical constraint.")
  (:slots
    (slot label value (:required true))
    (slot action value (:required true) (:alias mutation))
    (slot auto value)
    (slot input value
      (:many true)
      (:child-form input)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)))
  (:construct-fn resolution/construct)
  (:construct
    [label (slot-string label)]
    [action (slot-string action)]
    [actionRef (slot-ref action)]
    [autoInvoke (slot-bool auto)]
    [inputs (resolution-inputs input)]
    [loc loc])
  (:result-type (constant ConstraintResolutionDef)))

(define-form define-constraint
  (:phase domain)
  (:doc "Canonical invariant/validation constraint.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot entity value (:required true))
    (slot severity value (:required true))
    (slot description value)
    (slot category value)
    (slot violation-query expr (:required true))
    (slot message expr (:required true))
    (slot assigns-task-to value
      (:many true)
      (:child-form assigns-task-to)
      (:child-identifier role Symbol)
      (:child-slot priority value)
      (:child-slot title expr)
      (:child-slot body expr))
    (slot resolution form (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type ConstraintDef)))
  (:validation
    (validate validate-one-of (:slot severity) (:values [error warning info])))
  (:extensions
    (:artifact
      (:payload (:contract ConstraintPayload))))
  (:construct-fn constraint/construct)
  (:construct
    [kind "Constraint"]
    [name (or declaration-name "anonymous-constraint")]
    [entity (slot-string entity)]
    [entityRef (slot-ref entity)]
    [severity (slot-string severity)]
    [description (slot-string description) {:optional true}]
    [category (slot-string category) {:optional true}]
    [resolutions (children resolution)]
    [loc loc])
  (:result-type (constant ConstraintDef)))

; Actions are named side-effectful operations. They declare typed inputs,
; a return type, and a `:do` expression. Use actions for external effects,
; notifications, document generation, or orchestrating runtime services.
(define-form define-action
  (:phase domain)
  (:doc "Canonical side-effectful action declaration with typed inputs and a Lisp do body.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot input value
      (:many true)
      (:required true)
      (:child-form input)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value))
    (slot returns value (:required true))
    (slot do expr (:required true) (:type-from returns)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type ActionDef)))
  (:extensions
    (:artifact
      (:payload (:contract ActionPayload))))
  (:construct-fn action/construct)
  (:construct
    [kind "Action"]
    [name (or declaration-name "anonymous-action")]
    [inputs (action-inputs input)]
    [loc loc])
  (:result-type (slot-type returns)))

; Mutations have the same surface as actions but represent state-changing
; operations owned by the ontology rather than external side effects.
(define-form define-mutation
  (:phase domain)
  (:doc "Canonical state-changing mutation declaration with typed inputs and a Lisp do body.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot input value
      (:many true)
      (:required true)
      (:child-form input)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value))
    (slot returns value (:required true))
    (slot do expr (:required true) (:type-from returns)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type MutationDef)))
  (:extensions
    (:artifact
      (:payload (:contract MutationPayload))))
  (:construct-fn mutation/construct)
  (:construct
    [kind "Mutation"]
    [name (or declaration-name "anonymous-mutation")]
    [inputs (action-inputs input)]
    [loc loc])
  (:result-type (slot-type returns)))

(define-form trigger
  (:phase domain)
  (:doc "Process trigger declaration.")
  (:identifiers
    (identifier kind Symbol)
    (identifier entity Symbol))
  (:construct-fn trigger/construct)
  (:construct
    [kind (identifier kind)]
    [entity (identifier entity) {:optional true}]
    [entityRef (slot-ref entity) {:optional true}]
    [loc loc])
  (:result-type (constant ProcessTriggerDef)))

(define-form node
  (:phase domain)
  (:doc "Process node definition.")
  (:identifiers
    (identifier id Symbol))
  (:slots
    (slot action value)
    (slot mutation value)
    (slot join value)
    (slot fan-out value)
    (slot input value
      (:many true)
      (:child-form input)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value)))
  (:construct-fn node/construct)
  (:construct
    [id (identifier id)]
    [action (slot-string action) {:optional true}]
    [actionRef (slot-ref action) {:optional true}]
    [mutation (slot-string mutation) {:optional true}]
    [mutationRef (slot-ref mutation) {:optional true}]
    [join (slot-string join) {:optional true}]
    [fanOut (slot-string fan-out) {:optional true}]
    [inputs (workflow-inputs input)]
    [loc loc])
  (:result-type (constant ProcessNodeDef)))

(define-form guard
  (:phase domain)
  (:doc "Process edge guard.")
  (:identifiers
    (identifier kind Symbol)
    (identifier value Value))
  (:validation
    (validate validate-one-of (:slot kind) (:values [expr not-expr])))
  (:construct-fn guard/construct)
  (:construct
    [kind (identifier kind)]
    [expr (lower-runtime-expr (identifier-expr value))]
    [loc loc])
  (:result-type (constant ProcessGuardDef)))

(define-form edge
  (:phase domain)
  (:doc "Process edge definition.")
  (:identifiers
    (identifier from Symbol)
    (identifier to Symbol))
  (:slots
    (slot guard form))
  (:construct-fn edge/construct)
  (:construct
    [from (identifier from)]
    [to (identifier to)]
    [guard (first-child guard) {:optional true}]
    [loc loc])
  (:result-type (constant ProcessEdgeDef)))

(define-form define-process
  (:phase domain)
  (:doc "Canonical process definition.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot description value)
    (slot trigger form (:required true))
    (slot node form (:many true))
    (slot edge form (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type ProcessDef)))
  (:validate-fn process/validate)
  (:extensions
    (:artifact
      (:payload (:contract ProcessPayload))))
  (:construct-fn process/construct)
  (:construct
    [kind "Process"]
    [name (or declaration-name "anonymous-process")]
    [description (slot-string description) {:optional true}]
    [trigger (first-child trigger)]
    [nodes (children node)]
    [edges (children edge)]
    [loc loc])
  (:result-type (constant ProcessDef)))

(define-form define-task
  (:phase domain)
  (:doc "Reusable task definition declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot title value (:required true))
    (slot description value)
    (slot document value)
    (slot section value (:many true))
    (slot assignee value)
    (slot guidance value)
    (slot input value
      (:many true)
      (:child-form input)
      (:child-identifier name Value)
      (:child-slot type expr (:positional true))
      (:child-slot required value))
    (slot scope value))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type TaskDefinitionDef)))
  (:extensions
    (:artifact
      (:payload (:contract TaskPayload))))
  (:construct-fn task-definition/construct)
  (:construct
    [kind "TaskDefinition"]
    [name (or declaration-name "anonymous-task-definition")]
    [title (slot-string title)]
    [description (slot-string description) {:optional true}]
    [documentRef (slot-ref document) {:optional true}]
    [sectionRefs (slot-string-list section) {:optional true}]
    [guidanceRef (slot-string guidance) {:optional true}]
    [inputs (action-inputs input)]
    [loc loc])
  (:result-type (constant TaskDefinitionDef)))

; =============================================================================
; SECTION 3 — DOCUMENT / LOCALIZATION / PDF FORMS
; =============================================================================

(define-form define-document
  (:phase domain)
  (:doc "Canonical document template declaration.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot description value)
    (slot page form (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type DocumentDef)))
  (:extensions
    (:artifact
      (:payload (:contract DocumentPayload))))
  (:construct-fn document/construct)
  (:construct
    [kind "Document"]
    [name (or declaration-name "anonymous-document")]
    [description (slot-string description) {:optional true}]
    [pages (children page)]
    [loc loc])
  (:result-type (constant DocumentDef)))

(define-form page
  (:phase domain)
  (:doc "Document page/section definition.")
  (:slots
    (slot section-id value)
    (slot assignee value (:required true))
    (slot depends-on value (:many true))
    (slot description value (:alias page-description))
    (slot completion-mutation form (:alias completion-action))
    (slot field form (:many true)))
  (:construct-fn page/construct)
  (:construct
    [sectionId (slot-string section-id) {:optional true}]
    [assignee (slot-string assignee)]
    [description (slot-string description) {:optional true}]
    [dependsOn (slot-string-list depends-on)]
    [completion (first-child completion-mutation) {:optional true}]
    [fields (children field)]
    [loc loc])
  (:result-type (constant DocumentPageDef)))

(define-form field
  (:phase domain)
  (:doc "Document field definition.")
  (:identifiers
    (identifier type Symbol)
    (identifier path Symbol))
  (:slots
    (slot label value)
    (slot description value)
    (slot content value)
    (slot required value (:alias document-required))
    (slot bind value (:many true))
    (slot option form (:many true)))
  (:construct-fn field/construct)
  (:construct
    [type (canonical-identifier type)]
    [path (canonical-identifier path)]
    [label (slot-string label) {:optional true}]
    [description (slot-string description) {:optional true}]
    [content (slot-string content) {:optional true}]
    [required (slot-bool required)]
    [binding (attribute-binding bind) {:optional true}]
    [options (children option)]
    [loc loc])
  (:result-type (constant DocumentFieldDef)))

(define-form completion-mutation
  (:phase domain)
  (:doc "Document section completion mutation.")
  (:identifiers
    (identifier mutation String)
    (identifier entity String))
  (:construct-fn completion-mutation/construct)
  (:construct
    [mutation (identifier mutation)]
    [mutationRef (slot-ref mutation)]
    [entity (identifier entity) {:optional true}]
    [entityRef (slot-ref entity) {:optional true}]
    [loc loc])
  (:result-type (constant DocumentCompletionDef)))

(define-form option
  (:phase domain)
  (:doc "Select option.")
  (:identifiers
    (identifier value String)
    (identifier label String))
  (:construct-fn option/construct)
  (:construct
    [value (identifier value)]
    [label (identifier label)])
  (:result-type (constant DocumentOptionDef)))

(define-form define-document-locale
  (:phase domain)
  (:doc "Translations for a document locale.")
  (:slots
    (slot document value (:required true) (:alias form))
    (slot locale value (:required true))
    (slot role form (:many true))
    (slot section form (:many true))
    (slot field form (:many true)))
  (:construct-fn document-locale/construct)
  (:extensions
    (:artifact
      (:payload (:contract DocumentLocalePayload))))
  (:construct
    [kind "DocumentLocale"]
    [documentName (slot-string document)]
    [documentRef (slot-ref document)]
    [locale (slot-string locale)]
    [roles (children role)]
    [sections (children section)]
    [fields (children field)]
    [loc loc])
  (:result-type (constant DocumentLocaleDef)))

(define-form role
  (:phase domain)
  (:doc "Localized role translation.")
  (:identifiers
    (identifier name String))
  (:slots
    (slot label value)
    (slot description value))
  (:constructed-by document-locale-elaboration)
  (:construct
    [role (identifier name)]
    [label (slot-string label) {:optional true}]
    [description (slot-string description) {:optional true}]
    [loc loc])
  (:result-type (constant DocumentRoleLocaleDef)))

(define-form section
  (:phase domain)
  (:doc "Localized section translation.")
  (:identifiers
    (identifier name String))
  (:slots
    (slot label value)
    (slot description value))
  (:validation
    (validate validate-membership (:slot name) (:collection document.sections)))
  (:constructed-by document-locale-elaboration)
  (:construct
    [sectionId (identifier name)]
    [label (slot-string label) {:optional true}]
    [description (slot-string description) {:optional true}]
    [loc loc])
  (:result-type (constant DocumentSectionLocaleDef)))

(define-form locale-field
  (:phase domain)
  (:doc "Localized field translation.")
  (:identifiers
    (identifier path Symbol))
  (:slots
    (slot label value)
    (slot description value)
    (slot option form (:many true)))
  (:validation
    (validate validate-membership (:slot path) (:collection document.fields)))
  (:constructed-by document-locale-elaboration :child field)
  (:construct
    [path (canonical-identifier path)]
    [label (slot-string label) {:optional true}]
    [description (slot-string description) {:optional true}]
    [options (children option)]
    [loc loc])
  (:result-type (constant DocumentFieldLocaleDef)))

(define-form define-document-localized
  (:phase domain)
  (:doc "Document locale composition.")
  (:slots
    (slot document value (:required true) (:alias form))
    (slot locales value (:many true))
    (slot default-locale value))
  (:validate-fn document-localized/validate)
  (:validation
    (validate validate-list-membership (:slot locales) (:collection document.locales))
    (validate validate-default-in-list (:default-slot default-locale) (:list-slot locales)))
  (:extensions
    (:artifact
      (:payload (:contract DocumentLocalizedPayload))))
  (:construct-fn document-localized/construct)
  (:construct
    [kind "DocumentLocalized"]
    [documentName (slot-string document)]
    [documentRef (slot-ref document)]
    [locales (slot-string-list locales)]
    [defaultLocale (slot-string default-locale) {:optional true}]
    [loc loc])
  (:result-type (constant DocumentLocalizedDef)))

(define-form define-pdf-mapping
  (:phase domain)
  (:doc "PDF field mapping definition.")
  (:identifiers
    (identifier name Symbol (:declaration true)))
  (:slots
    (slot display-name value)
    (slot description value)
    (slot template-blob value (:required true))
    (slot template-file value)
    (slot template-filename value)
    (slot document-ref value (:alias form-ref))
    (slot direct form (:many true))
    (slot computed form (:many true))
    (slot switch form (:many true)))
  (:bindings
    (bind bind-declaration-name (:identifier name) (:type PdfMappingDef)))
  (:extensions
    (:artifact
      (:payload (:contract PdfMappingPayload))))
  (:construct-fn pdf-mapping/construct)
  (:construct
    [kind "PdfMapping"]
    [name (or declaration-name "anonymous-pdf-mapping")]
    [displayName (slot-string display-name) {:optional true}]
    [description (slot-string description) {:optional true}]
    [templateBlob (slot-string template-blob)]
    [templateFile (slot-string template-file) {:optional true}]
    [templateFilename (slot-string template-filename) {:optional true}]
    [documentName (slot-string document-ref) {:optional true}]
    [documentRef (slot-ref document-ref) {:optional true}]
    [mappings (concat (children direct) (children computed) (children switch))]
    [loc loc])
  (:result-type (constant PdfMappingDef)))

(define-form direct
  (:phase domain)
  (:doc "Direct PDF mapping.")
  (:identifiers
    (identifier source String)
    (identifier pdf-field String))
  (:slots
    (slot transform value))
  (:construct-fn direct/construct)
  (:construct
    [kind "direct"]
    [source (identifier source)]
    [pdfField (identifier pdf-field)]
    [transform (slot-string transform) {:optional true}]
    [loc loc])
  (:result-type (constant PdfDirectDef)))

(define-form computed
  (:phase domain)
  (:doc "Computed PDF mapping.")
  (:identifiers
    (identifier expression Value)
    (identifier pdf-field String))
  (:slots
    (slot transform value))
  (:construct-fn computed/construct)
  (:construct
    [kind "computed"]
    [expr (lower-runtime-expr (identifier-expr expression))]
    [pdfField (identifier pdf-field)]
    [transform (slot-string transform) {:optional true}]
    [loc loc])
  (:result-type (constant PdfComputedDef)))

(define-form switch
  (:phase domain)
  (:doc "Switch PDF mapping.")
  (:identifiers
    (identifier source String))
  (:slots
    (slot case form (:many true)))
  (:construct-fn switch/construct)
  (:construct
    [kind "switch"]
    [source (identifier source)]
    [cases (children case)]
    [loc loc])
  (:result-type (constant PdfSwitchDef)))

(define-form case
  (:phase domain)
  (:doc "Switch case for a PDF mapping.")
  (:identifiers
    (identifier when String))
  (:slots
    (slot set form (:many true)))
  (:construct-fn case/construct)
  (:construct
    [when (identifier when)]
    [assignments (children set)]
    [loc loc])
  (:result-type (constant PdfCaseDef)))

(define-form set
  (:phase domain)
  (:doc "PDF field assignment.")
  (:identifiers
    (identifier pdf-field String)
    (identifier value Value))
  (:construct-fn set/construct)
  (:construct
    [pdfField (identifier pdf-field)]
    [value (identifier-scalar value)])
  (:result-type (constant PdfSetDef)))


; =============================================================================
; SECTION 6 — OPEN QUESTIONS
; =============================================================================
;
; 1. Name conflict between meta `(form ...)` and domain document declarations.
;    - maybe phase-qualified heads solve this better.
;
; 2. Should static :bindings / :elaborates / :construct remain author-facing?
;    - they are useful as readable canonical IR today.
;    - but long-term they may be compiled output from higher-level meta forms.
;
; 3. Should meta-fn bodies be ordinary Lisp?
;    - probably not fully.
;    - likely a restricted compile-time Lisp subset or structured meta AST.
;
; 4. What is the smallest kernel bootstrap seed?
;    - enough to parse + validate `form` and `meta-fn`
;    - then ontology.lisp bootstraps the rest.
;
; 5. Can some PDF forms be raised to richer shared reusable families
;    instead of plain descriptor repetition?
;    - likely yes, but deferred here.
