const http = require("node:http");
const { buildReportFromConnection, listCases, openStore } = require("./evidence-graph.cjs");

const CONSTRUCTION_CASES = Object.freeze([
  { caseId: "case-construction-before", claimId: "claim-construction-recess-before" },
  { caseId: "case-construction-after", claimId: "claim-construction-recess-after" }
]);

const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

const STATUS_LABELS = Object.freeze({
  de: Object.freeze({
    SATISFIED_BY_MATCHING_CURRENT_EVIDENCE: "Gestützt – passender aktueller Beleg",
    NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE: "Widersprochen – passender aktueller Gegenbeleg",
    UNKNOWN_NOT_PROVEN: "Unbekannt – nicht belegt",
    CONFLICTING_MATCHING_CURRENT_EVIDENCE: "Konflikt – aktuelle Belege widersprechen sich"
  }),
  en: Object.freeze({
    SATISFIED_BY_MATCHING_CURRENT_EVIDENCE: "Supported by matching current evidence",
    NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE: "Contradicted by matching current evidence",
    UNKNOWN_NOT_PROVEN: "Unknown – not proven",
    CONFLICTING_MATCHING_CURRENT_EVIDENCE: "Conflict – current evidence disagrees"
  })
});

const CLAIM_LABELS = Object.freeze({
  de: Object.freeze({
    "claim-repair-cost": "Die Reparatur kostet höchstens 400 Euro",
    "claim-buy-budget": "Der Ersatzlaptop kostet insgesamt höchstens 1.000 Euro",
    "claim-os-support": "Der reparierte Laptop erhält aktuelle Betriebssystem-Unterstützung",
    "claim-warranty": "Die Reparatur ermöglicht zwölf Monate zuverlässige Nutzung",
    "claim-construction-flat-before": "Das Regeldetail für den ebenen Sohlbereich ist dokumentiert",
    "claim-construction-flat-after": "Das Regeldetail für den ebenen Sohlbereich ist dokumentiert",
    "claim-construction-recess-before": "Das Auflagedetail für die Vertiefung ist in Revision B dokumentiert",
    "claim-construction-recess-after": "Das Auflagedetail für die Vertiefung ist in Revision B dokumentiert",
    "claim-construction-register-before": "Die Planungsrückfrage ist laut Prüfregister erledigt",
    "claim-construction-register-after": "Die Planungsrückfrage ist laut Prüfregister erledigt",
    "claim-existing-extension": "Ein bestehendes Projekt darf erweitert und eingereicht werden",
    "claim-video-only": "Eine vollständige Einreichung erfordert zwingend ein ein- bis zweiminütiges Demo-Video",
    "claim-cash-substitution": "Ein Gewinner darf den Hardwarepreis durch Bargeld ersetzen",
    "claim-ai-disclosure": "KI-Werkzeuge sind erlaubt, wenn wesentliche Nutzung offengelegt wird",
    "claim-public-repo-topic": "Der Beitrag benötigt ein öffentliches GitHub-Repository mit dem Thema relate",
    "claim-brand-only-privacy": "Während Teilnahme und Bewertung kann überall ausschließlich ein Markenname genutzt werden"
  }),
  en: Object.freeze({
    "claim-repair-cost": "The repair costs no more than EUR 400",
    "claim-buy-budget": "The total cost of the replacement is at most EUR 1,000",
    "claim-os-support": "The repaired laptop receives current OS support",
    "claim-warranty": "The repair provides twelve months of reliable use",
    "claim-existing-extension": "An existing project may be extended and submitted",
    "claim-video-only": "A complete submission requires a one-to-two-minute demo video",
    "claim-cash-substitution": "A winner may replace the hardware prize with cash",
    "claim-ai-disclosure": "AI tools are allowed when significant use is disclosed",
    "claim-public-repo-topic": "The entry needs a public GitHub repository tagged relate",
    "claim-brand-only-privacy": "A participant can use only a brand name everywhere during entry and judging"
  })
});

const OPTION_LABELS = Object.freeze({
  de: Object.freeze({
    repair: "Bestehenden Laptop reparieren",
    buy: "Ersatzlaptop kaufen",
    wait: "Drei Monate warten",
    "flat-slab": "Ebener Sohlbereich",
    recess: "Vertiefung",
    clarify: "Offene Planungsfrage zur Klärung geben",
    "overview-reading": "Auf den Wortlaut der Übersicht vertrauen",
    "rules-minimum": "Strengere kombinierte Anforderungen verwenden",
    "strict-combination": "Strengere kombinierte Anforderungen verwenden",
    "hold-clarification": "Anhalten und Klärung erfragen"
  }),
  en: Object.freeze({
    repair: "Repair the current laptop",
    buy: "Buy a replacement laptop",
    wait: "Wait three months",
    "overview-reading": "Rely on the overview wording",
    "rules-minimum": "Use the stricter combined requirements",
    "strict-combination": "Use the stricter combined requirements",
    "hold-clarification": "Hold and request clarification"
  })
});

const CASE_LABELS = Object.freeze({
  de: Object.freeze({
    "case-laptop": "Synthetischer Laptop-Fall",
    "case-relate-rules": "Öffentlicher Relate-Regelfall",
    "case-construction-before": "Baustellenbeispiel A · Beleg fehlt",
    "case-construction-after": "Baustellenbeispiel B · Beleg liegt vor"
  }),
  en: Object.freeze({
    "case-laptop": "Synthetic laptop case",
    "case-relate-rules": "Public Relate rules case",
    "case-construction-before": "Construction A · record missing",
    "case-construction-after": "Construction B · record added"
  })
});

const PASSAGE_EXPLANATIONS_DE = Object.freeze({
  "passage-repair-cost": "Ersatzteile und Arbeit kosten zusammen 360 Euro.",
  "passage-buy-price": "Der Angebotspreis beträgt einschließlich Lieferung 899 Euro. Einrichtung und Zubehör sind in diesem Beleg nicht erfasst.",
  "passage-buy-total": "Einrichtung und notwendiges Zubehör erhöhen die erwarteten Gesamtkosten auf 1.120 Euro.",
  "passage-os-new": "Das Ersatzmodell erhält aktuelle Betriebssystem-Unterstützung.",
  "passage-os-old": "Nur die alte Version v0 wird laut diesem veralteten Beleg bis Dezember 2028 unterstützt.",
  "passage-warranty": "Die Teilegarantie gilt für 90 Tage. Der Text macht keine Aussage über die tatsächliche Nutzungsdauer.",
  "passage-overview-extension": "Die Übersicht heißt sowohl neue Projekte als auch Erweiterungen bestehender Projekte willkommen.",
  "passage-rules-new-project": "Die offiziellen Regeln verlangen einen im Wettbewerbszeitraum begonnenen Beitrag; älterer Code darf nur offengelegt wiederverwendet werden.",
  "passage-overview-video": "Die Checkliste der Übersicht verlangt ein ein- bis zweiminütiges Demo-Video.",
  "passage-rules-demo-choice": "Die offiziellen Regeln akzeptieren entweder ein Video bis zwei Minuten oder einen Link zu einer funktionierenden Demo.",
  "passage-rules-no-cash": "Die Preise sind Hardware und können nicht gegen Bargeld getauscht werden.",
  "passage-rules-ai": "KI-Werkzeuge sind erlaubt; wesentliche KI-Nutzung muss im Beitrag beschrieben werden.",
  "passage-rules-public-repo": "Das Repository muss öffentlich sein, das Thema relate tragen und bis zur Gewinnerbekanntgabe öffentlich bleiben."
});

