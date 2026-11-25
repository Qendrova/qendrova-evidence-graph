const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Database } = require("@relate/relate");
const {
  InputValidationError,
  loadPrivateFixturePackets,
  parseIsoDate,
  parseIsoInstant,
  validateDecisionPacket
} = require("./decision-packet.cjs");

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COUNTING_REVIEW_RESULTS = new Set(["BOUND_TO_EXACT_PASSAGE", "PARAPHRASE_CHECKED_AGAINST_LOCATOR"]);
const NODE_LABELS = new Set([
  "DecisionCase", "Option", "Criterion", "Claim", "Source", "Passage",
  "Scope", "EvidenceAssertion", "Review", "ModelRun", "Decision"
]);
const RELATIONSHIP_TYPES = new Set([
  "HAS_OPTION", "USES_CRITERION", "MAKES_CLAIM", "SUPPORTED_BY", "CONTRADICTED_BY",
  "QUOTES", "SUMMARIZES", "EXTRACTED_FROM", "APPLIES_WITHIN", "FOR_CASE",
  "REVIEWED_BY", "GENERATED_BY", "RESULTED_IN", "AFFECTED"
]);
const RUNTIME_ENUMS = Object.freeze({
  DecisionCase: { status: new Set(["UNDER_REVIEW", "DECIDED", "HOLD"]) },
  Claim: { status: new Set(["OPEN", "RESOLVED"]) },
  Source: { sourceType: new Set(["QUOTE", "OFFER", "REVIEW", "DOCUMENTATION", "TERMS", "OFFICIAL_OVERVIEW", "OFFICIAL_RULES"]) },
  Passage: { representation: new Set(["SYNTHETIC_VERBATIM", "PARAPHRASE", "EXACT_EXCERPT"]) },
  EvidenceAssertion: {
    polarity: new Set(["SUPPORT", "CONTRADICT"]),
    currentness: new Set(["CURRENT", "STALE"]),
    encodingMethod: new Set(["HUMAN_BOUND", "DETERMINISTIC_IMPORT", "AI_ASSISTED_BOUND"])
  },
  Review: {
    reviewerType: new Set(["HUMAN", "DETERMINISTIC", "AI_ASSISTED"]),
    result: new Set([
      "BOUND_TO_EXACT_PASSAGE", "PARAPHRASE_CHECKED_AGAINST_LOCATOR", "CONTEXT_ONLY", "REJECTED", "NEEDS_REVIEW"
    ])
  }
});
const GRAPH_QUERY_ID = "RELATE_EVIDENCE_TRACE_V1";
const GRAPH_QUERY_DESCRIPTION =
  "A fixed parameterized Relate query follows DecisionCase to Option to Claim to EvidenceAssertion, " +
  "then the stored passage and source, and separately requires the assertion scope to return to the " +
  "same decision case plus a bound review record; recorded model provenance and decision effect are included when present.";
const NODE_INTEGRITY_FIELDS = Object.freeze({
  DecisionCase: [
    "id", "title", "deadline", "status", "object", "version", "runId", "asOf", "schemaVersion", "datasetHash",
    "expectedOptionIds", "expectedCriterionIds", "expectedClaimIds", "expectedNodeIds"
  ],
  Option: ["id", "label", "position", "caseId"],
  Criterion: ["id", "label", "hardBoundary", "caseId"],
  Claim: ["id", "text", "position", "status", "optionId", "caseId"],
  Source: ["id", "title", "publisher", "sourceType", "official", "url", "checkedOn", "caseId"],
  Passage: ["id", "text", "fingerprint", "representation", "locator", "sourceId", "caseId"],
  Scope: ["id", "object", "version", "position", "runId", "caseId", "validFrom", "validTo"],
  EvidenceAssertion: [
    "id", "polarity", "currentness", "encodingMethod", "expectedClaimId", "expectedPassageId",
    "expectedScopeId", "expectedReviewId", "expectedModelRunId", "expectedDecisionId", "caseId"
  ],
  Review: ["id", "reviewerType", "result", "timestamp", "note", "caseId"],
  ModelRun: ["id", "tool", "model", "timestamp", "promptVersion", "caseId"],
  Decision: ["id", "selectedOption", "selectedOptionId", "decidedAt", "revisitAt", "uncertainty", "caseId"]
});
const INTEGRITY_REASON = Object.freeze({
  DecisionCase: "DECISION_CASE_INTEGRITY_MISMATCH",
  Option: "OPTION_INTEGRITY_MISMATCH",
  Criterion: "CRITERION_INTEGRITY_MISMATCH",
  Claim: "CLAIM_CONTENT_INTEGRITY_MISMATCH",
  Source: "SOURCE_PROVENANCE_INTEGRITY_MISMATCH",
  Passage: "PASSAGE_CONTENT_INTEGRITY_MISMATCH",
  Scope: "SCOPE_CONTENT_INTEGRITY_MISMATCH",
  EvidenceAssertion: "ASSERTION_CONTENT_INTEGRITY_MISMATCH",
  Review: "REVIEW_SEMANTICS_INTEGRITY_MISMATCH",
  ModelRun: "MODEL_PROVENANCE_INTEGRITY_MISMATCH",
  Decision: "DECISION_CONTENT_INTEGRITY_MISMATCH"
});

class CheckpointAfterCommitError extends Error {
  constructor(cause) {
    super("COMMITTED_CHECKPOINT_FAILED: graph transaction committed, but persistence checkpoint failed; reopen and verify before retrying");
    this.name = "CheckpointAfterCommitError";
    this.committed = true;
    this.recovery = "Reopen the store, verify the imported case hashes and node count, then checkpoint before any retry.";
    this.cause = cause;
  }
}

function checkedName(value, kind) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) throw new Error(`Unsafe ${kind}: ${value}`);
  return value;
}

function checkedId(value, kind = "id") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new InputValidationError(`${kind} is invalid`);
  return value;
}

function openStore(storePath, options = {}) {
  const absolute = path.resolve(storePath);
  if (!options.readOnly) fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return Database.open(absolute, options);
}

function validateRequestedScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new InputValidationError("requestedScope must be an object");
  const allowed = new Set(["object", "version", "position", "runId", "caseId", "asOf"]);
  for (const key of Object.keys(scope)) if (!allowed.has(key)) throw new InputValidationError(`requestedScope.${key} is not allowed`);
  for (const key of ["object", "version", "position", "runId", "caseId"]) checkedId(scope[key], `requestedScope.${key}`);
  parseIsoDate(scope.asOf, "requestedScope.asOf");
  return scope;
}

function safeIsoDate(value, fallback = "1970-01-01") {
  try {
    parseIsoDate(value, "date");
    return value;
  } catch (_error) {
    return fallback;
  }
}

function ensureSchema(conn) {
  for (const label of NODE_LABELS) {
    const constraintName = `${label.toLowerCase()}_id_key`;
    conn.query(`CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS NODE KEY`);
  }
}

