const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

function runJson(scriptName, ...args) {
  const scriptPath = path.join(projectRoot, "src", scriptName);
  return JSON.parse(execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" }));
}

test("only the matching recess record changes evidence status in the construction pair", (context) => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempRoot, "qendrova-construction-"));
  context.after(() => {
    assert.equal(path.dirname(fs.realpathSync(scratch)), tempRoot);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const storePath = path.join(scratch, "construction-pair.rl");
  const importResult = runJson(
    "import-fixtures.cjs",
    storePath,
    "construction-before.synthetic.json",
    "construction-after.synthetic.json"
  );
  assert.equal(importResult.caseCount, 2);
  assert.equal(importResult.nodeCount, 55);

  const before = runJson("report.cjs", storePath, "case-construction-before");
  const after = runJson("report.cjs", storePath, "case-construction-after");
  const findClaim = (report, part, variant) =>
    report.claims.find(({ claimId }) => claimId === `claim-construction-${part}-${variant}`);
  const beforeRecess = findClaim(before, "recess", "before");
  const afterRecess = findClaim(after, "recess", "after");
  assert.deepEqual(
    { ...beforeRecess.requestedScope, caseId: afterRecess.requestedScope.caseId },
    afterRecess.requestedScope
  );
  assert.equal(beforeRecess.status, "UNKNOWN_NOT_PROVEN");
  assert.equal(beforeRecess.matching.length, 0);
  assert.equal(afterRecess.status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
  const matchingAssertion = "assert-construction-current-recess-after";
  assert.deepEqual(afterRecess.matching.map(({ assertionId }) => assertionId), [matchingAssertion]);

  for (const [report, recess, variant] of [[before, beforeRecess, "before"], [after, afterRecess, "after"]]) {
    assert.equal(report.caseInventory.valid, true);
    const exclusions = new Map(recess.excluded.map((row) => [row.assertionId, row.exclusionReasons]));
    assert.equal(exclusions.size, 2);
    assert.deepEqual(exclusions.get(`assert-construction-wrong-location-${variant}`), ["WRONG_POSITION"]);
    assert.deepEqual(
      exclusions.get(`assert-construction-old-revision-${variant}`),
      ["NOT_CURRENT", "WRONG_VERSION", "OUTSIDE_VALID_DATE"]
    );
    assert.equal(findClaim(report, "flat", variant).status, "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE");
    assert.equal(findClaim(report, "register", variant).status, "CONFLICTING_MATCHING_CURRENT_EVIDENCE");
    assert.deepEqual(report.liveConflicts.map(({ claimId }) => claimId), [`claim-construction-register-${variant}`]);
    assert.equal(report.decisionAuthority.owner, "HUMAN");
    assert.equal(report.decisionAuthority.automaticApproval, false);
    assert.equal(report.decision.selectedOption, "clarify");
    assert.equal(report.decision.integrityValid, true);
  }

  const supportingPath = afterRecess.graphPath.paths.find(({ evidencePath }) =>
    evidencePath.some((entity) => entity.properties?.id === matchingAssertion));
  assert.ok(supportingPath, "Relate returns the matching assertion in an actual graph path");
  assert.ok(supportingPath.evidencePath.some((entity) => entity.properties?.id === "source-construction-current-recess-after"));
  assert.ok(supportingPath.scopePath.some((entity) => entity.properties?.id === "scope-construction-recess-after"));
  assert.ok(supportingPath.reviewPath.some((entity) => entity.properties?.id === "review-construction-binding-after"));
});
