const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CheckpointAfterCommitError,
  buildCaseReportFromConnection,
  importDecisionPacketsIntoEmptyConnection,
  importDecisionPacketsToEmptyStore,
  listCases,
  openStore,
  queryClaimGraph
} = require("../src/evidence-graph.cjs");
const {
  InputValidationError,
  loadFixturePacket,
  parseStrictJson,
  resolveFixturePath,
  validateDecisionPacket
} = require("../src/decision-packet.cjs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempStore(prefix = "qendrova-phase3-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, storePath: path.join(root, "evidence.rl") };
}

function withImportedStore(callback) {
  const { root, storePath } = tempStore();
  try {
    const receipt = importDecisionPacketsToEmptyStore(storePath, [
      loadFixturePacket("laptop.synthetic.json"),
      loadFixturePacket("relate-rules.public.json")
    ]);
    return callback(storePath, receipt, receipt.connection);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("closed JSON schema rejects unknown structure, injection ids, unsafe URLs, and invalid dates", () => {
  const base = loadFixturePacket("laptop.synthetic.json");

  const topLevelCypher = clone(base);
  topLevelCypher.cypher = "MATCH (n) DELETE n";
  assert.throws(() => validateDecisionPacket(topLevelCypher), /packet\.cypher is not allowed/);

  const nestedRelationship = clone(base);
  nestedRelationship.assertions[0].relationshipType = "DELETES";
  assert.throws(() => validateDecisionPacket(nestedRelationship), /relationshipType is not allowed/);

  const suppliedFingerprint = clone(base);
  suppliedFingerprint.passages[0].fingerprint = "attacker-controlled";
  assert.throws(() => validateDecisionPacket(suppliedFingerprint), /fingerprint is not allowed/);

  const maliciousId = clone(base);
  maliciousId.claims[0].id = "claim-x'})-[:OWNS]->(secret";
  assert.throws(() => validateDecisionPacket(maliciousId), /lowercase hyphenated identifier/);

  const forbiddenPrototypeKey = clone(base);
  Object.defineProperty(forbiddenPrototypeKey.case, "__proto__", { enumerable: true, value: "blocked" });
  assert.throws(() => validateDecisionPacket(forbiddenPrototypeKey), /__proto__ is forbidden/);

  const rules = loadFixturePacket("relate-rules.public.json");
  const unsafeUrl = clone(rules);
  unsafeUrl.sources[0].url = "file:///private.txt";
  assert.throws(() => validateDecisionPacket(unsafeUrl), /must be HTTPS/);

  const credentialedUrl = clone(rules);
  credentialedUrl.sources[0].url = "https://user:pass@relate.devpost.com/";
  assert.throws(() => validateDecisionPacket(credentialedUrl), /without credentials/);

  const invalidDate = clone(rules);
  invalidDate.sources[0].checkedOn = "2026-02-30";
  assert.throws(() => validateDecisionPacket(invalidDate), /not a real calendar date/);

  const invalidTimestamp = clone(rules);
  invalidTimestamp.reviews[0].timestamp = "2026-02-30T20:00:00Z";
  assert.throws(() => validateDecisionPacket(invalidTimestamp), /real UTC ISO timestamp/);

  const wrongReviewSemantics = clone(rules);
  wrongReviewSemantics.reviews[0].result = "BOUND_TO_EXACT_PASSAGE";
  assert.throws(() => validateDecisionPacket(wrongReviewSemantics), /exact-passage semantics for a paraphrase/);

  const invertedDates = clone(rules);
  invertedDates.scopes[0].validFrom = "2026-12-18";
  assert.throws(() => validateDecisionPacket(invertedDates), /validFrom after validTo/);

  const oversized = clone(base);
  oversized.claims[0].text = "x".repeat(501);
  assert.throws(() => validateDecisionPacket(oversized), /exceeds 500 characters/);
});

test("schema rejects duplicate ids, duplicate evidence inflation, missing references, and fixture path traversal", () => {
  const base = loadFixturePacket("laptop.synthetic.json");

  const duplicateId = clone(base);
  duplicateId.claims[0].id = duplicateId.options[0].id;
  assert.throws(() => validateDecisionPacket(duplicateId), /duplicates id/);

  const duplicateBinding = clone(base);
  duplicateBinding.reviews.push({ ...clone(duplicateBinding.reviews[0]), id: "review-human-copy" });
  duplicateBinding.assertions.push({ ...clone(duplicateBinding.assertions[0]), id: "assert-repair-cost-copy", reviewId: "review-human-copy" });
  assert.throws(() => validateDecisionPacket(duplicateBinding), /duplicates an existing evidence binding/);

  const duplicatePassage = clone(base);
  duplicatePassage.passages.push({ ...clone(duplicatePassage.passages[0]), id: "passage-repair-cost-copy" });
  assert.throws(() => validateDecisionPacket(duplicatePassage), /duplicates the same source text/);

  const missingReference = clone(base);
  missingReference.assertions[0].scopeId = "scope-not-present";
  assert.throws(() => validateDecisionPacket(missingReference), /references unknown id/);

  assert.throws(() => resolveFixturePath("../package.json"), InputValidationError);
  assert.throws(() => resolveFixturePath("C:\\private\\payload.json"), InputValidationError);
  assert.throws(() => resolveFixturePath("not-allowlisted.json"), InputValidationError);
  assert.throws(() => parseStrictJson('{"schemaVersion":999,"schemaVersion":1}'), /duplicate JSON key/);

  const tooManyPaths = clone(base);
  for (let index = 0; index < 50; index += 1) {
    const suffix = String(index).padStart(2, "0");
    tooManyPaths.passages.push({
      id: `passage-extra-${suffix}`,
      sourceId: "source-repair-quote",
      text: `Unique synthetic evidence ${suffix}`,
      representation: "SYNTHETIC_VERBATIM",
      locator: `Synthetic line ${index + 2}`
    });
    tooManyPaths.assertions.push({
      id: `assert-extra-${suffix}`,
      claimId: "claim-repair-cost",
      passageId: `passage-extra-${suffix}`,
      scopeId: "scope-repair-v1",
      reviewId: "review-human-1",
      polarity: "SUPPORT",
      currentness: "CURRENT",
      encodingMethod: "HUMAN_BOUND",
      affectedDecision: false
    });
  }
  assert.throws(() => validateDecisionPacket(tooManyPaths), /exceeds the 50-path explorer limit/);
});

test("generic empty-store importer persists both cases with internal hashes and shared evaluator", () => {
  withImportedStore((storePath, receipt, conn) => {
    assert.equal(receipt.caseCount, 2);
    assert.equal(receipt.nodeCount, 70);
    assert.equal(receipt.receipts.length, 2);
    for (const item of receipt.receipts) assert.match(item.datasetHash, /^[0-9a-f]{64}$/);

    assert.deepEqual(listCases(conn).map((item) => item.caseId), ["case-laptop", "case-relate-rules"]);

    const laptop = buildCaseReportFromConnection(conn, "case-laptop");
    const laptopById = Object.fromEntries(laptop.claims.map((claim) => [claim.claimId, claim]));
    assert.equal(laptopById["claim-repair-cost"].status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(laptopById["claim-buy-budget"].status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(laptopById["claim-warranty"].status, "UNKNOWN_NOT_PROVEN");
    assert.equal(laptopById["claim-os-support"].status, "UNKNOWN_NOT_PROVEN");
    assert.equal(laptopById["claim-repair-cost"].matching[0].passageRelation, "QUOTES");

    const rules = buildCaseReportFromConnection(conn, "case-relate-rules");
    const rulesById = Object.fromEntries(rules.claims.map((claim) => [claim.claimId, claim]));
    assert.equal(rulesById["claim-existing-extension"].status, "CONFLICTING_MATCHING_CURRENT_EVIDENCE");
    assert.equal(rulesById["claim-video-only"].status, "CONFLICTING_MATCHING_CURRENT_EVIDENCE");
    assert.equal(rulesById["claim-cash-substitution"].status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(rulesById["claim-ai-disclosure"].status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(rulesById["claim-public-repo-topic"].status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(rulesById["claim-brand-only-privacy"].status, "UNKNOWN_NOT_PROVEN");
    assert.equal(rules.decisionAuthority.automaticApproval, false);
    assert.equal(rules.decision.selectedOption, "strict-combination");
    assert.equal(rulesById["claim-existing-extension"].matching[0].passageRepresentation, "PARAPHRASE");
    assert.ok(rulesById["claim-existing-extension"].matching.every((row) => row.passageRelation === "SUMMARIZES"));
    assert.ok(rulesById["claim-existing-extension"].matching.every((row) => row.sourceUrl.startsWith("https://relate.devpost.com")));
    assert.ok(rulesById["claim-existing-extension"].matching.every((row) => row.sourceCheckedOn === "2026-11-19"));
  });
});

test("import refuses a non-empty store and cross-packet collision leaves a new destination untouched", () => {
  withImportedStore((storePath, _receipt, conn) => {
    const before = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);
    assert.throws(
      () => importDecisionPacketsIntoEmptyConnection(conn, [loadFixturePacket("laptop.synthetic.json")]),
      /STORE_NOT_EMPTY/
    );
    const after = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);
    assert.equal(after, before);
  });

  const foreign = tempStore("qendrova-foreign-");
  try {
    const foreignConnection = openStore(foreign.storePath).connect();
    foreignConnection.query("CREATE (:Foreign {id:'foreign-node'})");
    assert.equal(foreignConnection.query("SHOW KEY CONSTRAINTS").rows.length, 0);
    assert.throws(
      () => importDecisionPacketsIntoEmptyConnection(foreignConnection, [loadFixturePacket("laptop.synthetic.json")]),
      /STORE_NOT_EMPTY/
    );
    assert.equal(foreignConnection.query("SHOW KEY CONSTRAINTS").rows.length, 0);
    assert.equal(Number(foreignConnection.query("MATCH (n) RETURN count(n) AS count").single().count), 1);
  } finally {
    fs.rmSync(foreign.root, { recursive: true, force: true });
  }

  const { root, storePath } = tempStore("qendrova-collision-");
  try {
    const laptop = loadFixturePacket("laptop.synthetic.json");
    const rules = clone(loadFixturePacket("relate-rules.public.json"));
    rules.case.id = "case-laptop";
    assert.throws(() => importDecisionPacketsToEmptyStore(storePath, [laptop, rules]), /duplicate id across packets/);
    assert.equal(fs.existsSync(storePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint failure is reported honestly after commit without a false rollback claim", () => {
  const { root, storePath } = tempStore("qendrova-checkpoint-");
  try {
    const conn = openStore(storePath).connect();
    let captured;
    try {
      importDecisionPacketsIntoEmptyConnection(conn, [loadFixturePacket("laptop.synthetic.json")], () => {
        throw new Error("simulated checkpoint failure");
      });
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof CheckpointAfterCommitError);
    assert.equal(captured.committed, true);
    assert.match(captured.recovery, /Reopen the store/);
    assert.equal(Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count), 36);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live conflicts use the same passage-pairing and source-path checks as claim evaluation", () => {
  withImportedStore((_storePath, _receipt, conn) => {
    const before = buildCaseReportFromConnection(conn, "case-relate-rules");
    assert.ok(before.liveConflicts.some((item) => item.claimId === "claim-existing-extension"));
    assert.ok(before.liveConflicts.some((item) => item.claimId === "claim-video-only"));

    conn.query(
      "MATCH (a:EvidenceAssertion {id:'assert-overview-extension'})-[binding:SUMMARIZES]->(p:Passage) " +
        "DELETE binding CREATE (a)-[:QUOTES]->(p)"
    );
    conn.query(
      "MATCH (p:Passage {id:'passage-overview-video'})-[binding:EXTRACTED_FROM]->(:Source) DELETE binding"
    );
    const after = buildCaseReportFromConnection(conn, "case-relate-rules");
    const byId = Object.fromEntries(after.claims.map((claim) => [claim.claimId, claim]));
    assert.equal(byId["claim-existing-extension"].status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.ok(byId["claim-existing-extension"].excluded.some((row) => row.exclusionReasons.includes("INVALID_PASSAGE_BINDING")));
    assert.equal(byId["claim-video-only"].status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(after.liveConflicts.some((item) => item.claimId === "claim-existing-extension"), false);
    assert.equal(after.liveConflicts.some((item) => item.claimId === "claim-video-only"), false);
  });
});

test("stored expected references expose source and assertion rebinds instead of counting them", () => {
  withImportedStore((_storePath, _receipt, conn) => {
    conn.query(
      "MATCH (p:Passage {id:'passage-overview-extension'})-[binding:EXTRACTED_FROM]->(:Source) " +
        "MATCH (wrong:Source {id:'source-relate-rules'}) DELETE binding CREATE (p)-[:EXTRACTED_FROM]->(wrong)"
    );
    conn.query(
      "MATCH (a:EvidenceAssertion {id:'assert-rules-ai'})-[binding:SUMMARIZES]->(:Passage) " +
        "MATCH (wrong:Passage {id:'passage-rules-public-repo'}) DELETE binding CREATE (a)-[:SUMMARIZES]->(wrong)"
    );
    const report = buildCaseReportFromConnection(conn, "case-relate-rules");
    const byId = Object.fromEntries(report.claims.map((claim) => [claim.claimId, claim]));
    assert.equal(byId["claim-existing-extension"].status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.ok(byId["claim-existing-extension"].excluded.some((row) => row.exclusionReasons.includes("PASSAGE_SOURCE_BINDING_MISMATCH")));
    assert.equal(byId["claim-ai-disclosure"].status, "UNKNOWN_NOT_PROVEN");
    assert.ok(byId["claim-ai-disclosure"].excluded.some((row) => row.exclusionReasons.includes("ASSERTION_PASSAGE_BINDING_MISMATCH")));
    assert.equal(report.liveConflicts.some((item) => item.claimId === "claim-existing-extension"), false);
  });
});

test("canonical node envelopes expose semantic property tampering in reports and runtime graph entities", () => {
  withImportedStore((_storePath, _receipt, conn) => {
    conn.query("MATCH (n:DecisionCase {id:'case-relate-rules'}) SET n.title='Tampered case title'");
    conn.query("MATCH (n:Option {id:'option-rules-minimum'}) SET n.label='Tampered option label'");
    conn.query("MATCH (n:Claim {id:'claim-ai-disclosure'}) SET n.text='Tampered proposition'");
    conn.query("MATCH (n:Source {id:'source-relate-overview'}) SET n.url='https://relate.devpost.com/tampered'");
    conn.query("MATCH (n:Passage {id:'passage-rules-no-cash'}) SET n.locator='Tampered locator'");
    conn.query("MATCH (n:Scope {id:'scope-relate-current'}) SET n.validTo='2026-12-16'");
    conn.query("MATCH (n:EvidenceAssertion {id:'assert-rules-public-repo'}) SET n.encodingMethod='TAMPERED'");
    conn.query("MATCH (n:Review {id:'review-official-sources'}) SET n.result='BOUND_TO_EXACT_PASSAGE'");
    conn.query("MATCH (n:ModelRun {id:'model-run-official-sources'}) SET n.promptVersion='tampered'");
    conn.query("MATCH (n:Decision {id:'decision-relate-rules'}) SET n.uncertainty='Tampered decision text'");

    const report = buildCaseReportFromConnection(conn, "case-relate-rules");
    assert.equal(report.case.integrityValid, false);
    assert.equal(report.case.integrityReason, "DECISION_CASE_INTEGRITY_MISMATCH");
    assert.equal(report.decision.integrityValid, false);
    assert.equal(report.decision.integrityReason, "DECISION_CONTENT_INTEGRITY_MISMATCH");
    const byId = Object.fromEntries(report.claims.map((claim) => [claim.claimId, claim]));
    const allReasons = (claimId) => byId[claimId].excluded.flatMap((row) => row.exclusionReasons);
    assert.ok(allReasons("claim-ai-disclosure").includes("CLAIM_CONTENT_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-existing-extension").includes("SOURCE_PROVENANCE_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-cash-substitution").includes("PASSAGE_CONTENT_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-public-repo-topic").includes("ASSERTION_CONTENT_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("REVIEW_SEMANTICS_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("SCOPE_CONTENT_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("OPTION_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("DECISION_CASE_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("MODEL_PROVENANCE_INTEGRITY_MISMATCH"));
    assert.ok(allReasons("claim-video-only").includes("DECISION_CONTENT_INTEGRITY_MISMATCH"));
    assert.equal(report.liveConflicts.length, 0);

    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-cash-substitution");
    const badLabels = new Set(
      graph.inventory.nodes.filter((node) => !node.integrityValid).flatMap((node) => node.labels)
    );
    for (const label of ["DecisionCase", "Option", "Passage", "Scope", "Review", "ModelRun"]) {
      assert.ok(badLabels.has(label), label);
    }
  });
});

test("graph explorer serializes actual Relate paths and disappears when a required edge is removed", () => {
  withImportedStore((storePath, _receipt, conn) => {
    const graph = queryClaimGraph(conn, "case-relate-rules", "claim-existing-extension");
    assert.equal(graph.queryId, "RELATE_EVIDENCE_TRACE_V1");
    assert.deepEqual(graph.parameters, { caseId: "case-relate-rules", claimId: "claim-existing-extension" });
    assert.equal(graph.paths.length, 2);
    assert.ok(graph.inventory.nodes.every((node) => node.kind === "node" && node.elementId));
    assert.ok(graph.inventory.relationships.every((relationship) => relationship.kind === "relationship" && relationship.elementId));
    const relationshipTypes = new Set(graph.inventory.relationships.map((relationship) => relationship.type));
    for (const type of ["HAS_OPTION", "MAKES_CLAIM", "SUPPORTED_BY", "CONTRADICTED_BY", "SUMMARIZES", "EXTRACTED_FROM", "APPLIES_WITHIN", "FOR_CASE", "REVIEWED_BY"]) {
      assert.ok(relationshipTypes.has(type), type);
    }
    const orderedKinds = graph.paths[0].evidencePath.map((entity) => entity.kind);
    assert.deepEqual(orderedKinds, ["node", "relationship", "node", "relationship", "node", "relationship", "node", "relationship", "node", "relationship", "node"]);

    conn.query(
      "MATCH (:EvidenceAssertion {id:'assert-rules-no-cash'})-[binding:REVIEWED_BY]->(:Review) DELETE binding"
    );
    const removed = queryClaimGraph(conn, "case-relate-rules", "claim-cash-substitution");
    assert.equal(removed.paths.length, 0);
    assert.equal(removed.inventory.nodes.length, 0);
    const report = buildCaseReportFromConnection(conn, "case-relate-rules");
    assert.equal(report.claims.find((claim) => claim.claimId === "claim-cash-substitution").status, "UNKNOWN_NOT_PROVEN");
  });
});

test("free text is parameterized data while structural Cypher remains fixed", () => {
  const { root, storePath } = tempStore("qendrova-text-");
  try {
    const packet = clone(loadFixturePacket("laptop.synthetic.json"));
    packet.claims[0].text = "<script>alert('x')</script> MATCH (n) DELETE n";
    const receipt = importDecisionPacketsToEmptyStore(storePath, [packet]);
    assert.equal(receipt.nodeCount, 36);
    const conn = receipt.connection;
    const row = conn.query(
      "MATCH (c:Claim {id:$id}) RETURN c.text AS text",
      { id: "claim-repair-cost" }
    ).single();
    assert.equal(row.text, packet.claims[0].text);
    assert.equal(Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count), 36);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