function createNode(conn, label, properties) {
  if (!NODE_LABELS.has(label)) throw new Error(`Node label is not allowlisted: ${label}`);
  const withIntegrity = { ...properties, integrityHash: nodeIntegrityHash(label, properties) };
  const fields = Object.keys(withIntegrity).map((key) => {
    checkedName(key, "property");
    return `${key}: $${key}`;
  });
  conn.query(`CREATE (n:${label} {${fields.join(", ")}})`, withIntegrity);
}

function createRelationship(conn, fromLabel, fromId, type, toLabel, toId) {
  if (!NODE_LABELS.has(fromLabel) || !NODE_LABELS.has(toLabel)) throw new Error("Relationship label is not allowlisted");
  if (!RELATIONSHIP_TYPES.has(type)) throw new Error(`Relationship type is not allowlisted: ${type}`);
  conn.query(
    `MATCH (a:${fromLabel} {id: $fromId}), (b:${toLabel} {id: $toId}) CREATE (a)-[:${type}]->(b)`,
    { fromId, toId }
  );
}

function fingerprint(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function taggedCanonicalValue(value, present = true) {
  if (!present) return ["missing"];
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return Number.isFinite(value) ? ["number", value] : ["nonfinite-number", String(value)];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "undefined") return ["undefined"];
  return ["unsupported", typeof value, Object.prototype.toString.call(value)];
}

function nodeIntegrityHash(label, properties) {
  const fields = NODE_INTEGRITY_FIELDS[label];
  if (!fields) throw new Error(`No integrity schema for label ${label}`);
  const canonical = fields.map((field) => [field, taggedCanonicalValue(properties[field], Object.hasOwn(properties, field))]);
  return fingerprint(JSON.stringify(canonical));
}

function runtimeNodeDomainValid(label, properties) {
  const fields = NODE_INTEGRITY_FIELDS[label] || [];
  const optional = label === "Source" ? new Set(["url", "checkedOn"]) : new Set();
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const actualKeys = Object.keys(properties).sort();
  const expectedKeys = fields.filter((field) => !optional.has(field) || Object.hasOwn(properties, field));
  expectedKeys.push("integrityHash");
  expectedKeys.sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  if (label === "Source" && Object.hasOwn(properties, "url") !== Object.hasOwn(properties, "checkedOn")) return false;
  for (const field of fields) {
    if (!Object.hasOwn(properties, field)) {
      if (optional.has(field)) continue;
      return false;
    }
    const value = properties[field];
    if ((label === "Criterion" && field === "hardBoundary") || (label === "Source" && field === "official")) {
      if (typeof value !== "boolean") return false;
    } else if (label === "DecisionCase" && field === "schemaVersion") {
      if (!Number.isInteger(value) || value !== 1) return false;
    } else if (typeof value !== "string") {
      return false;
    }
  }
  const enums = RUNTIME_ENUMS[label] || {};
  for (const [field, allowed] of Object.entries(enums)) if (!allowed.has(properties[field])) return false;
  const idFields = fields.filter((field) => field === "id" || field === "caseId" || field === "optionId" || field === "sourceId" || field.startsWith("expected") && field.endsWith("Id") || field === "selectedOptionId");
  for (const field of idFields) {
    const value = properties[field];
    if ((field === "expectedModelRunId" || field === "expectedDecisionId") && value === "") continue;
    if (!SAFE_ID.test(value)) return false;
  }
  if (label === "DecisionCase") {
    for (const field of ["object", "version", "runId"]) if (!SAFE_ID.test(properties[field])) return false;
    for (const field of ["expectedOptionIds", "expectedCriterionIds", "expectedClaimIds", "expectedNodeIds"]) {
      if (!properties[field].split("|").every((value) => SAFE_ID.test(value))) return false;
    }
  }
  if (label === "Option" && !SAFE_ID.test(properties.position)) return false;
  if (label === "Claim" && !SAFE_ID.test(properties.position)) return false;
  if (label === "Scope") {
    for (const field of ["object", "version", "position", "runId"]) if (!SAFE_ID.test(properties[field])) return false;
  }
  if (label === "Passage" && !/^[0-9a-f]{64}$/.test(properties.fingerprint)) return false;
  if (typeof properties.integrityHash !== "string" || !/^[0-9a-f]{64}$/.test(properties.integrityHash)) return false;
  try {
    if (label === "DecisionCase") {
      parseIsoDate(properties.deadline, "deadline");
      parseIsoDate(properties.asOf, "asOf");
    } else if (label === "Source" && Object.hasOwn(properties, "url")) {
      const url = new URL(properties.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
      parseIsoDate(properties.checkedOn, "checkedOn");
    } else if (label === "Scope") {
      const from = parseIsoDate(properties.validFrom, "validFrom");
      const to = parseIsoDate(properties.validTo, "validTo");
      if (from > to) return false;
    } else if (label === "Review" || label === "ModelRun") {
      parseIsoInstant(properties.timestamp, "timestamp");
    } else if (label === "Decision") {
      parseIsoDate(properties.decidedAt, "decidedAt");
      parseIsoDate(properties.revisitAt, "revisitAt");
    }
  } catch (_error) {
    return false;
  }
  return true;
}

function verifyNodeProperties(label, properties, labels = [label]) {
  try {
    if (!NODE_LABELS.has(label) || !Array.isArray(labels) || labels.length !== 1 || labels[0] !== label) {
      return { valid: false, reason: INTEGRITY_REASON[label] || "UNKNOWN_NODE_SCHEMA", expectedHash: null, actualHash: null };
    }
    const expected = properties?.integrityHash;
    const actual = nodeIntegrityHash(label, properties || {});
    const valid = runtimeNodeDomainValid(label, properties || {}) && expected === actual;
    return { valid, reason: INTEGRITY_REASON[label], expectedHash: typeof expected === "string" ? expected : null, actualHash: actual };
  } catch (_error) {
    return { valid: false, reason: INTEGRITY_REASON[label], expectedHash: null, actualHash: null };
  }
}

function nodeIntegrityStatus(conn, label, id, cache = null) {
  const key = `${label}:${id}`;
  if (cache?.has(key)) return cache.get(key);
  if (!NODE_LABELS.has(label)) throw new Error(`Node label is not allowlisted: ${label}`);
  const rows = conn.query(`MATCH (n:${label} {id:$id}) RETURN n AS node`, { id }).rows;
  const status = rows.length
    ? verifyNodeProperties(label, rows[0].node.properties, rows[0].node.labels)
    : { valid: false, reason: INTEGRITY_REASON[label], expectedHash: null, actualHash: null };
  if (cache) cache.set(key, status);
  return status;
}

function manifestIds(value) {
  return typeof value === "string" && value.length > 0 ? value.split("|").sort() : [];
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function relationshipTargets(conn, caseId, type, targetLabel) {
  checkedName(type, "relationship type");
  if (!RELATIONSHIP_TYPES.has(type) || !NODE_LABELS.has(targetLabel)) throw new Error("Case inventory relationship is not allowlisted");
  return conn.query(
    `MATCH (dc:DecisionCase {id:$caseId})-[binding:${type}]->(target) RETURN target AS node ORDER BY target.id`,
    { caseId }
  ).rows.map((row) => row.node);
}

function auditCaseInventory(conn, caseId) {
  checkedId(caseId, "caseId");
  const caseRows = conn.query("MATCH (dc:DecisionCase {id:$caseId}) RETURN dc AS node", { caseId }).rows;
  if (caseRows.length !== 1) {
    return {
      valid: false,
      reasons: ["CASE_NODE_INVENTORY_MISMATCH"],
      expectedNodeIds: [],
      actualNodeIds: [],
      nodes: [],
      options: [],
      criteria: [],
      claims: []
    };
  }
  const caseNode = caseRows[0].node;
  const relatedRows = conn.query("MATCH (n) WHERE n.caseId = $caseId RETURN n AS node ORDER BY n.id", { caseId }).rows;
  const rawNodes = [caseNode, ...relatedRows.map((row) => row.node)];
  const reasons = [];
  const nodes = [];
  for (const node of rawNodes) {
    const recognized = node.labels.filter((label) => NODE_LABELS.has(label));
    const label = recognized.length === 1 ? recognized[0] : node.labels[0];
    const integrity = verifyNodeProperties(label, node.properties, node.labels);
    if (!integrity.valid) {
      reasons.push("CASE_NODE_INTEGRITY_MISMATCH");
      reasons.push(integrity.reason || "UNKNOWN_NODE_SCHEMA");
    }
    if (label !== "DecisionCase" && node.properties.caseId !== caseId) reasons.push("CASE_NODE_INVENTORY_MISMATCH");
    nodes.push({
      label: typeof label === "string" ? label : "UNKNOWN",
      labels: node.labels.map((item) => String(item)),
      id: jsonSafeValue(node.properties.id),
      integrityValid: integrity.valid,
      integrityReason: integrity.valid ? null : integrity.reason
    });
  }

  const expectedNodeIds = manifestIds(caseNode.properties.expectedNodeIds);
  const actualNodeIds = rawNodes.map((node) => node.properties.id).filter((id) => typeof id === "string").sort();
  if (!sameStringList(actualNodeIds, expectedNodeIds)) reasons.push("CASE_NODE_INVENTORY_MISMATCH");

  const expectedOptionIds = manifestIds(caseNode.properties.expectedOptionIds);
  const optionTargets = relationshipTargets(conn, caseId, "HAS_OPTION", "Option");
  const options = optionTargets.map((node) => node.properties.id);
  if (!sameStringList([...options].sort(), expectedOptionIds) || optionTargets.some((node) => node.labels.length !== 1 || node.labels[0] !== "Option")) {
    reasons.push("CASE_OPTION_BINDING_MISMATCH");
  }

  const expectedCriterionIds = manifestIds(caseNode.properties.expectedCriterionIds);
  const criterionTargets = relationshipTargets(conn, caseId, "USES_CRITERION", "Criterion");
  const criteria = criterionTargets.map((node) => node.properties.id);
  if (!sameStringList([...criteria].sort(), expectedCriterionIds) || criterionTargets.some((node) => node.labels.length !== 1 || node.labels[0] !== "Criterion")) {
    reasons.push("CASE_CRITERION_BINDING_MISMATCH");
  }

  const claims = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(option)-[:MAKES_CLAIM]->(claim) " +
      "RETURN option AS optionNode, claim AS claimNode ORDER BY claim.id",
    { caseId }
  ).rows;
  const expectedClaimIds = manifestIds(caseNode.properties.expectedClaimIds);
  if (!sameStringList(claims.map((row) => row.claimNode.properties.id).sort(), expectedClaimIds) ||
      claims.some((row) => row.optionNode.labels.length !== 1 || row.optionNode.labels[0] !== "Option" ||
        row.claimNode.labels.length !== 1 || row.claimNode.labels[0] !== "Claim" ||
        row.optionNode.properties.id !== row.claimNode.properties.optionId || row.claimNode.properties.caseId !== caseId)) {
    reasons.push("CASE_CLAIM_BINDING_MISMATCH");
  }

  const decisions = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId})-[binding:RESULTED_IN]->(decision) RETURN decision AS node",
    { caseId }
  ).rows;
  if (decisions.length !== 1 || decisions[0].node.labels.length !== 1 || decisions[0].node.labels[0] !== "Decision" ||
      decisions[0].node.properties.caseId !== caseId) reasons.push("CASE_DECISION_BINDING_MISMATCH");

  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)],
    expectedNodeIds,
    actualNodeIds: actualNodeIds.map(jsonSafeValue),
    nodes,
    options: options.map(jsonSafeValue),
    criteria: criteria.map(jsonSafeValue),
    claims: claims.map((row) => ({
      optionId: jsonSafeValue(row.optionNode.properties.id),
      id: jsonSafeValue(row.claimNode.properties.id),
      storedOptionId: jsonSafeValue(row.claimNode.properties.optionId),
      storedCaseId: jsonSafeValue(row.claimNode.properties.caseId)
    })),
    decisions: decisions.map((row) => ({
      id: jsonSafeValue(row.node.properties.id),
      storedCaseId: jsonSafeValue(row.node.properties.caseId),
      labels: row.node.labels.map(String)
    }))
  };
}

