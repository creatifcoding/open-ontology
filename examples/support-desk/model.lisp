(define-entity Customer
  (:doc "An organisation that raises tickets.")
  (:field [customer/name String {:required true}]))

(define-entity Engineer
  (:field [engineer/name String {:required true}]))

(define-entity Ticket
  (:field [ticket/title String {:required true}])
  (:field [ticket/customer Customer {:required true}])
  (:field [ticket/status (Enum open escalated closed) {:required true}])
  (:field [ticket/priority Int {:required true}])
  (:field [ticket/opened-at Instant {:required true}]))

(define-relation escalated-to Ticket Engineer
  (:field [escalated-to/reason String {:required true}])
  (:field [escalated-to/at Instant {:required true}]))

(define-action open-ticket
  (:input [ticket String {:required true}])
  (:input [customer String {:required true}])
  (:input [title String {:required true}])
  (:input [priority Int {:required true}])
  (:returns String)
  (:do (create Ticket ticket
         {:ticket/title title
          :ticket/customer customer
          :ticket/status "open"
          :ticket/priority priority
          :ticket/opened-at now})))

(define-action escalate-ticket
  (:input [ticket String {:required true}])
  (:input [engineer String {:required true}])
  (:input [reason String {:required true}])
  (:returns String)
  (:do (changes
    (clear ticket :ticket/status)
    (set ticket :ticket/status "escalated")
    (link escalated-to ticket engineer
      {:escalated-to/reason reason :escalated-to/at now}))))

(define-action close-ticket
  (:input [ticket String {:required true}])
  (:returns String)
  (:do (changes
    (clear ticket :ticket/status)
    (set ticket :ticket/status "closed"))))

(define-datalog-query open-work
  (:query
    {:find ["?title" "?customer" "?priority"]
     :where [["?t" ":ticket/title" "?title"]
             ["?t" ":ticket/priority" "?priority"]
             ["?t" ":ticket/customer" "?c"]
             ["?c" ":customer/name" "?customer"]
             ["not" ["?t" ":ticket/status" "closed"]]]
     :orderBy [{:variable "?priority" :direction "desc"}]}))

(define-datalog-query escalations
  (:query
    {:find ["?title" "?engineer" "?reason"]
     :where [["?e" ":escalated-to/from" "?t"]
             ["?e" ":escalated-to/to" "?who"]
             ["?e" ":escalated-to/reason" "?reason"]
             ["?t" ":ticket/title" "?title"]
             ["?who" ":engineer/name" "?engineer"]]}))

(define-datalog-query tickets-by-status
  (:query
    {:find ["?status" "?count"]
     :where [["?t" ":ticket/status" "?status"]]
     :aggregate [["count" "?t" "?count"]]}))
