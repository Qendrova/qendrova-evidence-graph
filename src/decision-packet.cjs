const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_FIXTURE_BYTES = 256 * 1024;
const MAX_ARRAY_ITEMS = 200;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIXTURE_FILES = new Set([
  "laptop.synthetic.json",
  "relate-rules.public.json",
  "construction-before.synthetic.json",
  "construction-after.synthetic.json"
]);
const OFFICIAL_SOURCE_HOSTS = new Set(["relate.devpost.com", "relatedb.ai", "github.com"]);

const ENUMS = Object.freeze({
  caseStatus: new Set(["UNDER_REVIEW", "DECIDED", "HOLD"]),
  claimStatus: new Set(["OPEN", "RESOLVED"]),
  sourceType: new Set([
    "QUOTE", "OFFER", "REVIEW", "DOCUMENTATION", "TERMS",
    "OFFICIAL_OVERVIEW", "OFFICIAL_RULES"
  ]),
  representation: new Set(["SYNTHETIC_VERBATIM", "PARAPHRASE", "EXACT_EXCERPT"]),
  polarity: new Set(["SUPPORT", "CONTRADICT"]),
  currentness: new Set(["CURRENT", "STALE"]),
  encodingMethod: new Set(["HUMAN_BOUND", "DETERMINISTIC_IMPORT", "AI_ASSISTED_BOUND"]),
  reviewerType: new Set(["HUMAN", "DETERMINISTIC", "AI_ASSISTED"]),
  reviewResult: new Set([
    "BOUND_TO_EXACT_PASSAGE", "PARAPHRASE_CHECKED_AGAINST_LOCATOR", "CONTEXT_ONLY", "REJECTED", "NEEDS_REVIEW"
  ])
});

class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputValidationError";
  }
}

function fail(message) {
  throw new InputValidationError(message);
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${field} must be a plain object`);
  }
  return value;
}

function exactKeys(value, required, optional, field) {
  plainObject(value, field);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${field}.${key} is forbidden`);
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
  }
}

function strictArray(value, field, min = 0, max = MAX_ARRAY_ITEMS) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length < min || value.length > max) fail(`${field} must contain ${min}-${max} items`);
  return value;
}

function strictString(value, field, max = 500) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  if (CONTROL_CHARACTERS.test(value)) fail(`${field} contains control characters`);
  return value;
}

function strictId(value, field) {
  strictString(value, field, 80);
  if (!ID_PATTERN.test(value)) fail(`${field} must be a lowercase hyphenated identifier`);
  return value;
}

function strictBoolean(value, field) {
  if (typeof value !== "boolean") fail(`${field} must be boolean`);
  return value;
}

function strictEnum(value, allowed, field) {
  strictString(value, field, 60);
  if (!allowed.has(value)) fail(`${field} is not in the fixed allowlist`);
  return value;
}

function parseIsoDate(value, field = "date") {
  strictString(value, field, 10);
  const match = ISO_DATE.exec(value);
  if (!match) fail(`${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail(`${field} is not a real calendar date`);
  }
  return timestamp;
}

function parseIsoInstant(value, field) {
  strictString(value, field, 24);
  const match = ISO_INSTANT.exec(value);
  if (!match) fail(`${field} must be a real UTC ISO timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7] || "0");
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour || parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millisecond
  ) {
    fail(`${field} must be a real UTC ISO timestamp`);
  }
  return timestamp;
}