function packetHash(packet) {
  return fingerprint(JSON.stringify(packet));
}

function packetIds(packet) {
  return [
    packet.case.id,
    ...packet.options.map((item) => item.id),
    ...packet.criteria.map((item) => item.id),
    ...packet.claims.map((item) => item.id),
    ...packet.sources.map((item) => item.id),
    ...packet.passages.map((item) => item.id),
    ...packet.scopes.map((item) => item.id),
    ...packet.assertions.map((item) => item.id),
    ...packet.reviews.map((item) => item.id),
    ...packet.modelRuns.map((item) => item.id),
    packet.decision.id
  ];
}

function validatePacketSet(packets) {
  if (!Array.isArray(packets) || packets.length === 0 || packets.length > 10) {
    throw new InputValidationError("packets must contain 1-10 decision packets");
  }
  const validated = packets.map(validateDecisionPacket);
  const seen = new Set();
  for (const packet of validated) {
    for (const id of packetIds(packet)) {
      if (seen.has(id)) throw new InputValidationError(`duplicate id across packets: ${id}`);
      seen.add(id);
    }
  }
  return validated;
}

function importPacketIntoConnection(conn, packet) {
  const optionById = new Map(packet.options.map((item) => [item.id, item]));
  const passageById = new Map(packet.passages.map((item) => [item.id, item]));
  const datasetHash = packetHash(packet);
  const expectedOptionIds = packet.options.map((item) => item.id).sort().join("|");
  const expectedCriterionIds = packet.criteria.map((item) => item.id).sort().join("|");
  const expectedClaimIds = packet.claims.map((item) => item.id).sort().join("|");
  const expectedNodeIds = packetIds(packet).sort().join("|");
  createNode(conn, "DecisionCase", {
    id: packet.case.id,
    title: packet.case.title,
    deadline: packet.case.deadline,
    status: packet.case.status,
    object: packet.case.evaluation.object,
    version: packet.case.evaluation.version,
    runId: packet.case.evaluation.runId,
    asOf: packet.case.evaluation.asOf,
    schemaVersion: packet.schemaVersion,
    datasetHash,
    expectedOptionIds,
    expectedCriterionIds,
    expectedClaimIds,
    expectedNodeIds
  });
  for (const item of packet.options) createNode(conn, "Option", { id: item.id, label: item.label, position: item.position, caseId: packet.case.id });
  for (const item of packet.criteria) createNode(conn, "Criterion", { id: item.id, label: item.label, hardBoundary: item.hardBoundary, caseId: packet.case.id });
  for (const item of packet.claims) {
    createNode(conn, "Claim", {
      id: item.id,
      text: item.text,
      position: optionById.get(item.optionId).position,
      status: item.status,
      optionId: item.optionId,
      caseId: packet.case.id
    });
  }
  for (const item of packet.sources) {
    const properties = {
      id: item.id,
      title: item.title,
      publisher: item.publisher,
      sourceType: item.sourceType,
      official: item.official,
      caseId: packet.case.id
    };
    if (item.url) {
      properties.url = item.url;
      properties.checkedOn = item.checkedOn;
    }
    createNode(conn, "Source", properties);
  }
  for (const item of packet.passages) {
    createNode(conn, "Passage", {
      id: item.id,
      text: item.text,
      fingerprint: fingerprint(item.text),
      representation: item.representation,
      locator: item.locator,
      sourceId: item.sourceId,
      caseId: packet.case.id
    });
  }
  for (const item of packet.scopes) {
    createNode(conn, "Scope", {
      id: item.id,
      object: item.object,
      version: item.version,
      position: item.position,
      runId: item.runId,
      caseId: packet.case.id,
      validFrom: item.validFrom,
      validTo: item.validTo
    });
  }
  for (const item of packet.assertions) {
    createNode(conn, "EvidenceAssertion", {
      id: item.id,
      polarity: item.polarity,
      currentness: item.currentness,
      encodingMethod: item.encodingMethod,
      expectedClaimId: item.claimId,
      expectedPassageId: item.passageId,
      expectedScopeId: item.scopeId,
      expectedReviewId: item.reviewId,
      expectedModelRunId: item.modelRunId || "",
      expectedDecisionId: item.affectedDecision ? packet.decision.id : "",
      caseId: packet.case.id
    });
  }
  for (const item of packet.reviews) createNode(conn, "Review", { ...item, caseId: packet.case.id });
  for (const item of packet.modelRuns) createNode(conn, "ModelRun", { ...item, caseId: packet.case.id });
  const selectedOption = optionById.get(packet.decision.selectedOptionId);
  createNode(conn, "Decision", {
    id: packet.decision.id,
    selectedOption: selectedOption.position,
    selectedOptionId: selectedOption.id,
    decidedAt: packet.decision.decidedAt,
    revisitAt: packet.decision.revisitAt,
    uncertainty: packet.decision.uncertainty,
    caseId: packet.case.id
  });

  for (const item of packet.options) createRelationship(conn, "DecisionCase", packet.case.id, "HAS_OPTION", "Option", item.id);
  for (const item of packet.criteria) createRelationship(conn, "DecisionCase", packet.case.id, "USES_CRITERION", "Criterion", item.id);
  for (const item of packet.claims) createRelationship(conn, "Option", item.optionId, "MAKES_CLAIM", "Claim", item.id);
  for (const item of packet.passages) createRelationship(conn, "Passage", item.id, "EXTRACTED_FROM", "Source", item.sourceId);
  for (const item of packet.scopes) createRelationship(conn, "Scope", item.id, "FOR_CASE", "DecisionCase", packet.case.id);
  for (const item of packet.assertions) {
    const claimRelation = item.polarity === "SUPPORT" ? "SUPPORTED_BY" : "CONTRADICTED_BY";
    const passageRelation = passageById.get(item.passageId).representation === "PARAPHRASE" ? "SUMMARIZES" : "QUOTES";
    createRelationship(conn, "Claim", item.claimId, claimRelation, "EvidenceAssertion", item.id);
    createRelationship(conn, "EvidenceAssertion", item.id, passageRelation, "Passage", item.passageId);
    createRelationship(conn, "EvidenceAssertion", item.id, "APPLIES_WITHIN", "Scope", item.scopeId);
    createRelationship(conn, "EvidenceAssertion", item.id, "REVIEWED_BY", "Review", item.reviewId);
    if (item.modelRunId) createRelationship(conn, "EvidenceAssertion", item.id, "GENERATED_BY", "ModelRun", item.modelRunId);
    if (item.affectedDecision) createRelationship(conn, "EvidenceAssertion", item.id, "AFFECTED", "Decision", packet.decision.id);
  }
  createRelationship(conn, "DecisionCase", packet.case.id, "RESULTED_IN", "Decision", packet.decision.id);
  return { caseId: packet.case.id, datasetHash };
}

