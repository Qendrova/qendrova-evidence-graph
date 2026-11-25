const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const seedScript = path.join(projectRoot, "src", "seed.cjs");
const serverScript = path.join(projectRoot, "src", "server.cjs");

function startServer(storePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverScript, storePath, "0"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server start timeout: ${stderr}`));
    }, 10000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve({ child, info: JSON.parse(stdout.slice(0, newline)) });
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (stdout.indexOf("\n") === -1) {
        clearTimeout(timer);
        reject(new Error(`server exited before listening (${code}): ${stderr}`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
  });
}

function requestWithHost(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET", headers: { Host: hostHeader } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }
    );
    request.once("error", reject);
    request.end();
  });
}

test("bilingual localhost dashboard stays read-only and exposes unambiguous evidence paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qendrova-ui-"));
  const storePath = path.join(tempRoot, "evidence.rl");
  let child;
  try {
    JSON.parse(execFileSync(process.execPath, [seedScript, storePath], { encoding: "utf8" }));
    const started = await startServer(storePath);
    child = started.child;
    assert.equal(started.info.address, "127.0.0.1");
    assert.equal(started.info.readOnly, true);
    const base = `http://127.0.0.1:${started.info.port}`;

    const healthResponse = await fetch(`${base}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, readOnly: true, bindAddress: "127.0.0.1" });

    const apiResponse = await fetch(`${base}/api/report`);
    assert.equal(apiResponse.status, 200);
    assert.match(apiResponse.headers.get("content-type"), /^application\/json/);
    assert.equal(apiResponse.headers.get("cache-control"), "no-store");
    assert.equal(apiResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(apiResponse.headers.get("x-frame-options"), "DENY");
    assert.match(apiResponse.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(apiResponse.headers.get("access-control-allow-origin"), null);
    const report = await apiResponse.json();
    assert.equal(report.decisionAuthority.automaticApproval, false);
    assert.deepEqual(
      new Set(report.claims.map((claim) => claim.status)),
      new Set([
        "SATISFIED_BY_MATCHING_CURRENT_EVIDENCE",
        "NOT_SATISFIED_BY_MATCHING_CURRENT_EVIDENCE",
        "UNKNOWN_NOT_PROVEN"
      ])
    );

    const casesResponse = await fetch(`${base}/api/cases`);
    assert.equal(casesResponse.status, 200);
    assert.deepEqual(
      (await casesResponse.json()).map((item) => [item.caseId, item.claimCount]),
      [["case-construction-after", 3], ["case-construction-before", 3], ["case-laptop", 4], ["case-relate-rules", 6]]
    );

    const germanResponse = await fetch(`${base}/`);
    assert.equal(germanResponse.status, 200);
    assert.match(germanResponse.headers.get("content-type"), /^text\/html/);
    assert.equal(germanResponse.headers.get("cache-control"), "no-store");
    assert.equal(germanResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(germanResponse.headers.get("x-frame-options"), "DENY");
    assert.match(germanResponse.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(germanResponse.headers.get("access-control-allow-origin"), null);
    const german = await germanResponse.text();
    assert.match(german, /<html lang="de">/);
    assert.equal((german.match(/<main>/g) || []).length, 1);
    assert.equal((german.match(/<\/main>/g) || []).length, 1);
    assert.equal((german.match(/class="overview-row"/g) || []).length, 4);
    for (const claimId of ["claim-repair-cost", "claim-buy-budget", "claim-os-support", "claim-warranty"]) {
      assert.match(german, new RegExp(`href="#${claimId}"`));
      assert.match(german, new RegExp(`id="${claimId}"`));
    }
    assert.match(german, /Vier Aussagen im Überblick/);
    assert.match(german, /Die Reparatur kostet höchstens 400 Euro/);
    assert.match(german, /Der Ersatzlaptop kostet insgesamt höchstens 1\.000 Euro/);
    assert.match(german, /Gestützt – passender aktueller Beleg/);
    assert.match(german, /Widersprochen – passender aktueller Gegenbeleg/);
    assert.match(german, /Unbekannt – nicht belegt/);
    assert.match(german, /Konflikt – aktuelle Belege widersprechen sich/);
    assert.match(german, /Entscheidung bleibt beim Menschen/);
    assert.match(german, /Drei Monate warten/);
    assert.match(german, /Automatische Freigabe<\/dt><dd><strong>nein<\/strong>/);
    assert.match(german, /Ein Evidenzstatus ist keine Tatsachenwahrheit und trifft niemals die Entscheidung/);
    assert.match(german, /Unbekannt bedeutet nicht falsch/);
    assert.match(german, /Widersprochen bedeutet nicht unbekannt/);
    assert.match(german, /Stützender Beleg/);
    assert.match(german, /Widersprechender Beleg/);
    assert.match(german, /Beleg betrifft eine andere Option bzw\. Belegposition/);
    assert.match(german, /Option der Aussage/);
    assert.match(german, /Position des Belegs/);
    assert.match(german, /<nav class="language" aria-label="Sprache">/);
    assert.equal((german.match(/aria-label="Begründung öffnen:/g) || []).length, 4);
    assert.match(german, /Der Beleg liefert Kontext\. Für diese Aussage reicht er nicht aus\./);
    assert.doesNotMatch(german, /Option \/ position/i);
    assert.doesNotMatch(german, /scroll-behavior:\s*smooth/i);
    assert.match(german, /Feste deutsche Erklärung der synthetischen Passage/);
    assert.equal((german.match(/Promotional price: EUR 899 including delivery\./g) || []).length, 1);
    assert.equal((german.match(/Required setup and accessories bring expected total cost to EUR 1,120\./g) || []).length, 1);
    assert.match(german, /Synthetic repair quote — North Workshop — QUOTE — source-repair-quote/);
    assert.match(german, /2026-11-19T12:00:00Z — Synthetic fixture review/);
    assert.match(german, /Kein Modelllauf aufgezeichnet/);
    assert.match(german, /Keine direkte Wirkung auf die menschliche Entscheidung aufgezeichnet/);
    assert.doesNotMatch(german, /https?:\/\//i);
    assert.match(german, /href="\/case\/case-relate-rules"/);
    assert.match(german, /gespeicherten Prüfsummen erkennen versehentliche oder einfache Datenänderungen/);
    assert.match(german, /jemandem mit Schreibzugriff, der Daten und Prüfsummen gemeinsam neu berechnet/);

    const englishResponse = await fetch(`${base}/en`);
    assert.equal(englishResponse.status, 200);
    assert.match(englishResponse.headers.get("content-type"), /^text\/html/);
    assert.match(englishResponse.headers.get("content-security-policy"), /default-src 'none'/);
    const english = await englishResponse.text();
    assert.match(english, /<html lang="en">/);
    assert.equal((english.match(/<main>/g) || []).length, 1);
    assert.equal((english.match(/class="overview-row"/g) || []).length, 4);
    assert.match(english, /Four claims at a glance/);
    assert.match(english, /Human decision authority/);
    assert.match(english, /Wait three months/);
    assert.match(english, /Evidence status is not factual truth and never makes the decision/);
    assert.match(english, /Automatic approval<\/dt><dd><strong>no<\/strong>/);
    assert.match(english, /Unknown is not false/);
    assert.match(english, /Contradicted is not unknown/);
    assert.match(english, /Claim option/);
    assert.match(english, /Evidence position/);
    assert.match(english, /<nav class="language" aria-label="Language">/);
    assert.equal((english.match(/aria-label="Open details:/g) || []).length, 4);
    assert.match(english, /Context only\. The record does not establish or contradict this claim\./);
    assert.match(english, /<p class="integrity">Context only\./);
    assert.doesNotMatch(english, /Option \/ position/i);
    assert.match(english, /Supporting evidence/);
    assert.match(english, /Contradicting evidence/);
    assert.equal((english.match(/Promotional price: EUR 899 including delivery\./g) || []).length, 1);
    assert.equal((english.match(/Required setup and accessories bring expected total cost to EUR 1,120\./g) || []).length, 1);
    for (const field of ["Object", "Version", "Run / decision case", "Validity", "Exact source", "Review record", "Model / extraction provenance", "Recorded effect on the human decision", "Passage fingerprint"]) {
      assert.match(english, new RegExp(field.replace("/", "\\/")));
    }
    assert.match(english, /No model run recorded/);
    assert.match(english, /No direct effect on the human decision recorded/);
    assert.doesNotMatch(english, /https?:\/\//i);
    assert.match(english, /href="\/en\/case\/case-relate-rules"/);
    assert.match(english, /stored checksums detect accidental or simple data drift/);

    const germanRulesResponse = await fetch(`${base}/case/case-relate-rules`);
    assert.equal(germanRulesResponse.status, 200);
    const germanRules = await germanRulesResponse.text();
    assert.match(germanRules, /<html lang="de">/);
    assert.equal((germanRules.match(/class="overview-row"/g) || []).length, 6);
    assert.match(germanRules, /Sechs Aussagen zu den Relate-Regeln im Überblick/);
    assert.equal((germanRules.match(/aria-label="Begründung öffnen:/g) || []).length, 6);
    assert.match(germanRules, /Eine vollständige Einreichung erfordert zwingend ein ein- bis zweiminütiges Demo-Video/);
    assert.match(germanRules, /Strengere kombinierte Anforderungen verwenden/);
    assert.match(germanRules, /Gespeicherte Paraphrase der öffentlichen Quelle/);
    assert.match(germanRules, /Feste deutsche Erklärung der gespeicherten Paraphrase/);
    assert.doesNotMatch(germanRules, /Feste deutsche Erklärung der synthetischen Passage/);
    assert.match(germanRules, /PARAPHRASE/);
    assert.match(germanRules, /SUMMARIZES/);
    assert.doesNotMatch(germanRules, />QUOTES</);
    assert.doesNotMatch(germanRules, /<blockquote>/);
    assert.match(germanRules, /class="passage-text paraphrase"/);
    assert.match(germanRules, /https:\/\/relate\.devpost\.com\//);
    assert.match(germanRules, /https:\/\/relate\.devpost\.com\/rules/);
    assert.match(germanRules, /Tatsächlicher Relate-Graphpfad/);
    assert.match(germanRules, /RELATE_EVIDENCE_TRACE_V1/);
    assert.match(germanRules, /Von result\.graph\(\) zurückgegebener Bestand/);
    assert.match(germanRules, /Fallkontext aus Relate/);
    assert.match(germanRules, /criterion-project-age/);
    assert.match(germanRules, /option-overview-reading/);
    assert.match(germanRules, /Prüfansicht: Der rohe Graph zeigt tatsächliche Laufzeitpfade/);
    assert.match(germanRules, /href="\/en\/case\/case-relate-rules"/);
    assert.doesNotMatch(germanRules, /Exakte synthetische Testpassage/);

    const englishRulesResponse = await fetch(`${base}/en/case/case-relate-rules`);
    assert.equal(englishRulesResponse.status, 200);
    const englishRules = await englishRulesResponse.text();
    assert.match(englishRules, /<html lang="en">/);
    assert.match(englishRules, /Historical source snapshot from 2026-11-19/);
    assert.equal((englishRules.match(/class="overview-row"/g) || []).length, 6);
    assert.match(englishRules, /Six Relate-rules claims at a glance/);
    assert.match(englishRules, /A complete submission requires a one-to-two-minute demo video/);
    assert.match(englishRules, /Use the stricter combined requirements/);
    assert.match(englishRules, /Stored paraphrase of the public source/);
    assert.doesNotMatch(englishRules, /<blockquote>/);
    assert.match(englishRules, /Actual Relate graph path/);
    assert.match(englishRules, /Entity inventory returned by result\.graph\(\)/);
    assert.match(englishRules, /Relate case context/);
    assert.match(englishRules, /Audit view: the raw graph shows actual runtime paths/);
    assert.match(englishRules, /href="\/case\/case-relate-rules"/);

    const rulesApiResponse = await fetch(`${base}/api/report/case-relate-rules`);
    assert.equal(rulesApiResponse.status, 200);
    const rulesReport = await rulesApiResponse.json();
    assert.equal(rulesReport.case.caseId, "case-relate-rules");
    assert.equal(rulesReport.claims.length, 6);
    assert.equal(rulesReport.caseInventory.valid, true);
    assert.equal(rulesReport.decisionAuthority.automaticApproval, false);

    for (const variant of ["before", "after"]) {
      const response = await fetch(`${base}/en/case/case-construction-${variant}`);
      assert.equal(response.status, 200);
      const comparison = await response.text();
      assert.match(comparison, /Compare the construction cases/);
      assert.match(comparison, /href="\/en\/case\/case-construction-before#claim-construction-recess-before"/);
      assert.match(comparison, /href="\/en\/case\/case-construction-after#claim-construction-recess-after"/);
      assert.match(comparison, /Matching supporting records <strong>0<\/strong>/);
      assert.match(comparison, /Matching supporting records <strong>1<\/strong>/);
      assert.match(comparison, /Automatic approval<\/dt><dd><strong>no<\/strong>/);
      assert.match(comparison, /Actual Relate graph path/);
    }

    const germanConstructionResponse = await fetch(`${base}/case/case-construction-before`);
    assert.equal(germanConstructionResponse.status, 200);
    const germanConstruction = await germanConstructionResponse.text();
    assert.match(germanConstruction, /Baustellenbeispiel im Vergleich/);
    assert.match(germanConstruction, /Offene Planungsfrage zur Klärung geben/);

    const headResponse = await fetch(`${base}/en`, { method: "HEAD" });
    assert.equal(headResponse.status, 200);
    assert.equal(await headResponse.text(), "");
    assert.ok(Number(headResponse.headers.get("content-length")) > 0);

    const postResponse = await fetch(`${base}/api/report`, { method: "POST" });
    assert.equal(postResponse.status, 405);
    const missingResponse = await fetch(`${base}/not-a-route`);
    assert.equal(missingResponse.status, 404);
    const traversalResponse = await fetch(`${base}/%2e%2e/private`);
    assert.equal(traversalResponse.status, 404);
    const badHost = await requestWithHost(started.info.port, "evil.example");
    assert.equal(badHost.status, 403);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
