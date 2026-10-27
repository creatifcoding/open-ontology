; ontology-compiler.lisp
; -----------------------------------------------------------------------------
; Elaboration hooks for ontology domain forms.
;
; This file contains meta-fn implementations that compile ontology forms
; into canonical IR. Each hook corresponds to a (define-form ...) declaration
; in ontology.lisp.
;
; Depends on: compiler.lisp (define-form, meta-fn, meta/* builtins)
;
; How to read this file:
; - Each `meta-fn` name is referenced from ontology.lisp via `:*-fn` slots.
; - `(:kind bindings)` returns names and types introduced by a form.
; - `(:kind validate)` returns diagnostics without constructing IR.
; - `(:kind result-type)` computes the type of the form expression.
; - `(:kind construct)` builds the canonical IR payload consumed by TypeScript.
; - Helper calls with `meta/*`, `type/*`, `diag/*`, and `construct/*` are
;   compiler-hosted builtins, not user ontology functions.
;
; Debugging path:
; 1. Inspect the form declaration in ontology.lisp.
; 2. Find the hook named by `:bindings-fn`, `:validate-fn`, `:result-type-fn`,
;    or `:construct-fn`.
; 3. Follow the hook body here to see how slots and identifiers lower to IR.
;
; Status: executable (meta-fn bodies run at compile time via kernel evaluator)
; -----------------------------------------------------------------------------

; =============================================================================
; HTTP API AUTHORING HOOKS
; =============================================================================

(meta-fn http-schema/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output SchemaIR)
  (:doc "Constructs canonical HTTP schema IR from a declarative schema form.")
  (:body
    (construct/assoc
      (http/schema-decl input)
      :$summary
      (construct/summary
        :kind "Schema"
        :name (meta/declaration-name input)
        :resultType "SchemaDecl"))))

(meta-fn http-error/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output SchemaIR)
  (:doc "Constructs canonical HTTP error schema IR from a declarative error form.")
  (:body
    (construct/assoc
      (http/error-decl input)
      :$summary
      (construct/summary
        :kind "Schema"
        :name (meta/declaration-name input)
        :resultType "SchemaDecl"))))

(meta-fn http-api-group/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output HttpApiIR)
  (:doc "Constructs canonical HTTP API IR from a declarative API group.")
  (:body
    (construct/assoc
      (http/api-group-decl input)
      :$summary
      (construct/summary
        :kind "HttpApi"
        :name (meta/declaration-name input)
        :resultType "HttpApiDecl"))))

; =============================================================================
; QUERY HOOKS
; =============================================================================

; Entity bindings publish schema field types into the local semantic environment
; so later forms can project source-local declaration fields through generic
; declaration reflection instead of engine-side special cases.
(meta-fn entity/bindings
  (:kind bindings)
  (:input FormMetaInput)
  (:output BindingMap)
  (:doc "Publishes source-local entity field bindings for later descriptor hooks.")
  (:body
    (let [name (meta/declaration-name input)
          fields (meta/declaration-fields input)]
      (if (nil? name)
        (bindings/empty)
        (bindings/from-fields (str "$entity:" name ":") fields)))))

; Query bindings introduce the query declaration name, the implicit `it` row
; binding, and query-body field bindings. The field bindings keep predicates
; like `employee/active` descriptor-authored while row projection matures.
(meta-fn query/bindings
  (:kind bindings)
  (:input FormMetaInput)
  (:output BindingMap)
  (:doc "Computes HM bindings for a query form.")
  (:body
    (let [decl-name (meta/declaration-name input)
          from-name (meta/slot-symbol input :from)
          from-decl (meta/lookup-declaration input from-name)
          row-type (meta/declaration-type from-decl)]
      (bindings/merge
        (bindings/when decl-name
          (bindings/from-declaration decl-name (type/constant "QueryDef")))
        (if row-type
          (bindings/merge
            (bindings/of ["it" row-type])
            (bindings/from-fields "" (meta/declaration-fields from-decl)))
          (bindings/empty))))))

; Query result type is either a list of full entity rows or a list of projected
; row shapes when `:select` is present.
(meta-fn query/result-type
  (:kind result-type)
  (:input FormMetaInput)
  (:output Type)
  (:doc "Computes the result type for a query form from :from and :select.")
  (:body
    (let [from-name (meta/slot-symbol input :from)
          from-decl (meta/lookup-declaration input from-name)
          row-type (meta/declaration-type from-decl)
          select-fields (meta/slot-string-list input :select)]
      (if (nil? row-type)
        (type/unknown)
        (if (empty? select-fields)
          (type/list row-type)
          (type/list (meta/project-type from-decl select-fields)))))))

; Query validation keeps the form-level descriptor small while still allowing
; semantic checks that need type information.
(meta-fn query/validate
  (:kind validate)
  (:input FormMetaInput)
  (:output DiagnosticList)
  (:doc "Runs semantic validation for query instances.")
  (:body
    (let [where-expr (meta/slot-expr input :where)]
      (diag/concat
        (if (nil? where-expr)
          []
          (if (meta/expr-assignable-to? input where-expr "Bool")
            []
            [(diag/error
               :slot :where
               :message "query :where must evaluate to Bool")]))
        (meta/validate-query-select-fields input)))))

; Query inference returns the declaration type and delegates expression checking
; to the generic meta bridge. This keeps `:where` off descriptor typed slots.
(meta-fn query/infer
  (:kind infer)
  (:input FormMetaInput)
  (:output Type)
  (:doc "Infers QueryDef while checking :where through meta/check-expr.")
  (:body
    (let [where-expr (meta/slot-expr input :where)]
      (if (nil? where-expr)
        (type/constant "QueryDef")
        (do
          (meta/check-expr input where-expr (type/constant "Bool"))
          (type/constant "QueryDef"))))))

; Record checking validates each field assignment against the referenced entity
; schema through the generic declaration reflection and meta/check-expr bridge.
(meta-fn record/check
  (:kind check)
  (:input FormMetaInput)
  (:output Type)
  (:doc "Checks record field assignments against the referenced entity schema.")
  (:body
    (let [entity-name (meta/identifier input :entity)
          entity-decl (meta/lookup-declaration input entity-name)
          field-forms (meta/child-forms input :field)]
      (do
        (reduce
          (fn [ok field]
            (let [field-name (meta/identifier field :name)
                  field-decl (meta/declaration-field entity-decl field-name)
                  field-type (meta/declaration-type field-decl)
                  value-expr (meta/slot-expr field :type)]
              (if (nil? field-type)
                ok
                (if (nil? value-expr)
                  ok
                  (do
                    (meta/check-expr input value-expr field-type)
                    ok)))))
          true
          field-forms)
        true))))

; Query construction is where surface syntax becomes canonical compiler IR.
; The output object keys must match the generated OntologyIR contract.
(meta-fn query/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output QueryConstruct)
  (:doc "Constructs the query IR payload for elaboration.")
  (:body
    (let [from-name (meta/slot-string input :from)
          from-decl (meta/lookup-declaration input from-name)
          select-fields (meta/query-select-fields input)
          where-field (meta/slot-string input :where)
          where-type (if (nil? where-field)
            nil
            (meta/declaration-type (meta/declaration-field from-decl where-field)))
          select-types (reduce
            (fn [acc field-name]
              (assoc acc field-name
                (meta/declaration-type (meta/declaration-field from-decl field-name))))
            {}
            select-fields)]
      (construct/object
        :kind "Query"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-query"))
        :$summary (construct/summary
          :kind "Query"
          :name (let [n (meta/declaration-name input)] (if n n "anonymous-query"))
          :resultType "List")
        :from from-name
        :from-ref (meta/slot-ref input :from "Entity")
        :select select-fields
        :where (meta/slot-runtime-expr input :where)
        :typeAnnotations (construct/object
          :where where-type
          :select select-types)
        :loc (meta/loc input)))))

(meta-fn datalog-query/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output QueryConstruct)
  (:doc "Constructs canonical query IR for raw Datalog saved query declarations.")
  (:body
    (construct/object
      :kind "Query"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-query"))
      :$summary (construct/summary
        :kind "Query"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-query"))
        :resultType "QueryDef")
      :from "*"
      :datalog (meta/slot-runtime-expr input :query)
      :loc (meta/loc input))))

(meta-fn query-preset/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output QueryPresetIR)
  (:doc "Constructs canonical query preset IR.")
  (:body
    (let [name (meta/declaration-name input)
          query (meta/slot-string input :query)
          params (meta/child-forms input :param)]
      (construct/object
        :kind "QueryPreset"
        :name (if name name "anonymous-query-preset")
        :$summary (construct/summary
          :kind "QueryPreset"
          :name (if name name "anonymous-query-preset")
          :resultType "QueryPresetDef")
        :queryRef (construct/object :kind "Query" :name query)
        :defaults (list/map params
          (fn [param]
            (construct/object
              :name (meta/identifier param :name)
              :value (meta/slot-runtime-expr param :value))))
        :mergePolicy (meta/slot-string input :merge-policy)
        :loc (meta/loc input)))))

(meta-fn role/identity-construct
  (:kind construct)
  (:input FormMetaInput)
  (:output IdentityDeclarationIR)
  (:doc "Constructs canonical role identity IR.")
  (:body
    (construct/object
      :kind "IdentityDeclaration"
      :identityKind "role"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-role"))
      :$summary (construct/summary
        :kind "IdentityDeclaration"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-role"))
        :resultType "IdentityDef")
      :description (meta/slot-string input :description))))

(meta-fn group/identity-construct
  (:kind construct)
  (:input FormMetaInput)
  (:output IdentityDeclarationIR)
  (:doc "Constructs canonical group identity IR.")
  (:body
    (construct/object
      :kind "IdentityDeclaration"
      :identityKind "group"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-group"))
      :$summary (construct/summary
        :kind "IdentityDeclaration"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-group"))
        :resultType "IdentityDef")
      :description (meta/slot-string input :description))))

(meta-fn membership/identity-construct
  (:kind construct)
  (:input FormMetaInput)
  (:output IdentityDeclarationIR)
  (:doc "Constructs canonical membership identity IR.")
  (:body
    (construct/object
      :kind "IdentityDeclaration"
      :identityKind "membership"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-membership"))
      :$summary (construct/summary
        :kind "IdentityDeclaration"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-membership"))
        :resultType "IdentityDef")
      :member (meta/slot-string input :member)
      :group (meta/slot-string input :group)
      :description (meta/slot-string input :description))))

(meta-fn contextual-role/identity-construct
  (:kind construct)
  (:input FormMetaInput)
  (:output IdentityDeclarationIR)
  (:doc "Constructs canonical contextual-role identity IR.")
  (:body
    (construct/object
      :kind "IdentityDeclaration"
      :identityKind "contextual-role"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-contextual-role"))
      :$summary (construct/summary
        :kind "IdentityDeclaration"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-contextual-role"))
        :resultType "IdentityDef")
      :principal (meta/slot-string input :principal)
      :resource (meta/slot-string input :resource)
      :resolver (meta/slot-runtime-expr input :resolver)
      :description (meta/slot-string input :description))))

(meta-fn permission/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output PermissionDeclarationIR)
  (:doc "Constructs canonical permission IR.")
  (:body
    (construct/object
      :kind "PermissionDeclaration"
      :name (let [n (meta/declaration-name input)] (if n n "anonymous-permission"))
      :$summary (construct/summary
        :kind "PermissionDeclaration"
        :name (let [n (meta/declaration-name input)] (if n n "anonymous-permission"))
        :resultType "PermissionDef")
      :principal (meta/slot-string input :principal)
      :action (meta/slot-string input :action)
      :resource (meta/slot-string input :resource)
      :effect (if (meta/slot-string input :effect) (meta/slot-string input :effect) "allow")
      :condition (meta/slot-runtime-expr input :condition)
      :description (meta/slot-string input :description))))

(meta-fn process/validate
  (:kind validate)
  (:input FormMetaInput)
  (:output DiagnosticList)
  (:doc "Validates graph integrity for processes.")
  (:body
    (let [node-ids (meta/child-identifier-set input :node :id)
          trigger-forms (meta/child-forms input :trigger)
          trigger-kind (if (empty? trigger-forms)
                         nil
                         (let [trigger (first trigger-forms)]
                           (meta/identifier trigger :kind)))
          edges (meta/child-forms input :edge)]
      (list/flat-map edges
        (fn [edge]
          (let [from-id (meta/identifier edge :from)
                to-id (meta/identifier edge :to)]
            (diag/concat
              (if (if (set/contains? node-ids from-id)
                    true
                    (if (= from-id "start")
                      true
                      (= from-id trigger-kind)))
                []
                [(diag/error :form edge :message (str "unknown process node '" from-id "'"))])
              (if (set/contains? node-ids to-id)
                []
                [(diag/error :form edge :message (str "unknown process node '" to-id "'"))]))))))))

(meta-fn document-localized/validate
  (:kind validate)
  (:input FormMetaInput)
  (:output DiagnosticList)
  (:doc "Ensures referenced locales exist and defaults are members of the locale list.")
  (:body
    (let [document-name (meta/slot-string input :document)
          declared-locales (meta/document-locale-set input document-name)
          used-locales (meta/slot-string-list input :locales)
          default-locale (meta/slot-string input :default-locale)]
      (diag/concat
        (diag/validate-membership-list used-locales declared-locales :slot :locales)
        (diag/validate-default-in-list default-locale used-locales :slot :default-locale)))))

(meta-fn system-attribute/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output SystemAttributeConstruct)
  (:doc "Constructs system-attribute IR for cross-cutting platform metadata.")
  (:body
    (let [name (meta/declaration-name input)
          doc-str (meta/slot-string input :doc)
          enum-values (meta/slot-value input :enum)]
      (construct/object
        :kind "SystemAttribute"
        :name (if name name "anonymous-system-attribute")
        :$summary (construct/summary
          :kind "SystemAttribute"
          :name (if name name "anonymous-system-attribute")
          :resultType "SystemAttributeDef")
        :doc doc-str
        :valueType (meta/slot-symbol input :value-type)
        :required (meta/slot-value input :required)
        :enum (if (nil? enum-values) nil (if (empty? enum-values) nil enum-values))
        :loc (meta/loc input)))))

(meta-fn entity/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output EntityConstruct)
  (:doc "Constructs entity IR from fields defined in the entity form.")
  (:body
    (let [name (meta/declaration-name input)
          doc-str (meta/slot-string input :doc)
          role (meta/slot-string input :role)
          id-pattern (meta/slot-string input :id-pattern)
          fields (meta/child-forms input :field)
          field-types (reduce
            (fn [acc field]
              (let [field-name (meta/identifier field :name)]
                (if (nil? field-name)
                  acc
                  (assoc acc field-name (meta/slot-symbol field :type)))))
            {}
            fields)]
      (construct/object
        :kind "Entity"
        :name (if name name "anonymous-entity")
        :$summary (construct/summary
          :kind "Entity"
          :name (if name name "anonymous-entity")
          :resultType "SchemaDecl")
        :doc doc-str
        :role role
        :idPattern id-pattern
        :fieldTypes field-types
        :fields (list/map fields
          (fn [field]
            (construct/object
              :name (meta/identifier field :name)
              :type (meta/slot-symbol field :type)
              :required (meta/slot-symbol field :required)
              :unique (meta/slot-symbol field :unique)
              :indexed (meta/slot-symbol field :indexed))))
        :loc (meta/loc input)))))

; Plan A fast-path companion for entity/construct. This descriptor mirrors the
; meta-fn above so OCaml can execute the structural projection without
; interpreting the Lisp body. It deliberately has its own binding name and
; points at (:hook entity/construct), so the Lisp hook remains authoritative for
; TS and for parity checks until we fully commit and delete the meta-fn.
(define-elaboration entity-elaboration
  (:hook entity/construct)
  (:form define-entity)
  (:kind "Entity")
  (:result-type "SchemaDecl")
  (:name name (:identifier name) (:default "anonymous-entity"))
  (:field name (:identifier name))
  (:field doc (:slot-string doc))
  (:field role (:slot-string role))
  (:field idPattern (:slot-string id-pattern))
  (:field fieldTypes (:assignments field (:key name) (:value type)))
  (:field fields
    (:children field
      (:field name (:identifier name))
      (:field type (:slot-symbol type))
      (:field required (:slot-symbol required))
      (:field unique (:slot-symbol unique))
      (:field indexed (:slot-symbol indexed))))
  (:field loc (:loc)))

(meta-fn meta-entity/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output MetaEntityConstruct)
  (:doc "Constructs meta-entity IR for bootstrap schema types.")
  (:body
    (let [name (meta/declaration-name input)
          doc-str (meta/slot-string input :doc)
          role (meta/slot-string input :role)
          id-pattern (meta/slot-string input :id-pattern)
          fields (meta/child-forms input :field)
          field-types (reduce
            (fn [acc field]
              (let [field-name (meta/identifier field :name)]
                (if (nil? field-name)
                  acc
                  (assoc acc field-name (meta/slot-symbol field :type)))))
            {}
            fields)]
      (construct/object
        :kind "MetaEntity"
        :name (if name name "anonymous-meta-entity")
        :$summary (construct/summary
          :kind "MetaEntity"
          :name (if name name "anonymous-meta-entity")
          :resultType "SchemaDecl")
        :doc doc-str
        :role role
        :idPattern id-pattern
        :fieldTypes field-types
        :fields (list/map fields
          (fn [field]
            (construct/object
              :name (meta/identifier field :name)
              :type (meta/slot-symbol field :type)
              :required (meta/slot-symbol field :required)
              :indexed (meta/slot-symbol field :indexed))))
        :loc (meta/loc input)))))

; Descriptor-only action construction. This replaces the former
; action/construct meta-fn body using the shared structural vocabulary plus
; :slot-runtime-expr for the action body.
(define-elaboration action-elaboration
  (:hook action/construct)
  (:form define-action)
  (:kind "Action")
  (:result-type "ActionDef")
  (:name name (:identifier name) (:default "anonymous-action"))
  (:field name (:identifier name))
  (:field doc (:slot-string doc))
  (:field inputs
    (:children input
      (:field name (:identifier name))
      (:field type (:slot-symbol type))
      (:field required (:slot-symbol required))))
  (:field do (:slot-runtime-expr do))
  (:field loc (:loc)))

; Descriptor-only mutation construction. This intentionally mirrors
; action-elaboration so state-changing operations use the same structural
; descriptor path as external action declarations.
(define-elaboration mutation-elaboration
  (:hook mutation/construct)
  (:form define-mutation)
  (:kind "Mutation")
  (:result-type "MutationDef")
  (:name name (:identifier name) (:default "anonymous-mutation"))
  (:field name (:identifier name))
  (:field doc (:slot-string doc))
  (:field inputs
    (:children input
      (:field name (:identifier name))
      (:field type (:slot-symbol type))
      (:field required (:slot-symbol required))))
  (:field do (:slot-runtime-expr do))
  (:field loc (:loc)))

(meta-fn view/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output ViewConstruct)
  (:doc "Constructs view IR from query and column definitions.")
  (:body
    (let [name (meta/declaration-name input)
          description (meta/slot-string input :description)
          query-ref (meta/slot-string input :query)
          column-forms (meta/child-forms input :column)
          column-values (meta/slot-string-list input :column)
          default-sort-values (meta/slot-string-list input :default-sort)
          default-sort (if (empty? default-sort-values)
            nil
            (let [field-name (first default-sort-values)
                  direction-name (nth default-sort-values 1)]
              (construct/object
                :field field-name
                :direction (if (= direction-name ":desc") "desc" "asc"))))
          row-action (meta/slot-expr input :row-action)
          ;; Extended ViewSpec: state declarations
          state-forms (meta/child-forms input :state)
          state-map (if (empty? state-forms) nil
            (into (list/map state-forms
              (fn [sf]
                (let [state-kind (if (meta/slot-string sf :type)
                                   (meta/slot-string sf :type)
                                   "null")
                      state-initial (meta/slot-value sf :initial)]
                  [(meta/identifier sf :name)
                 (construct/object
                   :kind state-kind
                   :type state-kind
                   :initial state-initial)])))))
          ;; Extended ViewSpec: input parameter declarations
          input-param-forms (meta/child-forms input :input-param)
          input-map (if (empty? input-param-forms) nil
            (into (list/map input-param-forms
              (fn [inf]
                [(meta/identifier inf :name)
                 (construct/object
                   :type (meta/slot-string inf :type)
                   :description (meta/slot-string inf :description))]))))
          ;; Extended ViewSpec: named query bindings
          nq-forms (meta/child-forms input :named-query)
          queries-map (if (empty? nq-forms) nil
            (into (list/map nq-forms
              (fn [nq]
                (let [params (view/compile-expr-record (meta/slot-expr nq :params))]
                  [(meta/identifier nq :name)
                   (construct/object
                     :ref (meta/slot-string nq :ref)
                     :queryRef (meta/slot-string nq :ref)
                     :params params
                     :dependsOn (meta/slot-string-list nq :depends-on))])))))
          ;; ViewSpec reusable component defs
          def-forms (meta/child-forms input :def)
          defs-map (if (empty? def-forms) nil
            (into (list/map def-forms
              (fn [df]
                [(meta/identifier df :name)
                 (meta/compile-descriptor-tree "viewspec"
                   (meta/slot-expr df :layout))]))))
          ;; Extended ViewSpec: layout tree
          layout-expr (meta/slot-expr input :layout)
          layout-tree (if (nil? layout-expr) nil
            (meta/compile-descriptor-tree "viewspec"
              layout-expr))
          root-tree (if (nil? layout-tree)
            nil
            (if (nil? defs-map)
              layout-tree
              (construct/assoc layout-tree :defs defs-map)))]
      (construct/object
        :kind "View"
        :name (if name name "anonymous-view")
        :$summary (construct/summary
          :kind "View"
          :name (if name name "anonymous-view")
          :resultType "ViewDef")
        "$viewSpec" (construct/object :version "2")
        :doc description
        :query query-ref
        :title (meta/slot-string input :title)
        :subject (meta/slot-string input :subject)
        :mode (meta/slot-string input :mode)
        :emptyState (meta/slot-string input :empty-state)
        :where (meta/slot-runtime-expr input :where)
        :defaultSort default-sort
        :rowAction row-action
        :columns (if (empty? column-forms)
          (list/map column-values
            (fn [col-name]
              (construct/object :name col-name)))
          (list/map column-forms
            (fn [col]
              (construct/object
                :name (meta/identifier col :name)
                :label (meta/slot-string col :label)
                :expr (meta/slot-runtime-expr col :expr)))))
        :state state-map
        :input input-map
        :queries queries-map
        :defs defs-map
        :root root-tree
        :layout root-tree
        :loc (meta/loc input)))))

; Descriptor-only constraint construction. This replaces the former
; constraint/construct meta-fn body and introduces reusable :default, :first,
; and :ref source combinators for alias/default/reference-companion patterns.
(define-elaboration constraint-elaboration
  (:hook constraint/construct)
  (:form define-constraint)
  (:kind "Constraint")
  (:result-type "ConstraintDef")
  (:name name (:identifier name) (:default "anonymous-constraint"))
  (:field name (:identifier name))
  (:field doc (:slot-string doc))
  (:field entity (:slot-string entity))
  (:field severity (:default (:slot-symbol severity) "error"))
  (:field when (:slot-runtime-expr violation-query))
  (:field message (:slot-runtime-expr message))
  (:field taskAssignments
    (:children assigns-task-to
      (:field role (:identifier role))
      (:field priority (:slot-string priority))
      (:field title (:slot-runtime-expr title))
      (:field body (:slot-runtime-expr body))))
  (:field resolutions
    (:children resolution
      (:field action (:first (:slot-string action) (:slot-string mutation)))
      (:field actionRef (:ref "Action" (:first (:slot-string action) (:slot-string mutation))))
      (:field mutation (:first (:slot-string action) (:slot-string mutation)))
      (:field mutationRef (:ref "Action" (:first (:slot-string action) (:slot-string mutation))))
      (:field label (:slot-string label))
      (:field autoInvoke (:slot-string auto))
      (:field auto (:slot-string auto))))
  (:field loc (:loc)))

; =============================================================================
; REMAINING CONSTRUCT HOOKS
; =============================================================================

; First descriptor-only construct migration. This replaces the former
; relation/construct meta-fn body; both engines now interpret the structural
; projection directly from this descriptor. The former body constructed exactly
; the fields listed below, so no imperative Lisp fallback remains.
(define-elaboration relation-elaboration
  (:hook relation/construct)
  (:form define-relation)
  (:kind "Relation")
  (:result-type "RelationDef")
  (:name name (:identifier name) (:default "anonymous-relation"))
  (:field name (:identifier name))
  (:field source (:identifier source))
  (:field target (:identifier target))
  (:field fields
    (:children field
      (:field name (:identifier name))
      (:field type (:slot-symbol type))
      (:field required (:slot-symbol required))
      (:field unique (:slot-symbol unique))
      (:field indexed (:slot-symbol indexed)))))

(meta-fn record/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output RecordIR)
  (:doc "Constructs record/seed data IR with field assignments.")
  (:body
    (let [id (meta/identifier input :id)
          entity (meta/identifier input :entity)
          field-forms (meta/child-forms input :field)
          fields (reduce
            (fn [acc f]
              (let [name (meta/identifier f :name)
                    value (meta/slot-string f :type)]
                (if (nil? name) acc
                  (assoc acc (str name) (if value value "")))))
            {}
            field-forms)]
      (construct/object
        :kind "Record"
        :id (if id id "anonymous-record")
        :$summary (construct/summary
          :kind "Record"
          :name (if id id "anonymous-record")
          :resultType "RecordDef")
        :entity entity
        :fields fields))))

; Plan A fast-path companion for record/construct. This replaces the previous
; hard-coded OCaml record fast path with descriptor-authored metadata while the
; meta-fn above remains the source of truth. Once OCaml is the only consumer and
; the parity gate has covered the migration, this comment and the meta-fn body
; are the cleanup target.
(define-elaboration record-elaboration
  (:hook record/construct)
  (:form define-record)
  (:kind "Record")
  (:result-type "RecordDef")
  (:name id (:identifier id) (:default "anonymous-record"))
  (:field id (:identifier id))
  (:field entity (:identifier entity))
  (:field fields (:assignments field (:key name) (:value type) (:default ""))))

; Descriptor-only link construction. This replaces the former link/construct
; meta-fn body and introduces :format for summary names that are derived from
; multiple identifiers.
(define-elaboration link-elaboration
  (:hook link/construct)
  (:form define-link)
  (:kind "Link")
  (:result-type "LinkDef")
  (:name summary (:format (:identifier relation) ":" (:identifier source) "->" (:identifier target)))
  (:field relation (:identifier relation))
  (:field source (:identifier source))
  (:field target (:identifier target))
  (:field sourceId (:identifier source))
  (:field targetId (:identifier target))
  (:field fields
    (:children field
      (:field name (:identifier name))
      (:field value (:slot-expr type)))))

; Descriptor-only workspace construction. This replaces the former
; workspace/construct meta-fn body using :slot-string-list for repeated view
; references.
(define-elaboration workspace-elaboration
  (:hook workspace/construct)
  (:form define-workspace)
  (:kind "Workspace")
  (:result-type "WorkspaceDef")
  (:name name (:identifier name) (:default "anonymous-workspace"))
  (:field name (:identifier name))
  (:field title (:slot-string title))
  (:field persona (:slot-string persona))
  (:field subject (:slot-string subject))
  (:field home (:slot-string home))
  (:field views (:slot-string-list view)))

(meta-fn resolution/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output ResolutionIR)
  (:doc "Constructs constraint resolution path IR.")
  (:body
    (let [label (meta/slot-string input :label)
          action (if (meta/slot-string input :action)
                   (meta/slot-string input :action)
                   (meta/slot-string input :mutation))
          auto (meta/slot-string input :auto)]
      (construct/object
        :kind "Resolution"
        :label label
        :action action
        :actionRef (if action
                     (construct/object :kind "Action" :name action)
                     nil)
        :mutation action
        :mutationRef (if action
                       (construct/object :kind "Action" :name action)
                       nil)
        :autoInvoke auto
        :auto auto))))

(meta-fn trigger/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output TriggerIR)
  (:doc "Constructs process trigger IR.")
  (:body
    (let [kind (meta/identifier input :kind)
          entity (meta/identifier input :entity)]
      (construct/object
        :kind "Trigger"
        :triggerKind kind
        :entity entity))))

(meta-fn node/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output NodeIR)
  (:doc "Constructs process node IR.")
  (:body
    (let [id (meta/identifier input :id)
          action (meta/slot-string input :action)
          mutation (meta/slot-string input :mutation)
          join (meta/slot-string input :join)
          fan-out (meta/slot-string input :fan-out)
          inputs (meta/child-forms input :input)]
      (construct/object
        :kind "Node"
        :id id
        :action action
        :actionRef (meta/slot-ref input :action "Action")
        :mutation mutation
        :mutationRef (meta/slot-ref input :mutation "Mutation")
        :join join
        :fanOut fan-out
        :inputs (list/map inputs
          (fn [inp]
            (construct/object
              :name (meta/identifier inp :name)
              :expr (meta/slot-runtime-expr inp :type))))))))

(meta-fn guard/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output GuardIR)
  (:doc "Constructs process edge guard IR.")
  (:body
    (let [kind (meta/identifier input :kind)
          value (meta/positional-arg input 1)]
      (construct/object
        :kind "Guard"
        :guardKind kind
        :expr (construct/object :kind "raw-expr" :expr value)))))

(meta-fn edge/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output EdgeIR)
  (:doc "Constructs process edge IR.")
  (:body
    (let [from (meta/identifier input :from)
          to (meta/identifier input :to)
          guards (meta/child-forms input :guard)]
      (construct/object
        :kind "Edge"
        :from from
        :to to
        :guard (if (empty? guards) nil (first guards))))))

; Descriptor-only process construction. This replaces the former
; process/construct meta-fn body and introduces :child/:positional so first
; child wrappers and guard expressions can stay structural.
(define-elaboration process-elaboration
  (:hook process/construct)
  (:form define-process)
  (:kind "Process")
  (:result-type "ProcessDef")
  (:name name (:identifier name) (:default "anonymous-process"))
  (:field name (:identifier name))
  (:field description (:slot-string description))
  (:field trigger
    (:child trigger
      (:field kind (:literal "Trigger"))
      (:field triggerKind (:identifier kind))
      (:field entity (:identifier entity))))
  (:field nodes
    (:children node
      (:field kind (:literal "Node"))
      (:field id (:identifier id))
      (:field action (:slot-string action))
      (:field actionRef (:ref "Action" (:slot-string action)))
      (:field mutation (:slot-string mutation))
      (:field mutationRef (:ref "Mutation" (:slot-string mutation)))
      (:field join (:slot-string join))
      (:field fanOut (:slot-string fan-out))
      (:field inputs
        (:children input
          (:field name (:identifier name))
          (:field expr (:slot-runtime-expr type))))))
  (:field edges
    (:children edge
      (:field kind (:literal "Edge"))
      (:field from (:identifier from))
      (:field to (:identifier to))
      (:field guard
        (:child guard
          (:field kind (:literal "Guard"))
          (:field guardKind (:identifier kind))
          (:field expr
            (:object
              (:field kind (:literal "raw-expr"))
              (:field expr (:positional 1)))))))))

; Descriptor-only task definition construction. This replaces the former
; task-definition/construct meta-fn body and introduces :object/:when so
; optional nested companions can be declared without imperative Lisp glue.
(define-elaboration task-definition-elaboration
  (:hook task-definition/construct)
  (:form define-task)
  (:kind "TaskDefinition")
  (:result-type "TaskDefinitionDef")
  (:name name (:identifier name) (:default "anonymous-task-definition"))
  (:field name (:identifier name))
  (:field title (:first (:slot-string title) (:identifier name) (:literal "Untitled task")))
  (:field description (:slot-string description))
  (:field documentRef (:ref "Document" (:slot-string document)))
  (:field sectionRefs (:slot-string-list section))
  (:field defaultAssignee
    (:when (:slot-string assignee)
      (:object
        (:field _tag (:literal "role"))
        (:field role (:slot-string assignee))
        (:field strategy (:literal "queue")))))
  (:field guidanceRef (:slot-string guidance))
  (:field inputs
    (:children input
      (:field name (:identifier name))
      (:field type (:slot-runtime-expr type))
      (:field required (:slot-string required))))
  (:field scope
    (:when (:slot-string scope)
      (:object
        (:field entityType (:slot-string scope))))))

(meta-fn document/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output DocumentIR)
  (:doc "Constructs document IR with nested pages and fields.")
  (:body
    (let [name (meta/declaration-name input)
          description (meta/slot-string input :description)
          pages (meta/child-forms input :page)]
      (construct/object
        :kind "Document"
        :name (if name name "anonymous-document")
        :$summary (construct/summary
          :kind "Document"
          :name (if name name "anonymous-document")
          :resultType "DocumentDef")
        :description description
        :pages (list/map pages
          (fn [page]
            (let [completion (first (meta/child-forms page :completion-mutation))]
              (construct/object
                :kind "Page"
                :sectionId (meta/slot-string page :section-id)
                :assignee (meta/slot-string page :assignee)
                :description (meta/slot-string page :description)
                :dependsOn (meta/slot-string-list page :depends-on)
                :completion (if (nil? completion)
                  nil
                  (let [action-name (meta/identifier completion :mutation)
                        entity-name (meta/identifier completion :entity)]
                    (construct/object
                      :kind "CompletionMutation"
                      :mutation action-name
                      :mutationRef (if action-name
                        (construct/object :kind "Action" :name action-name)
                        nil)
                      :entity entity-name
                      :entityRef (if entity-name
                        (construct/object :kind "Entity" :name entity-name)
                        nil))))
                :fields (list/map (meta/child-forms page :field)
                  (fn [f]
                    (let [binding-values (meta/slot-string-list f :bind)
                          transform-a (if (= (nth binding-values 1) ":transform") (nth binding-values 2) nil)
                          transform-b (if (= (nth binding-values 3) ":transform") (nth binding-values 4) nil)
                          transform-c (if (= (nth binding-values 5) ":transform") (nth binding-values 6) nil)
                          entity-a (if (= (nth binding-values 1) ":entity") (nth binding-values 2) nil)
                          entity-b (if (= (nth binding-values 3) ":entity") (nth binding-values 4) nil)
                          entity-c (if (= (nth binding-values 5) ":entity") (nth binding-values 6) nil)
                          cardinality-a (if (= (nth binding-values 1) ":cardinality") (nth binding-values 2) nil)
                          cardinality-b (if (= (nth binding-values 3) ":cardinality") (nth binding-values 4) nil)
                          cardinality-c (if (= (nth binding-values 5) ":cardinality") (nth binding-values 6) nil)
                          binding (if (empty? binding-values)
                            nil
                            (construct/object
                              :kind "AttributeBinding"
                              :attribute (first binding-values)
                              :transform (if transform-a transform-a (if transform-b transform-b transform-c))
                              :entity (if entity-a entity-a (if entity-b entity-b entity-c))
                              :cardinality (if cardinality-a cardinality-a (if cardinality-b cardinality-b cardinality-c))))]
                      (construct/object
                        :kind "Field"
                        :type (meta/identifier f :type)
                        :path (meta/identifier f :path)
                        :label (meta/slot-string f :label)
                        :description (meta/slot-string f :description)
                        :content (meta/slot-string f :content)
                        :required (meta/slot-string f :required)
                        :binding binding
                        :options (list/map (meta/child-forms f :option)
                          (fn [opt]
                            (construct/object
                              :kind "Option"
                              :value (meta/identifier opt :value)
                              :label (meta/identifier opt :label))))))))))))))))

(define-elaboration-primitive attribute-binding
  (:input StringList)
  (:output AttributeBinding)
  (:doc "Decodes a flat :bind slot into canonical AttributeBinding IR."))

; Plan A document construction. This keeps the Lisp body above as the parity
; fallback while proving that the non-structural :bind decoder can be named as
; a primitive instead of duplicated inside document/construct and
; field/construct.
(define-elaboration document-elaboration
  (:hook document/construct)
  (:form define-document)
  (:kind "Document")
  (:result-type "DocumentDef")
  (:name name (:identifier name) (:default "anonymous-document"))
  (:field name (:default (:identifier name) "anonymous-document"))
  (:field description (:slot-string description))
  (:field pages
    (:children page
      (:field kind (:literal "Page"))
      (:field sectionId (:slot-string section-id))
      (:field assignee (:slot-string assignee))
      (:field description (:slot-string description))
      (:field dependsOn (:slot-string-list depends-on))
      (:field completion
        (:child completion-mutation
          (:field kind (:literal "CompletionMutation"))
          (:field mutation (:identifier mutation))
          (:field mutationRef (:ref "Action" (:identifier mutation)))
          (:field entity (:identifier entity))
          (:field entityRef (:ref "Entity" (:identifier entity)))))
      (:field fields
        (:children field
          (:field kind (:literal "Field"))
          (:field type (:identifier type))
          (:field path (:identifier path))
          (:field label (:slot-string label))
          (:field description (:slot-string description))
          (:field content (:slot-string content))
          (:field required (:slot-string required))
          (:field binding (:primitive attribute-binding (:slot-string-list bind)))
          (:field options
            (:children option
              (:field kind (:literal "Option"))
              (:field value (:identifier value))
              (:field label (:identifier label)))))))))

(meta-fn page/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output PageIR)
  (:doc "Constructs document page IR.")
  (:body
    (let [section-id (meta/slot-string input :section-id)
          assignee (meta/slot-string input :assignee)
          description (meta/slot-string input :description)]
      (construct/object
        :kind "Page"
        :sectionId section-id
        :assignee assignee
        :description description))))

(meta-fn field/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output FieldIR)
  (:doc "Constructs document field IR.")
  (:body
    (let [type (meta/identifier input :type)
          path (meta/identifier input :path)
          label (meta/slot-string input :label)
          required (meta/slot-string input :required)
          binding-values (meta/slot-string-list input :bind)
          transform-a (if (= (nth binding-values 1) ":transform") (nth binding-values 2) nil)
          transform-b (if (= (nth binding-values 3) ":transform") (nth binding-values 4) nil)
          transform-c (if (= (nth binding-values 5) ":transform") (nth binding-values 6) nil)
          entity-a (if (= (nth binding-values 1) ":entity") (nth binding-values 2) nil)
          entity-b (if (= (nth binding-values 3) ":entity") (nth binding-values 4) nil)
          entity-c (if (= (nth binding-values 5) ":entity") (nth binding-values 6) nil)
          cardinality-a (if (= (nth binding-values 1) ":cardinality") (nth binding-values 2) nil)
          cardinality-b (if (= (nth binding-values 3) ":cardinality") (nth binding-values 4) nil)
          cardinality-c (if (= (nth binding-values 5) ":cardinality") (nth binding-values 6) nil)
          binding (if (empty? binding-values)
            nil
            (construct/object
              :kind "AttributeBinding"
              :attribute (first binding-values)
              :transform (if transform-a transform-a (if transform-b transform-b transform-c))
              :entity (if entity-a entity-a (if entity-b entity-b entity-c))
              :cardinality (if cardinality-a cardinality-a (if cardinality-b cardinality-b cardinality-c))))]
      (construct/object
        :kind "Field"
        :type type
        :path path
        :label label
        :required required
        :binding binding))))

(meta-fn completion-mutation/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output CompletionMutationIR)
  (:doc "Constructs document completion mutation IR.")
  (:body
    (let [mutation (meta/identifier input :mutation)
          entity (meta/identifier input :entity)]
      (construct/object
        :kind "CompletionMutation"
        :mutation mutation
        :mutationRef (if mutation
                       (construct/object :kind "Action" :name mutation)
                       nil)
        :entity entity
        :entityRef (if entity
                     (construct/object :kind "Entity" :name entity)
                     nil)))))

(meta-fn option/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output OptionIR)
  (:doc "Constructs select option IR.")
  (:body
    (let [value (meta/identifier input :value)
          label (meta/identifier input :label)]
      (construct/object
        :kind "Option"
        :value value
        :label label))))

; Descriptor-only document-locale construction. The nested role, section,
; locale-field, and option shapes are sub-IR projections owned by this parent
; descriptor; author-side reuse should happen at expansion time with macros.
(define-elaboration document-locale-elaboration
  (:hook document-locale/construct)
  (:form define-document-locale)
  (:kind "DocumentLocale")
  (:result-type "DocumentLocaleDef")
  (:field documentName (:slot-string document))
  (:field documentRef (:ref "Document" (:slot-string document)))
  (:field locale (:slot-string locale))
  (:field roles
    (:children role
      (:field kind (:literal "Role"))
      (:field name (:identifier name))
      (:field label (:slot-string label))
      (:field description (:slot-string description))))
  (:field sections
    (:children section
      (:field kind (:literal "Section"))
      (:field name (:identifier name))
      (:field label (:slot-string label))
      (:field description (:slot-string description))))
  (:field fields
    (:children field
      (:field kind (:literal "LocaleField"))
      ; :field wraps a locale-field form, so the locale field path is the
      ; wrapped form's first positional argument rather than the wrapper name.
      (:field path (:positional 0))
      (:field label (:slot-string label))
      (:field description (:slot-string description))
      (:field options
        (:children option
          (:field kind (:literal "Option"))
          (:field value (:identifier value))
          (:field label (:identifier label)))))))

; Descriptor-only document-localized construction. This replaces the former
; document-localized/construct meta-fn body and proves descriptor summaries
; that intentionally omit a name.
(define-elaboration document-localized-elaboration
  (:hook document-localized/construct)
  (:form define-document-localized)
  (:kind "DocumentLocalized")
  (:result-type "DocumentLocalizedDef")
  (:field documentName (:slot-string document))
  (:field documentRef (:ref "Document" (:slot-string document)))
  (:field locales (:slot-string-list locales))
  (:field defaultLocale (:slot-string default-locale)))

(meta-fn pdf-mapping/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output PdfMappingIR)
  (:doc "Constructs PDF mapping IR with nested field mappings.")
  (:body
    (let [name (meta/declaration-name input)
          display-name (meta/slot-string input :display-name)
          description (meta/slot-string input :description)
          template-blob (meta/slot-string input :template-blob)
          template-file (meta/slot-string input :template-file)
          template-filename (meta/slot-string input :template-filename)
          document-name (meta/slot-string input :document-ref)
          document-ref (meta/slot-ref input :document-ref "Document")
          directs (list/map (meta/child-forms input :direct)
            (fn [d]
              (construct/object
                :kind "Direct"
                :source (meta/identifier d :source)
                :pdfField (meta/identifier d :pdf-field)
                :transform (meta/slot-string d :transform))))
          computeds (list/map (meta/child-forms input :computed)
            (fn [c]
              (construct/object
                :kind "Computed"
                :expr (construct/object
                        :kind "raw-expr"
                        :expr (meta/positional-arg c 0))
                :pdfField (meta/identifier c :pdf-field)
                :transform (meta/slot-string c :transform))))
          switches (list/map (meta/child-forms input :switch)
            (fn [s]
              (construct/object
                :kind "Switch"
                :source (meta/identifier s :source)
                :cases (list/map (meta/child-forms s :case)
                  (fn [case-val]
                    (construct/object
                      :kind "Case"
                      :when (meta/identifier case-val :when)
                      :assignments (list/map (meta/child-forms case-val :set)
                        (fn [assignment]
                          (construct/object
                            :kind "Set"
                            :pdfField (meta/identifier assignment :pdf-field)
                            :value (meta/positional-scalar assignment 1))))))))))]
      (construct/object
        :kind "PdfMapping"
        :name (if name name "anonymous-pdf-mapping")
        :$summary (construct/summary
          :kind "PdfMapping"
          :name (if name name "anonymous-pdf-mapping")
          :resultType "PdfMappingDef")
        :displayName display-name
        :description description
        :templateBlob template-blob
        :templateFile template-file
        :templateFilename template-filename
        :documentName document-name
        :documentRef document-ref
        :mappings (concat directs computeds switches)))))

(meta-fn direct/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output DirectIR)
  (:doc "Constructs direct PDF mapping IR.")
  (:body
    (let [source (meta/slot-string input :source)
          pdf-field (meta/slot-string input :pdf-field)
          transform (meta/slot-string input :transform)]
      (construct/object
        :kind "Direct"
        :source source
        :pdfField pdf-field
        :transform transform))))

(meta-fn computed/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output ComputedIR)
  (:doc "Constructs computed PDF mapping IR.")
  (:body
    (let [expression (meta/positional-arg input 0)
          pdf-field (meta/slot-string input :pdf-field)
          transform (meta/slot-string input :transform)]
      (construct/object
        :kind "Computed"
        :expr (construct/object :kind "raw-expr" :expr expression)
        :pdfField pdf-field
        :transform transform))))

(meta-fn switch/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output SwitchIR)
  (:doc "Constructs switch PDF mapping IR.")
  (:body
    (let [source (meta/identifier input :source)
          cases (meta/child-forms input :case)]
      (construct/object
        :kind "Switch"
        :source source
        :cases cases))))

(meta-fn case/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output CaseIR)
  (:doc "Constructs switch case IR.")
  (:body
    (let [when-val (meta/identifier input :when)
          assignments (meta/child-forms input :set)]
      (construct/object
        :kind "Case"
        :when when-val
        :assignments assignments))))

(meta-fn set/construct
  (:kind construct)
  (:input FormMetaInput)
  (:output SetIR)
  (:doc "Constructs PDF field assignment IR.")
  (:body
    (let [pdf-field (meta/identifier input :pdf-field)
          value (meta/identifier input :value)]
      (construct/object
        :kind "Set"
        :pdfField pdf-field
        :value value))))