function importDecisionPacketsIntoEmptyConnection(conn, packets, checkpoint = null) {
  const validated = validatePacketSet(packets);
  const before = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);
  if (before !== 0) throw new InputValidationError("STORE_NOT_EMPTY: imports require a new empty store");
  ensureSchema(conn);
  const receipts = [];
  conn.begin();
  try {
    for (const packet of validated) receipts.push(importPacketIntoConnection(conn, packet));
    conn.commit();
  } catch (error) {
    conn.rollback();
    throw error;
  }
  if (checkpoint) {
    try {
      checkpoint();
    } catch (error) {
      throw new CheckpointAfterCommitError(error);
    }
  }
  const nodeCount = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);
  const result = { seeded: true, caseCount: validated.length, nodeCount, receipts };
  Object.defineProperty(result, "connection", { value: conn, enumerable: false });
  return result;
}

function importDecisionPacketsToEmptyStore(storePath, packets) {
  const validated = validatePacketSet(packets);
  const db = openStore(storePath);
  const conn = db.connect();
  return importDecisionPacketsIntoEmptyConnection(conn, validated, () => db.checkpoint());
}

function seedSyntheticDecision(storePath) {
  return importDecisionPacketsToEmptyStore(storePath, loadPrivateFixturePackets());
}

function evidenceRows(conn, claimId, relationshipType) {
  if (relationshipType !== "SUPPORTED_BY" && relationshipType !== "CONTRADICTED_BY") throw new Error("Evidence relationship is not allowlisted");
  return conn.query(
    `MATCH (claim:Claim {id: $claimId})-[:${relationshipType}]->(assertion:EvidenceAssertion) ` +
      "MATCH (decisionCase:DecisionCase)-[:HAS_OPTION]->(option:Option)-[:MAKES_CLAIM]->(claim) " +
      "MATCH (assertion)-[passageRelation:QUOTES|SUMMARIZES]->(passage:Passage)-[:EXTRACTED_FROM]->(source:Source) " +
      "MATCH (assertion)-[:APPLIES_WITHIN]->(scope:Scope)-[:FOR_CASE]->(decisionCase) " +
      "MATCH (assertion)-[:REVIEWED_BY]->(review:Review) " +
      "OPTIONAL MATCH (assertion)-[:GENERATED_BY]->(modelRun:ModelRun) " +
      "OPTIONAL MATCH (assertion)-[:AFFECTED]->(affectedDecision:Decision) " +
      "RETURN decisionCase.id AS caseId, option.id AS optionId, option.label AS optionLabel, option.position AS optionPosition, option.caseId AS optionStoredCaseId, " +
      "claim.id AS claimId, claim.text AS claimText, claim.position AS claimPosition, claim.optionId AS claimStoredOptionId, " +
      "assertion.id AS assertionId, assertion.currentness AS currentness, assertion.polarity AS assertionPolarity, " +
      "assertion.expectedClaimId AS expectedClaimId, assertion.expectedPassageId AS expectedPassageId, " +
      "assertion.expectedScopeId AS expectedScopeId, assertion.expectedReviewId AS expectedReviewId, " +
      "assertion.expectedModelRunId AS expectedModelRunId, assertion.expectedDecisionId AS expectedDecisionId, " +
      "passage.id AS passageId, passage.text AS passageText, passage.fingerprint AS fingerprint, " +
      "passage.representation AS passageRepresentation, passage.locator AS passageLocator, passage.sourceId AS expectedSourceId, type(passageRelation) AS passageRelation, " +
      "source.id AS sourceId, source.title AS sourceTitle, source.publisher AS sourcePublisher, source.sourceType AS sourceType, " +
      "source.url AS sourceUrl, source.checkedOn AS sourceCheckedOn, source.official AS sourceOfficial, " +
      "scope.id AS scopeId, scope.caseId AS scopeStoredCaseId, scope.object AS object, scope.version AS version, scope.position AS position, scope.runId AS runId, " +
      "scope.validFrom AS validFrom, scope.validTo AS validTo, " +
      "review.id AS reviewId, review.reviewerType AS reviewerType, review.result AS reviewResult, " +
      "review.timestamp AS reviewTimestamp, review.note AS reviewNote, " +
      "modelRun.id AS modelRunId, modelRun.tool AS modelTool, modelRun.model AS modelName, modelRun.promptVersion AS promptVersion, " +
      "affectedDecision.id AS affectedDecisionId, affectedDecision.selectedOption AS affectedSelectedOption",
    { claimId }
  ).rows.map((row) => ({ ...row, relation: relationshipType }));
}

