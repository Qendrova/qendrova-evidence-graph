const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildCaseReportFromConnection,
  importDecisionPacketsToEmptyStore,
  queryClaimGraph
} = require("../src/evidence-graph.cjs");
const { loadFixturePacket } = require("../src/decision-packet.cjs");

function withRulesStore(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qendrova-integrity-"));
  const storePath = path.join(root, "evidence.rl");
  try {
    const receipt = importDecisionPacketsToEmptyStore(storePath, [
      loadFixturePacket("relate-rules.public.json")
    ]);
    return callback(receipt.connection);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function byClaim(report, claimId) {
  return report.claims.find((claim) => claim.claimId === claimId);
}

function allReasons(report) {
  return new Set([
    ...(report.caseInventory?.reasons || []),
    ...report.claims.flatMap((claim) => claim.excluded.flatMap((row) => row.exclusionReasons || []))
  ]);
}

function assertCaseInvalid(report, expectedReason) {
  assert.equal(report.caseInventory?.valid, false, "case-level inventory must be explicitly invalid");
  assert.ok(allReasons(report).has(expectedReason), `missing ${expectedReason}`);
  assert.equal(report.liveConflicts.length, 0, "invalid case context must suppress live conflicts");
  for (const claim of report.claims) {
    assert.equal(claim.status, "UNKNOWN_NOT_PROVEN", `${claim.claimId} must not count evidence under an invalid case context`);
  }
}

test("case inventory covers criteria and options that have no claim paths", () => {
  withRulesStore((conn) => {
    conn.query("MATCH (n:Criterion {id:'criterion-project-age'}) SET n.label='tampered criterion'");
    conn.query("MATCH (n:Option {id:'option-overview-reading'}) SET n.label='tampered unused option'");

    const report = buildCaseReportFromConnection(conn, "case-relate-rules");
    assertCaseInvalid(report, "CRITERION_INTEGRITY_MISMATCH");
    assert.ok(allReasons(report).has("OPTION_INTEGRITY_MISMATCH"));

    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-ai-disclosure");
    const contextNodes = graph.caseContext?.inventory?.nodes || [];
    const criterion = contextNodes.find((node) => node.labels.includes("Criterion") && node.properties.id === "criterion-project-age");
    const option = contextNodes.find((node) => node.labels.includes("Option") && node.properties.id === "option-overview-reading");
    assert.ok(criterion, "the graph context must enumerate the tampered criterion");
    assert.ok(option, "the graph context must enumerate the unused option");
    assert.equal(criterion.integrityValid, false);
    assert.equal(option.integrityValid, false);
  });
});

test("exact node schemas reject extra properties and extra labels without leaking them", () => {
  withRulesStore((conn) => {
    conn.query("MATCH (c:Claim {id:'claim-ai-disclosure'}) SET c.title='forged title', c:Forged");

    const report = buildCaseReportFromConnection(conn, "case-relate-rules");
    assertCaseInvalid(report, "CLAIM_CONTENT_INTEGRITY_MISMATCH");

    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-ai-disclosure");
    const claim = graph.inventory.nodes.find((node) => node.properties.id === "claim-ai-disclosure");
    assert.ok(claim);
    assert.equal(claim.integrityValid, false);
    assert.equal(Object.hasOwn(claim.properties, "title"), false, "unknown properties must not be serialized");
    assert.ok(claim.labels.includes("Forged"), "the actual unexpected label remains auditable");
  });
});

test("non-finite and bigint property tampering never crashes report or JSON serialization", () => {
  withRulesStore((conn) => {
    conn.query("MATCH (s:Source {id:'source-relate-overview'}) SET s.url=$url", { url: Number.NaN });
    conn.query("MATCH (r:Review {id:'review-official-sources'}) SET r.note=$note", { note: 9223372036854775807n });

    let report;
    assert.doesNotThrow(() => {
      report = buildCaseReportFromConnection(conn, "case-relate-rules");
    });
    assert.doesNotThrow(() => JSON.stringify(report));
    assertCaseInvalid(report, "SOURCE_PROVENANCE_INTEGRITY_MISMATCH");
    assert.ok(allReasons(report).has("REVIEW_SEMANTICS_INTEGRITY_MISMATCH"));

    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-existing-extension");
    assert.doesNotThrow(() => JSON.stringify(graph));
    const source = graph.inventory.nodes.find((node) => node.properties.id === "source-relate-overview");
    const review = graph.inventory.nodes.find((node) => node.properties.id === "review-official-sources");
    assert.equal(source.integrityValid, false);
    assert.equal(review.integrityValid, false);
  });
});

test("wrong runtime types across every decision layer become exclusions instead of exceptions", () => {
  withRulesStore((conn) => {
    const huge = 9223372036854775807n;
    conn.query("MATCH (n:DecisionCase {id:'case-relate-rules'}) SET n.asOf=$value", { value: huge });
    conn.query("MATCH (n:Option {id:'option-rules-minimum'}) SET n.position=$value", { value: Number.NaN });
    conn.query("MATCH (n:Claim {id:'claim-ai-disclosure'}) SET n.text=$value", { value: huge });
    conn.query("MATCH (n:Passage {id:'passage-rules-ai'}) SET n.text=$value", { value: huge });
    conn.query("MATCH (n:Scope {id:'scope-relate-current'}) SET n.validFrom=$value", { value: huge });
    conn.query("MATCH (n:EvidenceAssertion {id:'assert-rules-ai'}) SET n.currentness=$value", { value: huge });
    conn.query("MATCH (n:ModelRun {id:'model-run-official-sources'}) SET n.model=$value", { value: huge });
    conn.query("MATCH (n:Decision {id:'decision-relate-rules'}) SET n.uncertainty=$value", { value: huge });

    let report;
    assert.doesNotThrow(() => {
      report = buildCaseReportFromConnection(conn, "case-relate-rules");
    });
    assert.doesNotThrow(() => JSON.stringify(report));
    assert.equal(report.caseInventory.valid, false);
    assert.equal(report.liveConflicts.length, 0);
    const reasons = allReasons(report);
    for (const reason of [
      "DECISION_CASE_INTEGRITY_MISMATCH", "OPTION_INTEGRITY_MISMATCH", "CLAIM_CONTENT_INTEGRITY_MISMATCH",
      "PASSAGE_CONTENT_INTEGRITY_MISMATCH", "SCOPE_CONTENT_INTEGRITY_MISMATCH", "ASSERTION_CONTENT_INTEGRITY_MISMATCH",
      "MODEL_PROVENANCE_INTEGRITY_MISMATCH", "DECISION_CONTENT_INTEGRITY_MISMATCH"
    ]) assert.ok(reasons.has(reason), reason);

    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-ai-disclosure");
    assert.doesNotThrow(() => JSON.stringify(graph));
  });
});

for (const duplicate of [
  {
    name: "REVIEWED_BY",
    create:
      "MATCH (a:EvidenceAssertion {id:'assert-rules-ai'}), (r:Review {id:'review-official-sources'}) " +
      "CREATE (a)-[:REVIEWED_BY]->(r)",
    reason: "REVIEW_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "SUPPORTED_BY",
    create:
      "MATCH (c:Claim {id:'claim-ai-disclosure'}), (a:EvidenceAssertion {id:'assert-rules-ai'}) " +
      "CREATE (c)-[:SUPPORTED_BY]->(a)",
    reason: "CLAIM_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "EXTRACTED_FROM",
    create:
      "MATCH (p:Passage {id:'passage-rules-ai'}), (s:Source {id:'source-relate-rules'}) " +
      "CREATE (p)-[:EXTRACTED_FROM]->(s)",
    reason: "SOURCE_TOPOLOGY_COUNT_MISMATCH"
  }
]) {
  test(`duplicate ${duplicate.name} edges are excluded instead of multiplying evidence`, () => {
    withRulesStore((conn) => {
      const before = byClaim(buildCaseReportFromConnection(conn, "case-relate-rules"), "claim-ai-disclosure");
      assert.equal(before.supportCount, 1);

      conn.query(duplicate.create);
      const report = buildCaseReportFromConnection(conn, "case-relate-rules");
      const claim = byClaim(report, "claim-ai-disclosure");
      assert.equal(claim.supportCount, 0);
      assert.equal(claim.status, "UNKNOWN_NOT_PROVEN");
      assert.ok(claim.excluded.some((row) => row.exclusionReasons.includes(duplicate.reason)), `missing ${duplicate.reason}`);
      assert.equal(report.liveConflicts.some((item) => item.claimId === "claim-ai-disclosure"), false);
    });
  });
}

for (const duplicate of [
  {
    name: "SUMMARIZES",
    create:
      "MATCH (a:EvidenceAssertion {id:'assert-rules-ai'}), (p:Passage {id:'passage-rules-ai'}) " +
      "CREATE (a)-[:SUMMARIZES]->(p)",
    reason: "PASSAGE_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "APPLIES_WITHIN",
    create:
      "MATCH (a:EvidenceAssertion {id:'assert-rules-ai'}), (s:Scope {id:'scope-relate-current'}) " +
      "CREATE (a)-[:APPLIES_WITHIN]->(s)",
    reason: "SCOPE_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "FOR_CASE",
    create:
      "MATCH (s:Scope {id:'scope-relate-current'}), (dc:DecisionCase {id:'case-relate-rules'}) " +
      "CREATE (s)-[:FOR_CASE]->(dc)",
    reason: "SCOPE_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "GENERATED_BY",
    create:
      "MATCH (a:EvidenceAssertion {id:'assert-rules-ai'}), (m:ModelRun {id:'model-run-official-sources'}) " +
      "CREATE (a)-[:GENERATED_BY]->(m)",
    reason: "MODEL_TOPOLOGY_COUNT_MISMATCH"
  },
  {
    name: "AFFECTED",
    claimId: "claim-existing-extension",
    create:
      "MATCH (a:EvidenceAssertion {id:'assert-overview-extension'}), (d:Decision {id:'decision-relate-rules'}) " +
      "CREATE (a)-[:AFFECTED]->(d)",
    reason: "DECISION_TOPOLOGY_COUNT_MISMATCH"
  }
]) {
  test(`duplicate ${duplicate.name} single-cardinality edges are explicitly excluded`, () => {
    withRulesStore((conn) => {
      conn.query(duplicate.create);
      const report = buildCaseReportFromConnection(conn, "case-relate-rules");
      const claim = byClaim(report, duplicate.claimId || "claim-ai-disclosure");
      assert.equal(claim.status, duplicate.claimId ? "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE" : "UNKNOWN_NOT_PROVEN");
      assert.ok(claim.excluded.some((row) => row.exclusionReasons.includes(duplicate.reason)), `missing ${duplicate.reason}`);
    });
  });
}

for (const duplicate of [
  {
    name: "HAS_OPTION",
    create:
      "MATCH (dc:DecisionCase {id:'case-relate-rules'}), (o:Option {id:'option-rules-minimum'}) " +
      "CREATE (dc)-[:HAS_OPTION]->(o)",
    reason: "CASE_OPTION_BINDING_MISMATCH"
  },
  {
    name: "USES_CRITERION",
    create:
      "MATCH (dc:DecisionCase {id:'case-relate-rules'}), (c:Criterion {id:'criterion-project-age'}) " +
      "CREATE (dc)-[:USES_CRITERION]->(c)",
    reason: "CASE_CRITERION_BINDING_MISMATCH"
  },
  {
    name: "MAKES_CLAIM",
    create:
      "MATCH (o:Option {id:'option-rules-minimum'}), (c:Claim {id:'claim-ai-disclosure'}) " +
      "CREATE (o)-[:MAKES_CLAIM]->(c)",
    reason: "CASE_CLAIM_BINDING_MISMATCH"
  },
  {
    name: "RESULTED_IN",
    create:
      "MATCH (dc:DecisionCase {id:'case-relate-rules'}), (d:Decision {id:'decision-relate-rules'}) " +
      "CREATE (dc)-[:RESULTED_IN]->(d)",
    reason: "CASE_DECISION_BINDING_MISMATCH"
  }
]) {
  test(`duplicate ${duplicate.name} case-binding edges invalidate the whole case context`, () => {
    withRulesStore((conn) => {
      conn.query(duplicate.create);
      assertCaseInvalid(buildCaseReportFromConnection(conn, "case-relate-rules"), duplicate.reason);
    });
  });
}