const EXCLUSION_LABELS = Object.freeze({
  de: Object.freeze({
    CONTEXT_ONLY: "Der Beleg liefert Kontext. Für diese Aussage reicht er nicht aus.",
    NOT_CURRENT: "Beleg ist als veraltet markiert",
    WRONG_VERSION: "Beleg gehört zu einer anderen Version",
    WRONG_RUN: "Beleg gehört zu einem anderen Prüflauf",
    OUTSIDE_VALID_DATE: "Beleg liegt außerhalb seines Gültigkeitszeitraums",
    WRONG_POSITION: "Beleg betrifft eine andere Option bzw. Belegposition",
    WRONG_OBJECT: "Beleg betrifft ein anderes Objekt",
    WRONG_CASE: "Beleg gehört zu einem anderen Entscheidungsfall",
    WRONG_DECISION_CASE: "Beleg gehört zu einem anderen Entscheidungsfall",
    WRONG_OPTION_BINDING: "Beleg ist an die falsche Option gebunden",
    CLAIM_POSITION_MISMATCH: "Aussage und angefragte Position stimmen nicht überein",
    OPTION_CASE_BINDING_MISMATCH: "Option ist an den falschen Fall gebunden",
    CLAIM_OPTION_BINDING_MISMATCH: "Aussage ist an die falsche Option gebunden",
    ASSERTION_CLAIM_BINDING_MISMATCH: "Evidenzbehauptung ist an die falsche Aussage gebunden",
    ASSERTION_PASSAGE_BINDING_MISMATCH: "Evidenzbehauptung ist an den falschen gespeicherten Text gebunden",
    ASSERTION_SCOPE_BINDING_MISMATCH: "Evidenzbehauptung ist an den falschen Geltungsbereich gebunden",
    ASSERTION_REVIEW_BINDING_MISMATCH: "Evidenzbehauptung ist an das falsche Prüfprotokoll gebunden",
    PASSAGE_SOURCE_BINDING_MISMATCH: "Gespeicherter Text ist an die falsche Quelle gebunden",
    SCOPE_CASE_BINDING_MISMATCH: "Geltungsbereich ist an den falschen Fall gebunden",
    ASSERTION_MODEL_BINDING_MISMATCH: "Aufgezeichnete Modellherkunft stimmt nicht überein",
    ASSERTION_DECISION_BINDING_MISMATCH: "Aufgezeichnete Entscheidungswirkung stimmt nicht überein",
    ASSERTION_POLARITY_BINDING_MISMATCH: "Richtung der Evidenzbehauptung stimmt nicht mit der Kante überein",
    FAILED_INTEGRITY_BINDING: "Gespeicherter Text und Fingerabdruck stimmen nicht überein",
    INVALID_REVIEW_RESULT: "Prüfergebnis ist nicht für die Auswertung zugelassen",
    INVALID_VALIDITY_DATE: "Gültigkeitsdatum ist ungültig",
    INVALID_SCOPE_DATE: "Gültigkeitsdatum ist ungültig",
    INVALID_PASSAGE_BINDING: "Darstellungsart und Belegbeziehung passen nicht zusammen",
    DECISION_CASE_INTEGRITY_MISMATCH: "Fallinhalt stimmt nicht mit seiner gespeicherten Prüfsumme überein",
    OPTION_INTEGRITY_MISMATCH: "Option stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    CRITERION_INTEGRITY_MISMATCH: "Kriterium stimmt nicht mit seiner gespeicherten Prüfsumme überein",
    CLAIM_CONTENT_INTEGRITY_MISMATCH: "Aussage stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    SOURCE_PROVENANCE_INTEGRITY_MISMATCH: "Quellenherkunft stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    PASSAGE_CONTENT_INTEGRITY_MISMATCH: "Gespeicherter Text oder seine Metadaten stimmen nicht mit der Prüfsumme überein",
    SCOPE_CONTENT_INTEGRITY_MISMATCH: "Geltungsbereich stimmt nicht mit seiner gespeicherten Prüfsumme überein",
    ASSERTION_CONTENT_INTEGRITY_MISMATCH: "Evidenzbehauptung stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    REVIEW_SEMANTICS_INTEGRITY_MISMATCH: "Prüfprotokoll stimmt nicht mit seiner gespeicherten Prüfsumme überein",
    MODEL_PROVENANCE_INTEGRITY_MISMATCH: "Modellherkunft stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    DECISION_CONTENT_INTEGRITY_MISMATCH: "Menschliche Entscheidung stimmt nicht mit ihrer gespeicherten Prüfsumme überein",
    CLAIM_TOPOLOGY_COUNT_MISMATCH: "Aussage und Evidenzbehauptung sind nicht eindeutig verbunden",
    PASSAGE_TOPOLOGY_COUNT_MISMATCH: "Evidenzbehauptung und gespeicherter Text sind nicht eindeutig verbunden",
    SOURCE_TOPOLOGY_COUNT_MISMATCH: "Gespeicherter Text und Quelle sind nicht eindeutig verbunden",
    SCOPE_TOPOLOGY_COUNT_MISMATCH: "Geltungsbereich ist nicht eindeutig verbunden",
    REVIEW_TOPOLOGY_COUNT_MISMATCH: "Prüfprotokoll ist nicht eindeutig verbunden",
    MODEL_TOPOLOGY_COUNT_MISMATCH: "Modellherkunft ist nicht eindeutig verbunden",
    DECISION_TOPOLOGY_COUNT_MISMATCH: "Entscheidungswirkung ist nicht eindeutig verbunden"
  }),
  en: Object.freeze({
    CONTEXT_ONLY: "Context only. The record does not establish or contradict this claim.",
    NOT_CURRENT: "Evidence is marked stale",
    WRONG_VERSION: "Evidence concerns another version",
    WRONG_RUN: "Evidence belongs to another evaluation run",
    OUTSIDE_VALID_DATE: "Evidence is outside its validity period",
    WRONG_POSITION: "Evidence concerns another option or position",
    WRONG_OBJECT: "Evidence concerns another object",
    WRONG_CASE: "Evidence belongs to another decision case",
    WRONG_DECISION_CASE: "Evidence belongs to another decision case",
    WRONG_OPTION_BINDING: "Evidence is bound to the wrong option",
    CLAIM_POSITION_MISMATCH: "Claim and requested position do not match",
    OPTION_CASE_BINDING_MISMATCH: "Option is bound to the wrong case",
    CLAIM_OPTION_BINDING_MISMATCH: "Claim is bound to the wrong option",
    ASSERTION_CLAIM_BINDING_MISMATCH: "Evidence assertion is bound to the wrong claim",
    ASSERTION_PASSAGE_BINDING_MISMATCH: "Evidence assertion is bound to the wrong stored text",
    ASSERTION_SCOPE_BINDING_MISMATCH: "Evidence assertion is bound to the wrong scope",
    ASSERTION_REVIEW_BINDING_MISMATCH: "Evidence assertion is bound to the wrong review",
    PASSAGE_SOURCE_BINDING_MISMATCH: "Stored text is bound to the wrong source",
    SCOPE_CASE_BINDING_MISMATCH: "Scope is bound to the wrong case",
    ASSERTION_MODEL_BINDING_MISMATCH: "Recorded model provenance does not match",
    ASSERTION_DECISION_BINDING_MISMATCH: "Recorded decision effect does not match",
    ASSERTION_POLARITY_BINDING_MISMATCH: "Assertion polarity does not match the relationship",
    FAILED_INTEGRITY_BINDING: "Stored text does not match its fingerprint",
    INVALID_REVIEW_RESULT: "Review result is not allowed to count",
    INVALID_VALIDITY_DATE: "Validity date is invalid",
    INVALID_SCOPE_DATE: "Validity date is invalid",
    INVALID_PASSAGE_BINDING: "Passage representation and evidence relationship do not match",
    DECISION_CASE_INTEGRITY_MISMATCH: "Case content does not match its stored checksum",
    OPTION_INTEGRITY_MISMATCH: "Option does not match its stored checksum",
    CRITERION_INTEGRITY_MISMATCH: "Criterion does not match its stored checksum",
    CLAIM_CONTENT_INTEGRITY_MISMATCH: "Claim does not match its stored checksum",
    SOURCE_PROVENANCE_INTEGRITY_MISMATCH: "Source provenance does not match its stored checksum",
    PASSAGE_CONTENT_INTEGRITY_MISMATCH: "Stored text or its metadata does not match its checksum",
    SCOPE_CONTENT_INTEGRITY_MISMATCH: "Scope does not match its stored checksum",
    ASSERTION_CONTENT_INTEGRITY_MISMATCH: "Evidence assertion does not match its stored checksum",
    REVIEW_SEMANTICS_INTEGRITY_MISMATCH: "Review record does not match its stored checksum",
    MODEL_PROVENANCE_INTEGRITY_MISMATCH: "Model provenance does not match its stored checksum",
    DECISION_CONTENT_INTEGRITY_MISMATCH: "Human decision does not match its stored checksum",
    CLAIM_TOPOLOGY_COUNT_MISMATCH: "Claim and evidence assertion are not uniquely connected",
    PASSAGE_TOPOLOGY_COUNT_MISMATCH: "Evidence assertion and stored text are not uniquely connected",
    SOURCE_TOPOLOGY_COUNT_MISMATCH: "Stored text and source are not uniquely connected",
    SCOPE_TOPOLOGY_COUNT_MISMATCH: "Scope is not uniquely connected",
    REVIEW_TOPOLOGY_COUNT_MISMATCH: "Review record is not uniquely connected",
    MODEL_TOPOLOGY_COUNT_MISMATCH: "Model provenance is not uniquely connected",
    DECISION_TOPOLOGY_COUNT_MISMATCH: "Decision effect is not uniquely connected"
  })
});