function relationshipCount(conn, fromLabel, fromId, relationshipTypes, toLabel = null, toId = null) {
  if (!NODE_LABELS.has(fromLabel) || toLabel && !NODE_LABELS.has(toLabel)) throw new Error("Topology label is not allowlisted");
  const types = Array.isArray(relationshipTypes) ? relationshipTypes : [relationshipTypes];
  for (const type of types) if (!RELATIONSHIP_TYPES.has(type)) throw new Error("Topology relationship is not allowlisted");
  const target = toLabel
    ? `(target:${toLabel}${toId === null ? "" : " {id:$toId}"})`
    : "(target)";
  const row = conn.query(
    `MATCH (source:${fromLabel} {id:$fromId})-[binding:${types.join("|")}]->${target} RETURN count(binding) AS count`,
    { fromId, toId }
  ).single();
  return Number(row.count);
}

function topologyReasons(conn, row) {
  const reasons = [];
  if (relationshipCount(conn, "DecisionCase", row.caseId, "HAS_OPTION", "Option", row.optionId) !== 1) {
    reasons.push("CASE_OPTION_BINDING_MISMATCH");
  }
  if (relationshipCount(conn, "Option", row.optionId, "MAKES_CLAIM", "Claim", row.claimId) !== 1) {
    reasons.push("CLAIM_TOPOLOGY_COUNT_MISMATCH");
  }
  if (relationshipCount(conn, "Claim", row.claimId, ["SUPPORTED_BY", "CONTRADICTED_BY"], "EvidenceAssertion", row.assertionId) !== 1) {
    reasons.push("CLAIM_TOPOLOGY_COUNT_MISMATCH");
  }
  if (relationshipCount(conn, "EvidenceAssertion", row.assertionId, ["QUOTES", "SUMMARIZES"], "Passage", row.passageId) !== 1 ||
      relationshipCount(conn, "EvidenceAssertion", row.assertionId, ["QUOTES", "SUMMARIZES"]) !== 1) {
    reasons.push("PASSAGE_TOPOLOGY_COUNT_MISMATCH");
  }
  if (relationshipCount(conn, "Passage", row.passageId, "EXTRACTED_FROM", "Source", row.sourceId) !== 1 ||
      relationshipCount(conn, "Passage", row.passageId, "EXTRACTED_FROM") !== 1) {
    reasons.push("SOURCE_TOPOLOGY_COUNT_MISMATCH");
  }
  if (relationshipCount(conn, "EvidenceAssertion", row.assertionId, "APPLIES_WITHIN", "Scope", row.scopeId) !== 1 ||
      relationshipCount(conn, "EvidenceAssertion", row.assertionId, "APPLIES_WITHIN") !== 1 ||
      relationshipCount(conn, "Scope", row.scopeId, "FOR_CASE", "DecisionCase", row.caseId) !== 1 ||
      relationshipCount(conn, "Scope", row.scopeId, "FOR_CASE") !== 1) {
    reasons.push("SCOPE_TOPOLOGY_COUNT_MISMATCH");
  }
  if (relationshipCount(conn, "EvidenceAssertion", row.assertionId, "REVIEWED_BY", "Review", row.reviewId) !== 1 ||
      relationshipCount(conn, "EvidenceAssertion", row.assertionId, "REVIEWED_BY") !== 1) {
    reasons.push("REVIEW_TOPOLOGY_COUNT_MISMATCH");
  }
  const modelCount = relationshipCount(conn, "EvidenceAssertion", row.assertionId, "GENERATED_BY");
  if (row.expectedModelRunId
    ? modelCount !== 1 || relationshipCount(conn, "EvidenceAssertion", row.assertionId, "GENERATED_BY", "ModelRun", row.modelRunId) !== 1
    : modelCount !== 0) {
    reasons.push("MODEL_TOPOLOGY_COUNT_MISMATCH");
  }
  const decisionCount = relationshipCount(conn, "EvidenceAssertion", row.assertionId, "AFFECTED");
  if (row.expectedDecisionId
    ? decisionCount !== 1 || relationshipCount(conn, "EvidenceAssertion", row.assertionId, "AFFECTED", "Decision", row.affectedDecisionId) !== 1
    : decisionCount !== 0) {
    reasons.push("DECISION_TOPOLOGY_COUNT_MISMATCH");
  }
  return reasons;
}