function strictHttpsUrl(value, field) {
  strictString(value, field, 300);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    fail(`${field} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(`${field} must be HTTPS without credentials or a fragment`);
  }
  if (!OFFICIAL_SOURCE_HOSTS.has(parsed.hostname)) fail(`${field} host is not in the official-source allowlist`);
  return value;
}

function rememberId(seen, value, field) {
  strictId(value, field);
  if (seen.has(value)) fail(`${field} duplicates id ${value}`);
  seen.add(value);
}

function requireReference(ids, value, field) {
  strictId(value, field);
  if (!ids.has(value)) fail(`${field} references unknown id ${value}`);
}

function validateDecisionPacket(packet) {
  exactKeys(packet, [
    "schemaVersion", "case", "options", "criteria", "claims", "sources", "passages",
    "scopes", "assertions", "reviews", "modelRuns", "decision"
  ], [], "packet");
  if (packet.schemaVersion !== 1) fail("packet.schemaVersion must equal 1");
  const seenIds = new Set();

  exactKeys(packet.case, ["id", "title", "deadline", "status", "evaluation"], [], "packet.case");
  rememberId(seenIds, packet.case.id, "packet.case.id");
  strictString(packet.case.title, "packet.case.title", 160);
  parseIsoDate(packet.case.deadline, "packet.case.deadline");
  strictEnum(packet.case.status, ENUMS.caseStatus, "packet.case.status");
  exactKeys(packet.case.evaluation, ["object", "version", "runId", "asOf"], [], "packet.case.evaluation");
  strictId(packet.case.evaluation.object, "packet.case.evaluation.object");
  strictId(packet.case.evaluation.version, "packet.case.evaluation.version");
  strictId(packet.case.evaluation.runId, "packet.case.evaluation.runId");
  parseIsoDate(packet.case.evaluation.asOf, "packet.case.evaluation.asOf");

  const optionIds = new Set();
  const optionPositions = new Map();
  for (const [index, item] of strictArray(packet.options, "packet.options", 1, 20).entries()) {
    const field = `packet.options[${index}]`;
    exactKeys(item, ["id", "label", "position"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    optionIds.add(item.id);
    strictString(item.label, `${field}.label`, 120);
    strictId(item.position, `${field}.position`);
    if ([...optionPositions.values()].includes(item.position)) fail(`${field}.position duplicates ${item.position}`);
    optionPositions.set(item.id, item.position);
  }

  const criterionIds = new Set();
  for (const [index, item] of strictArray(packet.criteria, "packet.criteria", 1, 30).entries()) {
    const field = `packet.criteria[${index}]`;
    exactKeys(item, ["id", "label", "hardBoundary"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    criterionIds.add(item.id);
    strictString(item.label, `${field}.label`, 160);
    strictBoolean(item.hardBoundary, `${field}.hardBoundary`);
  }

  const claimIds = new Set();
  for (const [index, item] of strictArray(packet.claims, "packet.claims", 1, 80).entries()) {
    const field = `packet.claims[${index}]`;
    exactKeys(item, ["id", "text", "optionId", "status"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    claimIds.add(item.id);
    strictString(item.text, `${field}.text`, 500);
    requireReference(optionIds, item.optionId, `${field}.optionId`);
    strictEnum(item.status, ENUMS.claimStatus, `${field}.status`);
  }

  const sourceIds = new Set();
  for (const [index, item] of strictArray(packet.sources, "packet.sources", 1, 80).entries()) {
    const field = `packet.sources[${index}]`;
    exactKeys(item, ["id", "title", "publisher", "sourceType", "official"], ["url", "checkedOn"], field);
    rememberId(seenIds, item.id, `${field}.id`);
    sourceIds.add(item.id);
    strictString(item.title, `${field}.title`, 200);
    strictString(item.publisher, `${field}.publisher`, 120);
    strictEnum(item.sourceType, ENUMS.sourceType, `${field}.sourceType`);
    strictBoolean(item.official, `${field}.official`);
    const hasUrl = Object.hasOwn(item, "url");
    const hasCheckedOn = Object.hasOwn(item, "checkedOn");
    if (hasUrl !== hasCheckedOn) fail(`${field}.url and checkedOn must be provided together`);
    if (hasUrl) {
      strictHttpsUrl(item.url, `${field}.url`);
      parseIsoDate(item.checkedOn, `${field}.checkedOn`);
      if (!item.official) fail(`${field}.official must be true when a public URL is provided`);
    }
  }

  const passageIds = new Set();
  const passageSemantics = new Set();
  const passagesById = new Map();
  for (const [index, item] of strictArray(packet.passages, "packet.passages", 1, 200).entries()) {
    const field = `packet.passages[${index}]`;
    exactKeys(item, ["id", "sourceId", "text", "representation", "locator"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    passageIds.add(item.id);
    passagesById.set(item.id, item);
    requireReference(sourceIds, item.sourceId, `${field}.sourceId`);
    strictString(item.text, `${field}.text`, 1000);
    strictEnum(item.representation, ENUMS.representation, `${field}.representation`);
    strictString(item.locator, `${field}.locator`, 160);
    const semanticKey = `${item.sourceId}\u0000${item.text}`;
    if (passageSemantics.has(semanticKey)) fail(`${field} duplicates the same source text under another id`);
    passageSemantics.add(semanticKey);
  }

  const validPositions = new Set(optionPositions.values());
  const scopeIds = new Set();
  for (const [index, item] of strictArray(packet.scopes, "packet.scopes", 1, 80).entries()) {
    const field = `packet.scopes[${index}]`;
    exactKeys(item, ["id", "object", "version", "position", "runId", "validFrom", "validTo"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    scopeIds.add(item.id);
    strictId(item.object, `${field}.object`);
    strictId(item.version, `${field}.version`);
    strictId(item.position, `${field}.position`);
    if (!validPositions.has(item.position)) fail(`${field}.position does not match an imported option`);
    strictId(item.runId, `${field}.runId`);
    const validFrom = parseIsoDate(item.validFrom, `${field}.validFrom`);
    const validTo = parseIsoDate(item.validTo, `${field}.validTo`);
    if (validFrom > validTo) fail(`${field} has validFrom after validTo`);
  }

  const reviewIds = new Set();
  const reviewsById = new Map();
  for (const [index, item] of strictArray(packet.reviews, "packet.reviews", 1, 30).entries()) {
    const field = `packet.reviews[${index}]`;
    exactKeys(item, ["id", "reviewerType", "result", "timestamp", "note"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    reviewIds.add(item.id);
    reviewsById.set(item.id, item);
    strictEnum(item.reviewerType, ENUMS.reviewerType, `${field}.reviewerType`);
    strictEnum(item.result, ENUMS.reviewResult, `${field}.result`);
    parseIsoInstant(item.timestamp, `${field}.timestamp`);
    strictString(item.note, `${field}.note`, 300);
  }

  const modelRunIds = new Set();
  for (const [index, item] of strictArray(packet.modelRuns, "packet.modelRuns", 0, 30).entries()) {
    const field = `packet.modelRuns[${index}]`;
    exactKeys(item, ["id", "tool", "model", "timestamp", "promptVersion"], [], field);
    rememberId(seenIds, item.id, `${field}.id`);
    modelRunIds.add(item.id);
    strictString(item.tool, `${field}.tool`, 100);
    strictString(item.model, `${field}.model`, 100);
    parseIsoInstant(item.timestamp, `${field}.timestamp`);
    strictString(item.promptVersion, `${field}.promptVersion`, 100);
  }

  exactKeys(packet.decision, ["id", "selectedOptionId", "decidedAt", "revisitAt", "uncertainty"], [], "packet.decision");
  rememberId(seenIds, packet.decision.id, "packet.decision.id");
  requireReference(optionIds, packet.decision.selectedOptionId, "packet.decision.selectedOptionId");
  parseIsoDate(packet.decision.decidedAt, "packet.decision.decidedAt");
  parseIsoDate(packet.decision.revisitAt, "packet.decision.revisitAt");
  strictString(packet.decision.uncertainty, "packet.decision.uncertainty", 300);

  const assertionIds = new Set();
  const assertionSemantics = new Set();
  const assertionsPerClaim = new Map();
  for (const [index, item] of strictArray(packet.assertions, "packet.assertions", 1, 200).entries()) {
    const field = `packet.assertions[${index}]`;
    exactKeys(item, [
      "id", "claimId", "passageId", "scopeId", "reviewId", "polarity",
      "currentness", "encodingMethod", "affectedDecision"
    ], ["modelRunId"], field);
    rememberId(seenIds, item.id, `${field}.id`);
    assertionIds.add(item.id);
    requireReference(claimIds, item.claimId, `${field}.claimId`);
    requireReference(passageIds, item.passageId, `${field}.passageId`);
    requireReference(scopeIds, item.scopeId, `${field}.scopeId`);
    requireReference(reviewIds, item.reviewId, `${field}.reviewId`);
    strictEnum(item.polarity, ENUMS.polarity, `${field}.polarity`);
    strictEnum(item.currentness, ENUMS.currentness, `${field}.currentness`);
    strictEnum(item.encodingMethod, ENUMS.encodingMethod, `${field}.encodingMethod`);
    strictBoolean(item.affectedDecision, `${field}.affectedDecision`);
    if (Object.hasOwn(item, "modelRunId")) requireReference(modelRunIds, item.modelRunId, `${field}.modelRunId`);
    const passage = passagesById.get(item.passageId);
    const review = reviewsById.get(item.reviewId);
    if (review.result === "PARAPHRASE_CHECKED_AGAINST_LOCATOR" && passage.representation !== "PARAPHRASE") {
      fail(`${field}.reviewId uses paraphrase review semantics for a non-paraphrase`);
    }
    if (review.result === "BOUND_TO_EXACT_PASSAGE" && passage.representation === "PARAPHRASE") {
      fail(`${field}.reviewId uses exact-passage semantics for a paraphrase`);
    }
    const semanticKey = [item.claimId, item.passageId, item.scopeId, item.polarity].join("\u0000");
    if (assertionSemantics.has(semanticKey)) fail(`${field} duplicates an existing evidence binding under another id`);
    assertionSemantics.add(semanticKey);
    const count = (assertionsPerClaim.get(item.claimId) || 0) + 1;
    if (count > 50) fail(`${field}.claimId exceeds the 50-path explorer limit`);
    assertionsPerClaim.set(item.claimId, count);
  }

  return packet;
}

function parseStrictJson(text) {
  if (typeof text !== "string") fail("JSON input must be text");
  if (Buffer.byteLength(text, "utf8") > MAX_FIXTURE_BYTES) fail("fixture JSON exceeds 256 KiB");
  let index = 0;
  const whitespace = () => { while (index < text.length && /\s/.test(text[index])) index += 1; };

  function stringToken() {
    if (text[index] !== '"') fail(`invalid JSON string at offset ${index}`);
    const start = index++;
    while (index < text.length) {
      if (text[index] === '"') {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); }
        catch (_error) { fail(`invalid JSON string at offset ${start}`); }
      }
      if (text[index] === "\\") index += 2;
      else {
        if (text.charCodeAt(index) < 0x20) fail(`invalid control character at offset ${index}`);
        index += 1;
      }
    }
    fail(`unterminated JSON string at offset ${start}`);
  }

  function value(depth) {
    if (depth > 32) fail("fixture JSON nesting exceeds 32 levels");
    whitespace();
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) fail(`duplicate JSON key: ${key}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(`expected colon at offset ${index}`);
        index += 1;
        value(depth + 1);
        whitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index] !== ",") fail(`expected comma at offset ${index}`);
        index += 1;
      }
      fail("unterminated JSON object");
    }
    if (text[index] === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (index < text.length) {
        value(depth + 1);
        whitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index] !== ",") fail(`expected comma at offset ${index}`);
        index += 1;
      }
      fail("unterminated JSON array");
    }
    if (text[index] === '"') { stringToken(); return; }
    const remaining = text.slice(index);
    const literal = /^(?:true|false|null)/.exec(remaining);
    if (literal) { index += literal[0].length; return; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
    if (number) { index += number[0].length; return; }
    fail(`invalid JSON value at offset ${index}`);
  }

  value(0);
  whitespace();
  if (index !== text.length) fail(`unexpected JSON content at offset ${index}`);
  try { return JSON.parse(text); }
  catch (error) { fail(`fixture JSON could not be parsed: ${error.message}`); }
}