const COPY = Object.freeze({
  de: Object.freeze({
    lang: "de",
    pageTitle: "QENDROVA Evidenzprüfung – private lokale Probe",
    eyebrow: "PRIVATE LOKALE PROBE · NUR LESEN",
    title: "Evidenz vor Entscheidung prüfen",
    boundary: "Ein Evidenzstatus ist keine Tatsachenwahrheit und trifft niemals die Entscheidung. Ein passender Fingerabdruck belegt nur die Unversehrtheit des gespeicherten Textes – nicht die Wahrheit der Quelle oder die richtige Auslegung.",
    switchLabel: "English competition view",
    switchHref: "/en",
    languageLabel: "Sprache",
    overviewLaptop: "Vier Aussagen im Überblick",
    overviewRules: "Sechs Aussagen zu den Relate-Regeln im Überblick",
    overviewGeneric: "Aussagen im Überblick",
    overviewHint: "Jede Zeile führt direkt zur zugehörigen Begründung.",
    openDetails: "Begründung öffnen",
    humanTitle: "Entscheidung bleibt beim Menschen",
    humanOwner: "Verantwortung",
    human: "Mensch",
    selectedDecision: "Gewählte Handlung",
    uncertainty: "Offene Unsicherheit",
    revisit: "Erneut prüfen am",
    autoApproval: "Automatische Freigabe",
    no: "nein",
    noAuto: "Das System ordnet Belege ein. Es genehmigt keine Option und ersetzt keine menschliche Entscheidung.",
    legend: "Vier mögliche Evidenzzustände",
    legendHint: "Unbekannt bedeutet nicht falsch. Widersprochen bedeutet nicht unbekannt. Konflikt bedeutet: passende aktuelle Belege zeigen in beide Richtungen.",
    claimOption: "Option der Aussage",
    storedClaim: "Gespeicherte Originalaussage",
    requestedScope: "Angefragter Kontext",
    currentEvidence: "Zählende aktuelle Belege",
    excludedEvidence: "Sichtbar, aber nicht mitgezählt",
    support: "Stützender Beleg",
    contradict: "Widersprechender Beleg",
    excluded: "Ausgeschlossener Beleg",
    noMatching: "Kein passender aktueller Beleg vorhanden.",
    conflictGuide: "Der Konflikt wird hier einmal gezeigt: links stützend, rechts widersprechend. Beide Pfade sind gleich sichtbar.",
    back: "Zurück zur Übersicht",
    trace: "Vollständigen Belegpfad ansehen",
    originalPassage: "Gespeicherter Text",
    syntheticPassage: "Exakte synthetische Testpassage",
    paraphrasePassage: "Gespeicherte Paraphrase der öffentlichen Quelle",
    germanExplanation: "Feste deutsche Erklärung der synthetischen Passage",
    germanParaphraseExplanation: "Feste deutsche Erklärung der gespeicherten Paraphrase",
    object: "Objekt",
    evidencePosition: "Position des Belegs",
    version: "Version",
    runCase: "Prüflauf / Entscheidungsfall",
    validity: "Gültigkeit",
    exactSource: "Exakte Quelle",
    sourceLink: "Offizielle Quelle öffnen",
    checkedOn: "Geprüft am",
    representation: "Darstellungsart / Belegbeziehung",
    passageId: "Passagen-ID",
    locator: "Fundstelle",
    review: "Prüfprotokoll",
    model: "Modell- / Extraktionsherkunft",
    noModel: "Kein Modelllauf aufgezeichnet",
    decisionEffect: "Aufgezeichnete Wirkung auf die menschliche Entscheidung",
    noDecisionEffect: "Keine direkte Wirkung auf die menschliche Entscheidung aufgezeichnet",
    fingerprint: "Fingerabdruck der Passage",
    relation: "Belegbeziehung",
    integrityNote: "Integritätsgrenze: Der Fingerabdruck bindet diesen gespeicherten Text an den Datensatz; er beweist weder Quellenwahrheit noch wortgetreue Wiedergabe oder richtige Auslegung.",
    trustBoundary: "Lokale Vertrauensgrenze: Die gespeicherten Prüfsummen erkennen versehentliche oder einfache Datenänderungen. Sie schützen nicht vor jemandem mit Schreibzugriff, der Daten und Prüfsummen gemeinsam neu berechnet. Für den Evidenzstatus ist der geprüfte Bericht maßgeblich; der rohe Graph zeigt die tatsächlich gespeicherten Pfade und kann deshalb auch ungültige oder doppelte Verbindungen sichtbar machen.",
    rawGraphNote: "Prüfansicht: Der rohe Graph zeigt tatsächliche Laufzeitpfade. Der oben ausgewiesene, validierte Evidenzstatus bleibt maßgeblich.",
    caseNavigation: "Fall auswählen",
    currentCase: "Aktueller Fall",
    graphTitle: "Tatsächlicher Relate-Graphpfad",
    graphSummary: "Knoten, Kanten und feste Abfragebindung ansehen",
    graphDescription: "Die feste parametrisierte Abfrage folgt Entscheidungsfall → Option → Aussage → Evidenzbehauptung → gespeicherter Text → Quelle. Zusätzlich muss dieselbe Evidenz über ihren Geltungsbereich zum gleichen Entscheidungsfall zurückführen und einen Prüfdatensatz besitzen.",
    queryId: "Abfrage-ID",
    queryParameters: "Gebundene Parameter",
    returnedPaths: "Zurückgegebene Laufzeitpfade",
    path: "Pfad",
    type: "Typ",
    start: "Start",
    end: "Ende",
    noGraphPath: "Die feste Abfrage hat keinen vollständigen Pfad zurückgegeben.",
    evidenceBranch: "Hauptpfad",
    scopeBranch: "Geltungsbereich-Pfad",
    reviewBranch: "Prüfpfad",
    modelBranch: "Modellherkunft-Pfad",
    decisionBranch: "Entscheidungswirkung-Pfad",
    caseContext: "Fallkontext aus Relate",
    caseContextHint: "Diese Laufzeitansicht umfasst auch ungenutzte Optionen, Kriterien und die getrennte menschliche Entscheidung.",
    caseContextSummary: "Fallweite Knoten sowie Options-, Kriterien- und Entscheidungsbindungen ansehen",
    node: "Knoten",
    relationship: "Kante",
    elementId: "Relate-Element-ID",
    runtimeInventory: "Von result.graph() zurückgegebener Bestand",
    nodes: "Knoten",
    relationships: "Kanten",
    integrityState: "Integritätsprüfung",
    valid: "gültig",
    invalid: "ungültig",
    reasons: "Ausschlussgründe",
    code: "Technischer Code",
    supportCount: "stützend",
    contradictionCount: "widersprechend",
    synthetic: "Die Laptop- und Baustellenfälle verwenden erfundene Testdaten. Der Regelfall enthält gekennzeichnete Paraphrasen zweier öffentlicher Seiten. Die Ansicht liest lokal gespeicherte Daten.",
    error: "Die lokale Ansicht konnte nicht erzeugt werden."
  }),
  en: Object.freeze({
    lang: "en",
    pageTitle: "QENDROVA evidence review – private local spike",
    eyebrow: "PRIVATE LOCAL SPIKE · READ ONLY",
    title: "Review evidence before deciding",
    boundary: "Evidence status is not factual truth and never makes the decision. A matching fingerprint proves only stored-text integrity—not source truth or correct interpretation.",
    switchLabel: "Deutsche Testansicht",
    switchHref: "/",
    languageLabel: "Language",
    overviewLaptop: "Four claims at a glance",
    overviewRules: "Six Relate-rules claims at a glance",
    overviewGeneric: "Claims at a glance",
    overviewHint: "Each row links directly to its evidence rationale.",
    openDetails: "Open details",
    humanTitle: "Human decision authority",
    humanOwner: "Authority",
    human: "Human",
    selectedDecision: "Selected action",
    uncertainty: "Open uncertainty",
    revisit: "Review again on",
    autoApproval: "Automatic approval",
    no: "no",
    noAuto: "The system classifies evidence. It approves no option and never replaces the human decision.",
    legend: "Four evidence states",
    legendHint: "Unknown is not false. Contradicted is not unknown. Conflict means matching current evidence points both ways.",
    claimOption: "Claim option",
    storedClaim: "Stored original claim",
    requestedScope: "Requested context",
    currentEvidence: "Counting current evidence",
    excludedEvidence: "Visible but excluded evidence",
    support: "Supporting evidence",
    contradict: "Contradicting evidence",
    excluded: "Excluded evidence",
    noMatching: "No matching current evidence is available.",
    conflictGuide: "The conflict is shown once here: support on the left and contradiction on the right, with equal visibility.",
    back: "Back to overview",
    trace: "Inspect the complete evidence path",
    originalPassage: "Stored text",
    syntheticPassage: "Exact synthetic test passage",
    paraphrasePassage: "Stored paraphrase of the public source",
    germanExplanation: "",
    germanParaphraseExplanation: "",
    object: "Object",
    evidencePosition: "Evidence position",
    version: "Version",
    runCase: "Run / decision case",
    validity: "Validity",
    exactSource: "Exact source",
    sourceLink: "Open official source",
    checkedOn: "Checked on",
    representation: "Representation / evidence relationship",
    passageId: "Passage ID",
    locator: "Locator",
    review: "Review record",
    model: "Model / extraction provenance",
    noModel: "No model run recorded",
    decisionEffect: "Recorded effect on the human decision",
    noDecisionEffect: "No direct effect on the human decision recorded",
    fingerprint: "Passage fingerprint",
    relation: "Evidence relation",
    integrityNote: "Integrity boundary: the fingerprint binds this stored text to the record; it proves neither source truth, verbatim fidelity, nor correct interpretation.",
    trustBoundary: "Local trust boundary: stored checksums detect accidental or simple data drift. They do not protect against a writer who can change both the data and recompute its checksums. The validated report is authoritative for evidence status; the raw explorer shows the paths actually stored and can therefore expose invalid or duplicate topology.",
    rawGraphNote: "Audit view: the raw graph shows actual runtime paths. The validated evidence status shown above remains authoritative.",
    caseNavigation: "Choose case",
    currentCase: "Current case",
    graphTitle: "Actual Relate graph path",
    graphSummary: "Inspect runtime nodes, relationships, and fixed query binding",
    graphDescription: "The fixed parameterized query follows DecisionCase → Option → Claim → EvidenceAssertion → stored text → Source. It also requires that the same assertion returns through Scope to the same DecisionCase and has a Review record.",
    queryId: "Query ID",
    queryParameters: "Bound parameters",
    returnedPaths: "Returned runtime paths",
    path: "Path",
    type: "Type",
    start: "Start",
    end: "End",
    noGraphPath: "The fixed query returned no complete path.",
    evidenceBranch: "Evidence branch",
    scopeBranch: "Scope branch",
    reviewBranch: "Review branch",
    modelBranch: "Model provenance branch",
    decisionBranch: "Decision-effect branch",
    caseContext: "Relate case context",
    caseContextHint: "This runtime view also includes unused options, criteria, and the separate human decision.",
    caseContextSummary: "Inspect case-wide nodes and option, criterion, and decision bindings",
    node: "Node",
    relationship: "Relationship",
    elementId: "Relate element ID",
    runtimeInventory: "Entity inventory returned by result.graph()",
    nodes: "Nodes",
    relationships: "Relationships",
    integrityState: "Integrity check",
    valid: "valid",
    invalid: "invalid",
    reasons: "Exclusion reasons",
    code: "Technical code",
    supportCount: "supporting",
    contradictionCount: "contradicting",
    synthetic: "The laptop and construction cases use synthetic test data. The rules case contains labelled paraphrases of two public sources. This view reads locally stored data.",
    error: "The local view could not be generated."
  })
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeId(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function localizedOption(value, locale) {
  return OPTION_LABELS[locale][value] || String(value ?? "—");
}

function localizedClaim(claim, locale) {
  return CLAIM_LABELS[locale][claim.claimId] || claim.claimText;
}

function localizedCase(caseId, fallback, locale) {
  return CASE_LABELS[locale][caseId] || fallback || caseId;
}

function localizedUncertainty(report, locale) {
  if (locale !== "de") return report.decision.uncertainty;
  if (report.case.caseId === "case-laptop") return "Die Zuverlässigkeit der Reparatur ist weiterhin nicht belegt";
  if (report.case.caseId === "case-relate-rules") return "Übersicht und offizielle Regeln verwenden unterschiedliche Formulierungen zu Projektalter und Demoformat";
  return report.decision.uncertainty;
}

function routeFor(locale, caseId) {
  if (caseId === "case-laptop") return locale === "en" ? "/en" : "/";
  return locale === "en" ? `/en/case/${caseId}` : `/case/${caseId}`;
}

function localizedStatus(status, locale) {
  return STATUS_LABELS[locale][status] || status;
}

function statusClass(status) {
  if (status.startsWith("SATISFIED")) return "supported";
  if (status.startsWith("NOT_SATISFIED")) return "contradicted";
  if (status.startsWith("CONFLICTING")) return "conflict";
  return "unknown";
}

function renderOverview(report, locale, c) {
  const heading = report.case.caseId === "case-laptop"
    ? c.overviewLaptop
    : report.case.caseId === "case-relate-rules"
      ? c.overviewRules
      : `${report.claims.length} ${c.overviewGeneric}`;
  const rows = report.claims.map((claim) => `
    <div class="overview-row">
      <div><strong>${escapeHtml(localizedClaim(claim, locale))}</strong></div>
      <div><span class="status ${statusClass(claim.status)}">${escapeHtml(localizedStatus(claim.status, locale))}</span></div>
      <div><a href="#${escapeHtml(safeId(claim.claimId))}" aria-label="${escapeHtml(`${c.openDetails}: ${localizedClaim(claim, locale)}`)}">${escapeHtml(c.openDetails)}</a></div>
    </div>`).join("");
  return `<section id="overview" class="panel overview" aria-labelledby="overview-title">
    <h2 id="overview-title">${escapeHtml(heading)}</h2>
    <p>${escapeHtml(c.overviewHint)}</p>
    <div class="overview-list">${rows}
    </div>
  </section>`;
}

function renderCaseNavigation(report, cases, locale, c) {
  const constructionCaseIds = CONSTRUCTION_CASES.map((entry) => entry.caseId);
  const orderedCases = [
    ...constructionCaseIds.flatMap((id) => cases.filter((item) => item.caseId === id)),
    ...cases.filter((item) => !constructionCaseIds.includes(item.caseId))
  ];
  const links = orderedCases.map((item) => {
    const current = item.caseId === report.case.caseId;
    const label = localizedCase(item.caseId, item.title, locale);
    return `<li>${current ? `<strong aria-current="page">${escapeHtml(label)}</strong>` : `<a href="${escapeHtml(routeFor(locale, item.caseId))}">${escapeHtml(label)}</a>`} <span class="case-count">(${item.claimCount})</span></li>`;
  }).join("");
  return `<nav class="panel case-navigation" aria-labelledby="case-navigation-title">
    <h2 id="case-navigation-title">${escapeHtml(c.caseNavigation)}</h2>
    <p><strong>${escapeHtml(c.currentCase)}:</strong> ${escapeHtml(localizedCase(report.case.caseId, report.case.title, locale))}</p>
    <ul>${links}</ul>
  </nav>`;
}

function renderConstructionComparison(comparison, locale) {
  const german = locale === "de";
  const heading = german ? "Baustellenbeispiel im Vergleich" : "Compare the construction cases";
  const prompt = german
    ? "Beide Varianten prüfen die Dokumentation derselben erfundenen Vertiefung in Revision B. Öffne die Belegpfade und vergleiche, was der neue geprüfte Vermerk ändert. Die technische Freigabe bleibt eine eigene menschliche Entscheidung."
    : "Both variants check documentation for the same synthetic recess in revision B. Follow the evidence paths to see what the added reviewed record changes. Any engineering sign-off remains a separate human decision.";
  const cards = comparison.map(({ report, claim }) => {
    const label = localizedCase(report.case.caseId, report.case.title, locale);
    const href = routeFor(locale, report.case.caseId) + "#" + safeId(claim.claimId);
    const matching = german ? "Passende stützende Belege" : "Matching supporting records";
    const selected = german ? "Menschliche Entscheidung" : "Human decision";
    const detail = german ? "Belege und Ausschlüsse ansehen" : "Inspect evidence and exclusions";
    const decision = german
      ? localizedOption(report.decision.selectedOption, locale)
      : report.decision.selectedOptionLabel ?? report.decision.selectedOption;
    return `<section class="evidence-card">
      <h3>${escapeHtml(label)}</h3>
      <p><span class="status ${statusClass(claim.status)}">${escapeHtml(localizedStatus(claim.status, locale))}</span></p>
      <p>${escapeHtml(matching)} <strong>${claim.supportCount}</strong></p>
      <p>${escapeHtml(selected)} <strong>${escapeHtml(decision)}</strong></p>
      <a href="${escapeHtml(href)}">${escapeHtml(detail)}</a>
    </section>`;
  }).join("");
  return `<section class="panel" aria-labelledby="construction-comparison-title">
    <h2 id="construction-comparison-title">${escapeHtml(heading)}</h2>
    <p>${escapeHtml(prompt)}</p>
    <div class="conflict-grid">${cards}</div>
  </section>`;
}

function renderDecision(report, locale, c) {
  const decision = report.decision;
  const labels = OPTION_LABELS[locale];
  const hasBuiltInTranslation = Object.hasOwn(CASE_LABELS[locale], report.case.caseId) &&
    Object.hasOwn(labels, decision.selectedOption);
  const selectedLabel = hasBuiltInTranslation
    ? labels[decision.selectedOption]
    : decision.selectedOptionLabel ?? decision.selectedOption ?? "—";
  return `<section class="panel decision" aria-labelledby="decision-title">
    <h2 id="decision-title">${escapeHtml(c.humanTitle)}</h2>
    <dl class="decision-grid">
      <div><dt>${escapeHtml(c.humanOwner)}</dt><dd><strong>${escapeHtml(c.human)}</strong></dd></div>
      <div><dt>${escapeHtml(c.selectedDecision)}</dt><dd><strong>${escapeHtml(selectedLabel)}</strong> <code>${escapeHtml(decision.selectedOption)}</code></dd></div>
      <div><dt>${escapeHtml(c.uncertainty)}</dt><dd>${escapeHtml(localizedUncertainty(report, locale))}</dd></div>
      <div><dt>${escapeHtml(c.revisit)}</dt><dd>${escapeHtml(decision.revisitAt)}</dd></div>
      <div><dt>${escapeHtml(c.autoApproval)}</dt><dd><strong>${escapeHtml(c.no)}</strong></dd></div>
    </dl>
    <p class="boundary">${escapeHtml(c.noAuto)}</p>
  </section>`;
}

function renderLegend(locale, c) {
  const entries = Object.entries(STATUS_LABELS[locale]).map(([status, label]) => `
    <li><span class="status ${statusClass(status)}">${escapeHtml(label)}</span><code>${escapeHtml(status)}</code></li>`).join("");
  return `<section class="panel" aria-labelledby="legend-title">
    <h2 id="legend-title">${escapeHtml(c.legend)}</h2>
    <p>${escapeHtml(c.legendHint)}</p>
    <ul class="legend">${entries}
    </ul>
  </section>`;
}

function renderTrace(row, locale, c, title, tone) {
  const reviewParts = [row.reviewerType, row.reviewResult, row.reviewId].filter(Boolean).join(" — ");
  const reviewDetail = [row.reviewTimestamp, row.reviewNote].filter(Boolean).join(" — ");
  const model = row.modelRunId
    ? [row.modelRunId, row.modelTool, row.modelName, row.promptVersion].filter(Boolean).join(" — ")
    : c.noModel;
  const decisionEffect = row.affectedDecisionId
    ? `${row.affectedDecisionId} — ${localizedOption(row.affectedSelectedOption, locale)} (${row.affectedSelectedOption})`
    : c.noDecisionEffect;
  const source = [row.sourceTitle, row.sourcePublisher, row.sourceType, row.sourceId].filter(Boolean).join(" — ");
  const passageLabel = row.passageRepresentation === "PARAPHRASE" ? c.paraphrasePassage : c.syntheticPassage;
  const storedText = row.passageRepresentation === "PARAPHRASE"
    ? `<p class="passage-text paraphrase">${escapeHtml(row.passageText)}</p>`
    : `<blockquote>${escapeHtml(row.passageText)}</blockquote>`;
  const sourceLink = row.sourceUrl
    ? `<br><a href="${escapeHtml(row.sourceUrl)}" rel="noopener noreferrer">${escapeHtml(c.sourceLink)}</a> · ${escapeHtml(c.checkedOn)} ${escapeHtml(row.sourceCheckedOn)}`
    : "";
  const reasons = Array.isArray(row.exclusionReasons) && row.exclusionReasons.length
    ? `<div class="exclusion-reasons"><strong>${escapeHtml(c.reasons)}:</strong><ul>${row.exclusionReasons.map((reason) => `<li>${escapeHtml(EXCLUSION_LABELS[locale][reason] || reason)} <code>${escapeHtml(reason)}</code></li>`).join("")}</ul>${row.exclusionReasons.includes("CONTEXT_ONLY") && row.reviewNote ? `<p>${escapeHtml(row.reviewNote)}</p>` : ""}</div>`
    : "";
  const germanExplanation = locale === "de" && PASSAGE_EXPLANATIONS_DE[row.passageId]
    ? `<p class="translation"><strong>${escapeHtml(row.passageRepresentation === "PARAPHRASE" ? c.germanParaphraseExplanation : c.germanExplanation)}:</strong> ${escapeHtml(PASSAGE_EXPLANATIONS_DE[row.passageId])}</p>`
    : "";
  return `<section class="evidence-card ${tone}">
    <h4>${escapeHtml(title)}</h4>
    <p class="passage-label">${escapeHtml(passageLabel)}</p>
    ${storedText}
    ${germanExplanation}
    ${reasons}
    <details>
      <summary>${escapeHtml(c.trace)}</summary>
      <dl class="trace">
        <div><dt>${escapeHtml(c.claimOption)}</dt><dd>${escapeHtml(localizedOption(row.optionPosition, locale))} <code>${escapeHtml(row.optionPosition)}</code></dd></div>
        <div><dt>${escapeHtml(c.evidencePosition)}</dt><dd>${escapeHtml(localizedOption(row.position, locale))} <code>${escapeHtml(row.position)}</code></dd></div>
        <div><dt>${escapeHtml(c.object)}</dt><dd><code>${escapeHtml(row.object)}</code></dd></div>
        <div><dt>${escapeHtml(c.version)}</dt><dd><code>${escapeHtml(row.version)}</code></dd></div>
        <div><dt>${escapeHtml(c.runCase)}</dt><dd><code>${escapeHtml(row.runId)}</code> / <code>${escapeHtml(row.caseId)}</code></dd></div>
        <div><dt>${escapeHtml(c.validity)}</dt><dd>${escapeHtml(row.validFrom)} – ${escapeHtml(row.validTo)}</dd></div>
        <div><dt>${escapeHtml(c.exactSource)}</dt><dd>${escapeHtml(source)}${sourceLink}</dd></div>
        <div><dt>${escapeHtml(c.passageId)}</dt><dd><code>${escapeHtml(row.passageId)}</code></dd></div>
        <div><dt>${escapeHtml(c.locator)}</dt><dd>${escapeHtml(row.passageLocator)}</dd></div>
        <div><dt>${escapeHtml(c.representation)}</dt><dd><code>${escapeHtml(row.passageRepresentation)}</code> / <code>${escapeHtml(row.passageRelation)}</code></dd></div>
        <div><dt>${escapeHtml(c.review)}</dt><dd>${escapeHtml(reviewParts)}<br>${escapeHtml(reviewDetail)}</dd></div>
        <div><dt>${escapeHtml(c.model)}</dt><dd>${escapeHtml(model)}</dd></div>
        <div><dt>${escapeHtml(c.decisionEffect)}</dt><dd>${escapeHtml(decisionEffect)}</dd></div>
        <div><dt>${escapeHtml(c.fingerprint)}</dt><dd><code class="fingerprint">${escapeHtml(row.fingerprint)}</code></dd></div>
        <div><dt>${escapeHtml(c.relation)}</dt><dd><code>${escapeHtml(row.relation)}</code></dd></div>
      </dl>
      <p class="integrity">${escapeHtml(c.integrityNote)}</p>
    </details>
  </section>`;
}

function graphEntityName(entity, c) {
  if (entity.kind === "node") {
    const label = (entity.labels || []).join(" + ");
    const identity = entity.properties?.id || entity.properties?.title || entity.properties?.label || "—";
    return `${c.node}: ${label} — ${identity}`;
  }
  return `${c.relationship}: ${entity.type}`;
}

function renderGraphSequence(sequence, c) {
  return `<ol class="graph-sequence">${sequence.map((entity) => `
    <li class="${entity.kind === "node" ? "graph-node" : "graph-relationship"}">
      <strong>${escapeHtml(graphEntityName(entity, c))}</strong><br>
      <span>${escapeHtml(c.elementId)}: <code>${escapeHtml(entity.elementId)}</code></span>
    </li>`).join("")}
  </ol>`;
}

function renderGraphInventory(graph, c, heading = c.runtimeInventory, hint = "", headingLevel = 4) {
  const headingTag = headingLevel === 3 ? "h3" : "h4";
  const nodeRows = graph.inventory.nodes.map((node) => `
    <tr><td>${escapeHtml((node.labels || []).join(" + "))}</td><td><code>${escapeHtml(node.properties?.id || "—")}</code></td><td>${escapeHtml(node.integrityValid ? c.valid : c.invalid)}</td><td><code>${escapeHtml(node.elementId)}</code></td></tr>`).join("");
  const relationshipRows = graph.inventory.relationships.map((relationship) => `
    <tr><td><code>${escapeHtml(relationship.type)}</code></td><td><code>${escapeHtml(relationship.startElementId)}</code></td><td><code>${escapeHtml(relationship.endElementId)}</code></td><td><code>${escapeHtml(relationship.elementId)}</code></td></tr>`).join("");
  return `<${headingTag}>${escapeHtml(heading)}</${headingTag}>
    ${hint ? `<p>${escapeHtml(hint)}</p>` : ""}
    <div class="table-scroll"><table>
      <caption>${escapeHtml(c.nodes)} (${graph.inventory.nodes.length})</caption>
      <thead><tr><th scope="col">Label</th><th scope="col">ID</th><th scope="col">${escapeHtml(c.integrityState)}</th><th scope="col">${escapeHtml(c.elementId)}</th></tr></thead>
      <tbody>${nodeRows}</tbody>
    </table></div>
    <div class="table-scroll"><table>
      <caption>${escapeHtml(c.relationships)} (${graph.inventory.relationships.length})</caption>
      <thead><tr><th scope="col">${escapeHtml(c.type)}</th><th scope="col">${escapeHtml(c.start)}</th><th scope="col">${escapeHtml(c.end)}</th><th scope="col">${escapeHtml(c.elementId)}</th></tr></thead>
      <tbody>${relationshipRows}</tbody>
    </table></div>`;
}

function renderGraphExplorer(claim, locale, c) {
  const graph = claim.graphPath;
  const contextIds = new Set(claim.excluded
    .filter((row) => row.exclusionReasons.includes("CONTEXT_ONLY"))
    .map((row) => row.assertionId));
  const paths = graph.paths.length
    ? `<h4>${escapeHtml(c.returnedPaths)} (${graph.paths.length})</h4>${graph.paths.map((path, index) => {
      const contextOnly = path.evidencePath.some((entity) => entity.kind === "node" && contextIds.has(entity.properties?.id));
      return `
      <section class="runtime-path" aria-labelledby="path-${escapeHtml(safeId(claim.claimId))}-${index}">
        <h5 id="path-${escapeHtml(safeId(claim.claimId))}-${index}">${escapeHtml(c.path)} ${index + 1}</h5>
        ${contextOnly ? `<p class="integrity">${escapeHtml(EXCLUSION_LABELS[locale].CONTEXT_ONLY)}</p>` : ""}
        <h6>${escapeHtml(c.evidenceBranch)}</h6>${renderGraphSequence(path.evidencePath, c)}
        <h6>${escapeHtml(c.scopeBranch)}</h6>${renderGraphSequence(path.scopePath, c)}
        <h6>${escapeHtml(c.reviewBranch)}</h6>${renderGraphSequence(path.reviewPath, c)}
        ${path.modelPath.length ? `<h6>${escapeHtml(c.modelBranch)}</h6>${renderGraphSequence(path.modelPath, c)}` : ""}
        ${path.decisionPath.length ? `<h6>${escapeHtml(c.decisionBranch)}</h6>${renderGraphSequence(path.decisionPath, c)}` : ""}
      </section>`;
    }).join("")}`
    : `<p class="empty">${escapeHtml(c.noGraphPath)}</p>`;
  return `<section class="graph-explorer" aria-labelledby="graph-${escapeHtml(safeId(claim.claimId))}">
    <h3 id="graph-${escapeHtml(safeId(claim.claimId))}">${escapeHtml(c.graphTitle)}</h3>
    <p>${escapeHtml(c.graphDescription)}</p>
    <p class="integrity">${escapeHtml(c.rawGraphNote)}</p>
    <details>
      <summary>${escapeHtml(c.graphSummary)}</summary>
      <dl class="trace graph-metadata">
        <div><dt>${escapeHtml(c.queryId)}</dt><dd><code>${escapeHtml(graph.queryId)}</code></dd></div>
        <div><dt>${escapeHtml(c.queryParameters)}</dt><dd><code>caseId=${escapeHtml(graph.parameters.caseId)} · claimId=${escapeHtml(graph.parameters.claimId)}</code></dd></div>
      </dl>
      ${paths}
      ${renderGraphInventory(graph, c)}
    </details>
  </section>`;
}

function renderCaseGraphContext(report, c) {
  const context = report.claims[0]?.graphPath?.caseContext;
  if (!context) return "";
  return `<section class="panel case-graph-context" aria-labelledby="case-graph-context-title">
    <h2 id="case-graph-context-title">${escapeHtml(c.caseContext)}</h2>
    <p>${escapeHtml(c.caseContextHint)}</p>
    <details>
      <summary>${escapeHtml(c.caseContextSummary)}</summary>
      ${renderGraphInventory(context, c, c.runtimeInventory, "", 3)}
    </details>
  </section>`;
}

function renderClaim(claim, locale, c) {
  const support = claim.matching.filter((row) => row.relation === "SUPPORTED_BY");
  const contradiction = claim.matching.filter((row) => row.relation === "CONTRADICTED_BY");
  const option = localizedOption(claim.claimPosition, locale);
  let evidenceBody;
  if (claim.status === "CONFLICTING_MATCHING_CURRENT_EVIDENCE") {
    evidenceBody = `<p class="conflict-guide">${escapeHtml(c.conflictGuide)}</p>
      <div class="conflict-grid">
        <div class="conflict-side"><h3>${escapeHtml(c.support)}</h3>${support.map((row) => renderTrace(row, locale, c, row.sourceTitle, "support-card")).join("")}</div>
        <div class="conflict-side"><h3>${escapeHtml(c.contradict)}</h3>${contradiction.map((row) => renderTrace(row, locale, c, row.sourceTitle, "contradiction-card")).join("")}</div>
      </div>`;
  } else if (claim.matching.length) {
    evidenceBody = `<h3>${escapeHtml(c.currentEvidence)}</h3>${claim.matching.map((row) => renderTrace(
      row,
      locale,
      c,
      row.relation === "SUPPORTED_BY" ? c.support : c.contradict,
      row.relation === "SUPPORTED_BY" ? "support-card" : "contradiction-card"
    )).join("")}`;
  } else {
    evidenceBody = `<h3>${escapeHtml(c.currentEvidence)}</h3><p class="empty">${escapeHtml(c.noMatching)}</p>`;
  }
  const excluded = claim.excluded.length
    ? `<h3>${escapeHtml(c.excludedEvidence)}</h3>${claim.excluded.map((row) => renderTrace(row, locale, c, c.excluded, "excluded-card")).join("")}`
    : "";
  const scope = claim.requestedScope;
  return `<article id="${escapeHtml(safeId(claim.claimId))}" class="panel claim">
    <header class="claim-header">
      <div>
        <p class="claim-id"><code>${escapeHtml(claim.claimId)}</code></p>
        <h2>${escapeHtml(localizedClaim(claim, locale))}</h2>
      </div>
      <span class="status ${statusClass(claim.status)}">${escapeHtml(localizedStatus(claim.status, locale))}</span>
    </header>
    <dl class="claim-context">
      <div><dt>${escapeHtml(c.claimOption)}</dt><dd>${escapeHtml(option)} <code>${escapeHtml(claim.claimPosition)}</code></dd></div>
      <div><dt>${escapeHtml(c.storedClaim)}</dt><dd>${escapeHtml(claim.claimText)}</dd></div>
      <div><dt>${escapeHtml(c.requestedScope)}</dt><dd><code>${escapeHtml(scope.object)} · ${escapeHtml(scope.version)} · ${escapeHtml(scope.position)} · ${escapeHtml(scope.runId)} · ${escapeHtml(scope.caseId)} · ${escapeHtml(scope.asOf)}</code></dd></div>
      <div><dt>${escapeHtml(c.currentEvidence)}</dt><dd>${claim.supportCount} ${escapeHtml(c.supportCount)} · ${claim.contradictionCount} ${escapeHtml(c.contradictionCount)}</dd></div>
    </dl>
    ${evidenceBody}
    ${excluded}
    ${renderGraphExplorer(claim, locale, c)}
    <p class="back"><a href="#overview">↑ ${escapeHtml(c.back)}</a></p>
  </article>`;
}

function renderPage(report, locale, cases, constructionComparison = null) {
  const c = COPY[locale];
  const claims = report.claims.map((claim) => renderClaim(claim, locale, c)).join("\n");
  const rulesSnapshot = report.case.caseId === "case-relate-rules"
    ? locale === "de"
      ? `Historischer Quellenstand vom ${report.case.asOf}. Für eine heutige Einreichung gelten die aktuellen offiziellen Regeln.`
      : `Historical source snapshot from ${report.case.asOf}. Check the current official rules for an actual entry.`
    : "";
  const otherLocale = locale === "de" ? "en" : "de";
  const languageHref = routeFor(otherLocale, report.case.caseId);
  return `<!doctype html>
<html lang="${c.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(c.pageTitle)}</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#121a2c; --line:#2a3854; --text:#edf4ff; --muted:#aebbd0; --link:#8cc8ff; --good:#66d49b; --bad:#ff8b91; --warn:#ffd479; --unknown:#bdc8da; }
    * { box-sizing:border-box; }
    body { margin:0; font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
    a { color:var(--link); text-underline-offset:.2em; }
    a:focus-visible, summary:focus-visible { outline:3px solid #fff; outline-offset:4px; border-radius:4px; }
    code { overflow-wrap:anywhere; color:#dce8ff; }
    .shell { width:min(1120px,calc(100% - 2rem)); margin:0 auto; }
    .site-header { padding:2rem 0 1.25rem; border-bottom:1px solid var(--line); background:#0e1527; }
    .header-top { display:flex; gap:1rem; justify-content:space-between; align-items:start; }
    .eyebrow { color:var(--warn); font-size:.78rem; font-weight:800; letter-spacing:.08em; }
    h1 { margin:.25rem 0 .6rem; font-size:clamp(2rem,5vw,3.5rem); line-height:1.05; }
    h2 { line-height:1.2; }
    .lead { max-width:78ch; font-size:1.08rem; }
    .trust-boundary { max-width:88ch; color:var(--muted); font-size:.92rem; }
    .language { white-space:nowrap; }
    .case-navigation ul { display:flex; flex-wrap:wrap; gap:.75rem 1.25rem; padding-left:1.25rem; }
    .case-count { color:var(--muted); }
    main { padding:1.25rem 0 3rem; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:1.1rem; margin:0 0 1rem; scroll-margin-top:1rem; }
    .panel > :first-child { margin-top:0; }
    .overview-list { border-top:1px solid var(--line); }
    .overview-row { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) auto; gap:1rem; align-items:center; padding:.85rem 0; border-bottom:1px solid var(--line); }
    .status { display:inline-block; border:1px solid currentColor; border-radius:999px; padding:.22rem .58rem; font-weight:750; font-size:.87rem; }
    .supported { color:var(--good); }
    .contradicted { color:var(--bad); }
    .conflict { color:var(--warn); }
    .unknown { color:var(--unknown); }
    .decision-grid,.claim-context,.trace { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; }
    dl div { min-width:0; padding:.65rem; background:#0d1425; border-radius:8px; }
    dt { color:var(--muted); font-size:.82rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
    dd { margin:.2rem 0 0; }
    .boundary,.integrity,.synthetic,.conflict-guide { border-left:4px solid var(--warn); padding:.65rem .85rem; background:#1c1a19; }
    .legend { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; padding:0; list-style:none; }
    .legend li { display:flex; flex-direction:column; gap:.35rem; background:#0d1425; padding:.7rem; border-radius:8px; }
    .claim { padding:1.25rem; }
    .claim-header { display:flex; gap:1rem; justify-content:space-between; align-items:start; border-bottom:1px solid var(--line); margin-bottom:1rem; }
    .claim-header h2 { margin:.2rem 0 1rem; }
    .claim-id { margin:0; color:var(--muted); }
    .evidence-card { border:1px solid var(--line); border-left-width:5px; padding:.9rem; border-radius:10px; margin:.8rem 0; background:#0d1425; }
    .support-card { border-left-color:var(--good); }
    .contradiction-card { border-left-color:var(--bad); }
    .excluded-card { border-left-color:var(--unknown); opacity:.92; }
    .evidence-card h4 { margin:0 0 .55rem; }
    .passage-label { margin:.35rem 0; color:var(--muted); font-size:.9rem; }
    blockquote,.passage-text { margin:.3rem 0 .7rem; padding:.8rem 1rem; background:#172138; border-left:3px solid var(--link); font-size:1.04rem; }
    .paraphrase { border-left-style:dashed; }
    .translation { padding:.65rem; background:#172138; }
    details { border-top:1px solid var(--line); margin-top:.8rem; padding-top:.7rem; }
    summary { cursor:pointer; color:var(--link); font-weight:750; }
    .trace { margin-top:.8rem; }
    .fingerprint { font-size:.78rem; }
    .conflict-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
    .exclusion-reasons ul { margin:.35rem 0; }
    .graph-explorer { border-top:1px solid var(--line); margin-top:1.2rem; padding-top:1rem; }
    .graph-sequence { padding-left:1.4rem; }
    .graph-sequence li { margin:.35rem 0; padding:.45rem .55rem; border-radius:7px; }
    .graph-node { background:#172138; }
    .graph-relationship { border:1px dashed var(--line); }
    .runtime-path { border:1px solid var(--line); border-radius:9px; margin:.8rem 0; padding:.75rem; }
    .table-scroll { overflow-x:auto; margin:.8rem 0; }
    table { width:100%; border-collapse:collapse; font-size:.9rem; }
    caption { text-align:left; font-weight:750; padding:.4rem 0; }
    th,td { border:1px solid var(--line); padding:.45rem; text-align:left; vertical-align:top; }
    .back { text-align:right; margin-bottom:0; }
    .synthetic { margin-top:1.25rem; color:var(--muted); }
    @media (max-width:760px) {
      .header-top,.claim-header { flex-direction:column; }
      .overview-row,.decision-grid,.claim-context,.trace,.legend,.conflict-grid { grid-template-columns:1fr; }
      .language { white-space:normal; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="shell header-top">
      <div>
        <div class="eyebrow">${escapeHtml(c.eyebrow)}</div>
        <h1>${escapeHtml(c.title)}</h1>
        <p class="lead boundary">${escapeHtml(c.boundary)}</p>
        <p class="trust-boundary">${escapeHtml(c.trustBoundary)}</p>
      </div>
      <nav class="language" aria-label="${escapeHtml(c.languageLabel)}"><a href="${escapeHtml(languageHref)}">${escapeHtml(c.switchLabel)}</a></nav>
    </div>
  </header>
  <main>
    <div class="shell">
      ${renderCaseNavigation(report, cases, locale, c)}
      ${rulesSnapshot ? `<p class="panel">${escapeHtml(rulesSnapshot)}</p>` : ""}
      ${constructionComparison ? renderConstructionComparison(constructionComparison, locale) : ""}
      ${renderOverview(report, locale, c)}
      ${renderDecision(report, locale, c)}
      ${renderLegend(locale, c)}
      ${renderCaseGraphContext(report, c)}
      ${claims}
      <p class="synthetic">${escapeHtml(c.synthetic)}</p>
    </div>
  </main>
</body>
</html>`;
}

function allowedHost(host) {
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(String(host || ""));
}

function send(response, status, contentType, body, method) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Content-Length": payload.length
  });
  if (method === "HEAD") response.end();
  else response.end(payload);
}