function exclusionReasons(conn, row, requestedScope, integrityCache, caseReasons = []) {
  const reasons = [...caseReasons];
  if (row.currentness !== "CURRENT") reasons.push("NOT_CURRENT");
  if (row.reviewResult === "CONTEXT_ONLY") reasons.push("CONTEXT_ONLY");
  else if (!COUNTING_REVIEW_RESULTS.has(row.reviewResult)) reasons.push("INVALID_REVIEW_RESULT");
  if (row.object !== requestedScope.object) reasons.push("WRONG_OBJECT");
  if (row.version !== requestedScope.version) reasons.push("WRONG_VERSION");
  if (row.position !== requestedScope.position) reasons.push("WRONG_POSITION");
  if (row.optionPosition !== requestedScope.position) reasons.push("WRONG_OPTION_BINDING");
  if (row.claimPosition !== requestedScope.position) reasons.push("CLAIM_POSITION_MISMATCH");
  if (row.runId !== requestedScope.runId) reasons.push("WRONG_RUN");
  if (row.caseId !== requestedScope.caseId) reasons.push("WRONG_DECISION_CASE");
  if (row.optionStoredCaseId !== row.caseId) reasons.push("OPTION_CASE_BINDING_MISMATCH");
  if (row.claimStoredOptionId !== row.optionId) reasons.push("CLAIM_OPTION_BINDING_MISMATCH");
  if (row.expectedClaimId !== row.claimId) reasons.push("ASSERTION_CLAIM_BINDING_MISMATCH");
  if (row.expectedPassageId !== row.passageId) reasons.push("ASSERTION_PASSAGE_BINDING_MISMATCH");
  if (row.expectedScopeId !== row.scopeId) reasons.push("ASSERTION_SCOPE_BINDING_MISMATCH");
  if (row.expectedReviewId !== row.reviewId) reasons.push("ASSERTION_REVIEW_BINDING_MISMATCH");
  if (row.expectedSourceId !== row.sourceId) reasons.push("PASSAGE_SOURCE_BINDING_MISMATCH");
  if (row.scopeStoredCaseId !== row.caseId) reasons.push("SCOPE_CASE_BINDING_MISMATCH");
  if ((row.expectedModelRunId || "") !== (row.modelRunId || "")) reasons.push("ASSERTION_MODEL_BINDING_MISMATCH");
  if ((row.expectedDecisionId || "") !== (row.affectedDecisionId || "")) reasons.push("ASSERTION_DECISION_BINDING_MISMATCH");
  const expectedClaimRelation = row.assertionPolarity === "SUPPORT" ? "SUPPORTED_BY" : "CONTRADICTED_BY";
  if (row.relation !== expectedClaimRelation) reasons.push("ASSERTION_POLARITY_BINDING_MISMATCH");
  const integrityNodes = [
    ["DecisionCase", row.caseId],
    ["Option", row.optionId],
    ["Claim", row.claimId],
    ["EvidenceAssertion", row.assertionId],
    ["Passage", row.passageId],
    ["Source", row.sourceId],
    ["Scope", row.scopeId],
    ["Review", row.reviewId],
    ["ModelRun", row.modelRunId],
    ["Decision", row.affectedDecisionId]
  ];
  for (const [label, id] of integrityNodes) {
    if (id && !nodeIntegrityStatus(conn, label, id, integrityCache).valid) reasons.push(INTEGRITY_REASON[label]);
  }
  const expectedRelation = row.passageRepresentation === "PARAPHRASE" ? "SUMMARIZES" : "QUOTES";
  if (row.passageRelation !== expectedRelation) reasons.push("INVALID_PASSAGE_BINDING");
  try {
    const asOf = parseIsoDate(requestedScope.asOf, "requestedScope.asOf");
    const validFrom = parseIsoDate(row.validFrom, "scope.validFrom");
    const validTo = parseIsoDate(row.validTo, "scope.validTo");
    if (validFrom > validTo) reasons.push("INVALID_SCOPE_DATE");
    else if (asOf < validFrom || asOf > validTo) reasons.push("OUTSIDE_VALID_DATE");
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    reasons.push("INVALID_SCOPE_DATE");
  }
  if (typeof row.passageText !== "string" || typeof row.fingerprint !== "string" || fingerprint(row.passageText) !== row.fingerprint) {
    reasons.push("FAILED_INTEGRITY_BINDING");
  }
  reasons.push(...topologyReasons(conn, row));
  return [...new Set(reasons)];
}

function evaluateClaim(conn, claimId, requestedScope, providedCaseInventory = null) {
  checkedId(claimId, "claimId");
  validateRequestedScope(requestedScope);
  const claimRows = conn.query(
    "MATCH (claim:Claim {id: $claimId}) RETURN claim.id AS claimId, claim.text AS claimText, claim.position AS claimPosition",
    { claimId }
  ).rows;
  if (claimRows.length === 0) {
    return { found: false, claimId, requestedScope, status: "NOT_FOUND", supportCount: 0, contradictionCount: 0, matching: [], excluded: [] };
  }
  const caseInventory = providedCaseInventory || auditCaseInventory(conn, requestedScope.caseId);
  const rawRows = [...evidenceRows(conn, claimId, "SUPPORTED_BY"), ...evidenceRows(conn, claimId, "CONTRADICTED_BY")];
  const uniqueRows = new Map();
  for (const row of rawRows) {
    const key = [
      row.relation, row.assertionId, row.passageId, row.scopeId, row.reviewId,
      row.sourceId, row.modelRunId || "", row.affectedDecisionId || ""
    ].join("\u0000");
    if (!uniqueRows.has(key)) uniqueRows.set(key, row);
  }
  const all = [...uniqueRows.values()];
  const matching = [];
  const excluded = [];
  const integrityCache = new Map();
  for (const row of all) {
    const reasons = exclusionReasons(conn, row, requestedScope, integrityCache, caseInventory.reasons);
    const safeRow = safeRecord(row);
    if (reasons.length === 0) matching.push(safeRow);
    else excluded.push({ ...safeRow, exclusionReasons: reasons });
  }
  const supportCount = matching.filter((row) => row.relation === "SUPPORTED_BY").length;
  const contradictionCount = matching.filter((row) => row.relation === "CONTRADICTED_BY").length;
  let status = "UNKNOWN_NOT_PROVEN";
  if (supportCount > 0 && contradictionCount > 0) status = "CONFLICTING_MATCHING_CURRENT_EVIDENCE";
  else if (supportCount > 0) status = "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE";
  else if (contradictionCount > 0) status = "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE";
  return {
    found: true,
    claimId,
    claimText: jsonSafeValue(claimRows[0].claimText),
    claimPosition: jsonSafeValue(claimRows[0].claimPosition),
    requestedScope: safeRecord(requestedScope),
    contextIntegrity: { valid: caseInventory.valid, reasons: [...caseInventory.reasons] },
    status,
    supportCount,
    contradictionCount,
    matching,
    excluded
  };
}

