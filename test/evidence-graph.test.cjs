const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { InputValidationError, parseIsoDate } = require("../src/evidence-graph.cjs");

const projectRoot = path.resolve(__dirname, "..");
const script = (name) => path.join(projectRoot, "src", name);
const seedScript = script("seed.cjs");
const reportScript = script("report.cjs");
const evaluateScript = script("evaluate.cjs");

const currentRepairScope = {
  object: "laptop-a",
  version: "v1",
  position: "repair",
  runId: "run-1",
  caseId: "case-laptop",
  asOf: "2026-11-19"
};

function runJson(scriptPath, ...args) {
  return JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" }));
}

function withSeededStore(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qendrova-relate-"));
  const storePath = path.join(tempRoot, "evidence.rl");
  try {
    const seeded = runJson(seedScript, storePath);
    assert.equal(seeded.seeded, true);
    assert.equal(seeded.caseCount, 4);
    return callback(storePath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("persistent store reopens with positive and negative exact paths", () => {
  withSeededStore((storePath) => {
    const first = runJson(reportScript, storePath);
    const second = runJson(reportScript, storePath);
    assert.deepEqual(second, first);
    const byId = Object.fromEntries(first.claims.map((claim) => [claim.claimId, claim]));
    assert.equal(byId["claim-repair-cost"].status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    const budget = byId["claim-buy-budget"];
    assert.equal(budget.status, "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(budget.supportCount, 0);
    assert.deepEqual(budget.matching.map((row) => row.assertionId), ["assert-buy-total"]);
    assert.deepEqual(budget.excluded.map((row) => [row.assertionId, row.exclusionReasons]), [
      ["assert-buy-price", ["CONTEXT_ONLY"]]
    ]);
    const reliability = byId["claim-warranty"];
    assert.equal(reliability.status, "UNKNOWN_NOT_PROVEN");
    assert.equal(reliability.matching.length, 0);
    assert.deepEqual(reliability.excluded.map((row) => [row.assertionId, row.exclusionReasons]), [
      ["assert-warranty", ["CONTEXT_ONLY"]]
    ]);
    const pathRow = byId["claim-repair-cost"].matching[0];
    assert.equal(pathRow.optionId, "option-repair");
    assert.equal(pathRow.runId, "run-1");
    assert.equal(pathRow.caseId, "case-laptop");
    assert.equal(pathRow.reviewResult, "BOUND_TO_EXACT_PASSAGE");
    assert.match(pathRow.fingerprint, /^[0-9a-f]{64}$/);
  });
});

test("live conflict survives a misleading RESOLVED label and decision stays human", () => {
  withSeededStore((storePath) => {
    const report = runJson(reportScript, storePath, "case-relate-rules");
    const conflict = report.claims.find((claim) => claim.claimId === "claim-existing-extension");
    assert.equal(conflict.status, "CONFLICTING_MATCHING_CURRENT_EVIDENCE");
    assert.equal(conflict.matching.length, 2);
    assert.equal(report.liveConflicts.find((item) => item.claimId === conflict.claimId).storedClaimStatus, "RESOLVED");
    const laptop = runJson(reportScript, storePath);
    assert.equal(laptop.liveConflicts.length, 0);
    assert.equal(laptop.decisionAuthority.owner, "HUMAN");
    assert.equal(laptop.decisionAuthority.automaticApproval, false);
    assert.equal(laptop.decision.selectedOption, "wait");
    assert.match(laptop.truthBoundary, /integrity, not factual truth/i);
  });
});

test("a claim without its decision-case and option binding is omitted from the report", () => {
  withSeededStore((storePath) => {
    runJson(script("orphan-claim-fixture.cjs"), storePath);
    const report = runJson(reportScript, storePath);
    const claim = report.claims.find((item) => item.claimId === "claim-buy-budget");
    assert.equal(claim, undefined);
    assert.equal(report.liveConflicts.length, 0);
  });
});

test("stale and wrong-option paths stay visible while a missing claim is NOT_FOUND", () => {
  withSeededStore((storePath) => {
    const report = runJson(reportScript, storePath);
    const osClaim = report.claims.find((claim) => claim.claimId === "claim-os-support");
    assert.equal(osClaim.status, "UNKNOWN_NOT_PROVEN");
    const reasons = osClaim.excluded.flatMap((row) => row.exclusionReasons);
    for (const expected of ["NOT_CURRENT", "WRONG_VERSION", "WRONG_RUN", "OUTSIDE_VALID_DATE", "WRONG_POSITION"]) {
      assert.ok(reasons.includes(expected), expected);
    }
    const missing = runJson(
      evaluateScript,
      storePath,
      "claim-does-not-exist",
      JSON.stringify(currentRepairScope)
    );
    assert.equal(missing.found, false);
    assert.equal(missing.status, "NOT_FOUND");
  });
});

test("fingerprint tampering excludes the path instead of fabricating a result", () => {
  withSeededStore((storePath) => {
    runJson(script("tamper-fixture.cjs"), storePath);
    const report = runJson(reportScript, storePath);
    const claim = report.claims.find((item) => item.claimId === "claim-repair-cost");
    assert.equal(claim.status, "UNKNOWN_NOT_PROVEN");
    assert.ok(claim.excluded[0].exclusionReasons.includes("FAILED_INTEGRITY_BINDING"));
  });
});

test("only allowlisted review results can make evidence count", () => {
  withSeededStore((storePath) => {
    runJson(script("invalid-review-fixture.cjs"), storePath);
    const report = runJson(reportScript, storePath);
    assert.equal(report.liveConflicts.length, 0);
    for (const claim of report.claims) {
      assert.equal(claim.status, "UNKNOWN_NOT_PROVEN");
      const reason = claim.claimId === "claim-warranty" ? "CONTEXT_ONLY" : "INVALID_REVIEW_RESULT";
      assert.ok(claim.excluded.some((row) => row.exclusionReasons.includes(reason)));
    }
  });
});

test("ISO dates are real calendar dates and invalid stored dates are excluded", () => {
  assert.equal(parseIsoDate("2026-11-19"), Date.UTC(2026, 10, 19));
  assert.throws(() => parseIsoDate("2026-02-30"), InputValidationError);
  assert.throws(() => parseIsoDate("19.11.2026"), InputValidationError);
  withSeededStore((storePath) => {
    const invalidScope = { ...currentRepairScope, asOf: "2026-02-30" };
    const result = spawnSync(
      process.execPath,
      [evaluateScript, storePath, "claim-repair-cost", JSON.stringify(invalidScope)],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /real calendar date/);

    runJson(script("invalid-scope-date-fixture.cjs"), storePath);
    const report = runJson(reportScript, storePath);
    const claim = report.claims.find((item) => item.claimId === "claim-repair-cost");
    assert.equal(claim.status, "UNKNOWN_NOT_PROVEN");
    assert.ok(claim.excluded[0].exclusionReasons.includes("INVALID_SCOPE_DATE"));
  });
});

test("per-label node keys block duplicate and missing Claim ids atomically", () => {
  withSeededStore((storePath) => {
    const result = runJson(script("constraint-check.cjs"), storePath);
    assert.equal(result.constraintCount, 11);
    assert.equal(result.duplicate.blocked, true);
    assert.equal(result.missingId.blocked, true);
    assert.equal(result.after, result.before);
  });
});