function resolveFixturePath(fileName) {
  if (typeof fileName !== "string" || path.basename(fileName) !== fileName || !FIXTURE_FILES.has(fileName)) {
    fail("fixture name is not in the fixed basename allowlist");
  }
  const fixtureRoot = fs.realpathSync(path.join(__dirname, "..", "fixtures"));
  const candidate = path.join(fixtureRoot, fileName);
  const real = fs.realpathSync(candidate);
  if (path.dirname(real) !== fixtureRoot || path.extname(real).toLowerCase() !== ".json") {
    fail("fixture resolved outside the fixed JSON import directory");
  }
  return real;
}

function loadFixturePacket(fileName) {
  const fixturePath = resolveFixturePath(fileName);
  const stat = fs.statSync(fixturePath);
  if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) fail("fixture must be a JSON file below 256 KiB");
  let packet;
  try {
    packet = parseStrictJson(fs.readFileSync(fixturePath, "utf8"));
  } catch (error) {
    fail(`fixture JSON could not be parsed: ${error.message}`);
  }
  return validateDecisionPacket(packet);
}

function loadPrivateFixturePackets() {
  return [...FIXTURE_FILES].map(loadFixturePacket);
}

module.exports = {
  FIXTURE_FILES,
  InputValidationError,
  loadFixturePacket,
  loadPrivateFixturePackets,
  parseIsoInstant,
  parseStrictJson,
  parseIsoDate,
  resolveFixturePath,
  validateDecisionPacket
};