function findLiveConflicts(conn, requestedScope, providedCaseInventory = null) {
  validateRequestedScope(requestedScope);
  const caseInventory = providedCaseInventory || auditCaseInventory(conn, requestedScope.caseId);
  if (!caseInventory.valid) return [];
  const candidates = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(option:Option)-[:MAKES_CLAIM]->(claim:Claim) " +
      "WHERE option.position = $position AND claim.position = $position " +
      "RETURN claim.id AS claimId, claim.status AS storedClaimStatus ORDER BY claim.id",
    requestedScope
  ).rows;
  const conflicts = [];
  for (const candidate of candidates) {
    const evaluated = evaluateClaim(conn, candidate.claimId, requestedScope, caseInventory);
    if (evaluated.status !== "CONFLICTING_MATCHING_CURRENT_EVIDENCE") continue;
    const positive = evaluated.matching.filter((row) => row.relation === "SUPPORTED_BY");
    const negative = evaluated.matching.filter((row) => row.relation === "CONTRADICTED_BY");
    for (const positiveRow of positive) {
      for (const negativeRow of negative) {
        conflicts.push({
          claimId: candidate.claimId,
          storedClaimStatus: candidate.storedClaimStatus,
          positiveAssertionId: positiveRow.assertionId,
          negativeAssertionId: negativeRow.assertionId,
          positiveText: positiveRow.passageText,
          positiveFingerprint: positiveRow.fingerprint,
          negativeText: negativeRow.passageText,
          negativeFingerprint: negativeRow.fingerprint,
          positiveValidFrom: positiveRow.validFrom,
          positiveValidTo: positiveRow.validTo,
          negativeValidFrom: negativeRow.validFrom,
          negativeValidTo: negativeRow.validTo,
          positiveReviewResult: positiveRow.reviewResult,
          negativeReviewResult: negativeRow.reviewResult
        });
      }
    }
  }
  return conflicts;
}

function jsonSafeValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { invalidType: "nonfinite-number", value: String(value) };
  if (typeof value === "bigint") return { invalidType: "bigint", value: value.toString() };
  if (typeof value === "undefined") return { invalidType: "undefined" };
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonSafeValue(item);
    return result;
  }
  return { invalidType: typeof value, value: String(value) };
}

function safeRecord(record) {
  const result = {};
  for (const [key, value] of Object.entries(record || {})) result[key] = jsonSafeValue(value);
  return result;
}

function safeGraphProperties(label, properties) {
  const result = {};
  for (const key of NODE_INTEGRITY_FIELDS[label] || []) {
    if (Object.hasOwn(properties || {}, key)) result[key] = jsonSafeValue(properties[key]);
  }
  return result;
}

function serializeGraphEntity(entity) {
  if (entity.kind === "node") {
    const recognized = entity.labels.filter((label) => NODE_LABELS.has(label));
    const label = recognized.length === 1 ? recognized[0] : entity.labels[0];
    const integrity = verifyNodeProperties(label, entity.properties, entity.labels);
    return {
      kind: "node",
      elementId: entity.elementId,
      labels: entity.labels.map((item) => String(item)),
      properties: safeGraphProperties(label, entity.properties),
      integrityValid: integrity.valid,
      integrityReason: integrity.valid ? null : integrity.reason
    };
  }
  return {
    kind: "relationship",
    elementId: entity.elementId,
    type: entity.type,
    startElementId: entity.startElementId,
    endElementId: entity.endElementId,
    properties: safeRecord(entity.properties)
  };
}

function serializedInventory(results) {
  const nodes = new Map();
  const relationships = new Map();
  for (const result of results) {
    const graph = result.graph();
    for (const node of graph.nodes) nodes.set(node.elementId, serializeGraphEntity(node));
    for (const relationship of graph.relationships) relationships.set(relationship.elementId, serializeGraphEntity(relationship));
  }
  return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
}

function queryClaimGraph(conn, caseId, claimId) {
  checkedId(caseId, "caseId");
  checkedId(claimId, "claimId");
  const result = conn.query(
    "MATCH evidencePath=(dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(option:Option)-[:MAKES_CLAIM]->(claim:Claim {id:$claimId})" +
      "-[:SUPPORTED_BY|CONTRADICTED_BY]->(assertion:EvidenceAssertion)-[:QUOTES|SUMMARIZES]->(passage:Passage)-[:EXTRACTED_FROM]->(source:Source) " +
      "MATCH scopePath=(assertion)-[:APPLIES_WITHIN]->(scope:Scope)-[:FOR_CASE]->(dc) " +
      "MATCH reviewPath=(assertion)-[:REVIEWED_BY]->(review:Review) " +
      "OPTIONAL MATCH modelPath=(assertion)-[:GENERATED_BY]->(modelRun:ModelRun) " +
      "OPTIONAL MATCH decisionPath=(assertion)-[:AFFECTED]->(decision:Decision) " +
      "RETURN evidencePath, scopePath, reviewPath, modelPath, decisionPath LIMIT 50",
    { caseId, claimId }
  );
  const graph = result.graph();
  const optionContext = conn.query(
    "MATCH optionPath=(dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(option:Option) RETURN optionPath ORDER BY option.id",
    { caseId }
  );
  const criterionContext = conn.query(
    "MATCH criterionPath=(dc:DecisionCase {id:$caseId})-[:USES_CRITERION]->(criterion:Criterion) RETURN criterionPath ORDER BY criterion.id",
    { caseId }
  );
  const decisionContext = conn.query(
    "MATCH decisionPath=(dc:DecisionCase {id:$caseId})-[:RESULTED_IN]->(decision:Decision) RETURN decisionPath ORDER BY decision.id",
    { caseId }
  );
  const caseNodeContext = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId}) RETURN dc AS node",
    { caseId }
  );
  const allNodeContext = conn.query(
    "MATCH (node) WHERE node.caseId = $caseId RETURN node ORDER BY node.id",
    { caseId }
  );
  const caseInventory = auditCaseInventory(conn, caseId);
  return {
    queryId: GRAPH_QUERY_ID,
    description: GRAPH_QUERY_DESCRIPTION,
    parameters: { caseId, claimId },
    paths: result.rows.map((row) => ({
      evidencePath: row.evidencePath.map(serializeGraphEntity),
      scopePath: row.scopePath.map(serializeGraphEntity),
      reviewPath: row.reviewPath.map(serializeGraphEntity),
      modelPath: row.modelPath ? row.modelPath.map(serializeGraphEntity) : [],
      decisionPath: row.decisionPath ? row.decisionPath.map(serializeGraphEntity) : []
    })),
    inventory: { nodes: graph.nodes.map(serializeGraphEntity), relationships: graph.relationships.map(serializeGraphEntity) },
    caseContext: {
      valid: caseInventory.valid,
      reasons: [...caseInventory.reasons],
      optionPaths: optionContext.rows.map((row) => row.optionPath.map(serializeGraphEntity)),
      criterionPaths: criterionContext.rows.map((row) => row.criterionPath.map(serializeGraphEntity)),
      decisionPaths: decisionContext.rows.map((row) => row.decisionPath.map(serializeGraphEntity)),
      inventory: serializedInventory([caseNodeContext, allNodeContext, optionContext, criterionContext, decisionContext])
    }
  };
}