function parseViewRoute(route, caseIds) {
  if (route === "/") return { locale: "de", caseId: "case-laptop" };
  if (route === "/en") return { locale: "en", caseId: "case-laptop" };
  const german = /^\/case\/([a-z][a-z0-9-]*)$/.exec(route);
  if (german && caseIds.has(german[1])) return { locale: "de", caseId: german[1] };
  const english = /^\/en\/case\/([a-z][a-z0-9-]*)$/.exec(route);
  if (english && caseIds.has(english[1])) return { locale: "en", caseId: english[1] };
  return null;
}

function createLocalServer(storePath) {
  const connection = openStore(storePath, { readOnly: true }).connect();
  const cases = listCases(connection);
  const caseIds = new Set(cases.map((item) => item.caseId));
  return http.createServer((request, response) => {
    const method = request.method || "GET";
    if (!allowedHost(request.headers.host)) {
      send(response, 403, "text/plain; charset=utf-8", "Forbidden", method);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", method);
      return;
    }
    const route = String(request.url || "/").split("?", 1)[0];
    try {
      if (route === "/health") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, readOnly: true, bindAddress: "127.0.0.1" }), method);
        return;
      }
      if (route === "/api/report") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(buildReportFromConnection(connection)), method);
        return;
      }
      if (route === "/api/cases") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(cases), method);
        return;
      }
      const apiReport = /^\/api\/report\/([a-z][a-z0-9-]*)$/.exec(route);
      if (apiReport && caseIds.has(apiReport[1])) {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(buildReportFromConnection(connection, apiReport[1])), method);
        return;
      }
      const view = parseViewRoute(route, caseIds);
      if (view) {
        const report = buildReportFromConnection(connection, view.caseId);
        const compareConstruction = CONSTRUCTION_CASES.some((entry) => entry.caseId === view.caseId)
          && CONSTRUCTION_CASES.every((entry) => caseIds.has(entry.caseId));
        const comparison = compareConstruction
          ? CONSTRUCTION_CASES.map((entry) => {
            const variant = entry.caseId === view.caseId ? report : buildReportFromConnection(connection, entry.caseId);
            return { report: variant, claim: variant.claims.find((claim) => claim.claimId === entry.claimId) };
          })
          : [];
        const availableComparison = comparison.length && comparison.every((entry) => entry.claim) ? comparison : null;
        send(response, 200, "text/html; charset=utf-8", renderPage(report, view.locale, cases, availableComparison), method);
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "Not Found", method);
    } catch (_error) {
      const locale = route.startsWith("/en") ? "en" : "de";
      send(response, 500, "text/plain; charset=utf-8", COPY[locale].error, method);
    }
  });
}

module.exports = { SECURITY_HEADERS, allowedHost, createLocalServer, escapeHtml, parseViewRoute, renderPage };