function listCases(conn) {
  return conn.query(
    "MATCH (dc:DecisionCase) OPTIONAL MATCH (dc)-[:HAS_OPTION]->(:Option)-[:MAKES_CLAIM]->(claim:Claim) " +
      "RETURN dc.id AS caseId, dc.title AS title, dc.status AS status, dc.asOf AS asOf, count(claim) AS claimCount ORDER BY dc.id"
  ).rows.map((row) => {
    const integrity = nodeIntegrityStatus(conn, "DecisionCase", row.caseId);
    return {
      ...safeRecord(row),
      claimCount: Number(row.claimCount),
      integrityValid: integrity.valid,
      integrityReason: integrity.valid ? null : integrity.reason
    };
  });
}

function getCaseContext(conn, caseId) {
  checkedId(caseId, "caseId");
  const rows = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId}) RETURN dc.id AS caseId, dc.title AS title, dc.status AS status, " +
      "dc.object AS object, dc.version AS version, dc.runId AS runId, dc.asOf AS asOf, dc.deadline AS deadline, " +
      "dc.schemaVersion AS schemaVersion, dc.datasetHash AS datasetHash",
    { caseId }
  ).rows;
  if (rows.length === 0) throw new InputValidationError(`case not found: ${caseId}`);
  const integrity = nodeIntegrityStatus(conn, "DecisionCase", caseId);
  return { ...safeRecord(rows[0]), integrityValid: integrity.valid, integrityReason: integrity.valid ? null : integrity.reason };
}

function buildCaseReportFromConnection(conn, caseId) {
  const caseContext = getCaseContext(conn, caseId);
  const caseInventory = auditCaseInventory(conn, caseId);
  const rawClaimRows = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(:Option)-[:MAKES_CLAIM]->(claim:Claim) " +
      "RETURN claim.id AS claimId, claim.position AS position ORDER BY claim.id",
    { caseId }
  ).rows;
  const claimRows = [...new Map(rawClaimRows.map((row) => [`${String(row.claimId)}\u0000${String(row.position)}`, row])).values()];
  const claims = claimRows.filter((item) => typeof item.claimId === "string" && SAFE_ID.test(item.claimId)).map((item) => {
    const safeId = (value, fallback) => typeof value === "string" && SAFE_ID.test(value) ? value : fallback;
    const scope = {
      object: safeId(caseContext.object, "invalid-object"),
      version: safeId(caseContext.version, "invalid-version"),
      position: safeId(item.position, "invalid-position"),
      runId: safeId(caseContext.runId, "invalid-run"),
      caseId,
      asOf: safeIsoDate(caseContext.asOf)
    };
    return { ...evaluateClaim(conn, item.claimId, scope, caseInventory), graphPath: queryClaimGraph(conn, caseId, item.claimId) };
  });
  const positions = [...new Set(claimRows.map((item) => item.position))];
  const liveConflicts = [];
  const seenConflicts = new Set();
  for (const position of positions) {
    const rows = findLiveConflicts(conn, {
      object: typeof caseContext.object === "string" && SAFE_ID.test(caseContext.object) ? caseContext.object : "invalid-object",
      version: typeof caseContext.version === "string" && SAFE_ID.test(caseContext.version) ? caseContext.version : "invalid-version",
      position: typeof position === "string" && SAFE_ID.test(position) ? position : "invalid-position",
      runId: typeof caseContext.runId === "string" && SAFE_ID.test(caseContext.runId) ? caseContext.runId : "invalid-run",
      caseId,
      asOf: safeIsoDate(caseContext.asOf)
    }, caseInventory);
    for (const row of rows) {
      const key = `${row.claimId}|${row.positiveAssertionId}|${row.negativeAssertionId}`;
      if (!seenConflicts.has(key)) {
        seenConflicts.add(key);
        liveConflicts.push(row);
      }
    }
  }
  const decisionRows = conn.query(
    "MATCH (dc:DecisionCase {id:$caseId})-[:RESULTED_IN]->(d:Decision) " +
      "RETURN dc.id AS caseId, dc.title AS title, d.id AS decisionId, d.caseId AS decisionStoredCaseId, d.selectedOption AS selectedOption, d.selectedOptionId AS selectedOptionId, " +
      "d.uncertainty AS uncertainty, d.revisitAt AS revisitAt",
    { caseId }
  ).rows;
  const rawDecision = decisionRows.length > 0 ? decisionRows[0] : { caseId, decisionId: null };
  const decision = safeRecord(rawDecision);
  const decisionIntegrity = typeof rawDecision.decisionId === "string"
    ? nodeIntegrityStatus(conn, "Decision", rawDecision.decisionId)
    : { valid: false, reason: "DECISION_CONTENT_INTEGRITY_MISMATCH" };
  decision.integrityValid = decisionRows.length === 1 && decisionIntegrity.valid && rawDecision.decisionStoredCaseId === caseId;
  decision.integrityReason = decision.integrityValid
    ? null
    : (decisionRows.length !== 1 ? "CASE_DECISION_BINDING_MISMATCH" : decisionIntegrity.valid ? "DECISION_CASE_BINDING_MISMATCH" : decisionIntegrity.reason);
  if (caseInventory.valid && decision.integrityValid && typeof rawDecision.selectedOptionId === "string") {
    const optionRows = conn.query(
      "MATCH (dc:DecisionCase {id:$caseId})-[:HAS_OPTION]->(option:Option {id:$optionId}) RETURN option AS node",
      { caseId, optionId: rawDecision.selectedOptionId }
    ).rows;
    const option = optionRows[0]?.node;
    if (optionRows.length === 1 && option.properties.caseId === caseId &&
        option.properties.position === rawDecision.selectedOption &&
        verifyNodeProperties("Option", option.properties, option.labels).valid) {
      decision.selectedOptionLabel = option.properties.label;
    }
  }
  return {
    truthBoundary: "A matching fingerprint proves stored text integrity, not factual truth, source truth, or correct interpretation.",
    decisionAuthority: { owner: "HUMAN", automaticApproval: false, note: "Evidence status and the human decision are separate graph nodes." },
    case: caseContext,
    caseInventory,
    decision,
    liveConflicts,
    claims
  };
}

function buildReportFromConnection(conn, caseId = "case-laptop") {
  return buildCaseReportFromConnection(conn, caseId);
}

function buildReport(storePath, caseId = "case-laptop") {
  const conn = openStore(storePath, { readOnly: true }).connect();
  return buildCaseReportFromConnection(conn, caseId);
}

module.exports = {
  CheckpointAfterCommitError,
  COUNTING_REVIEW_RESULTS,
  GRAPH_QUERY_ID,
  InputValidationError,
  buildCaseReportFromConnection,
  buildReport,
  buildReportFromConnection,
  ensureSchema,
  evaluateClaim,
  findLiveConflicts,
  fingerprint,
  importDecisionPacketsIntoEmptyConnection,
  importDecisionPacketsToEmptyStore,
  listCases,
  openStore,
  parseIsoDate,
  queryClaimGraph,
  seedSyntheticDecision,
  validateDecisionPacket,
  validateRequestedScope
};
