const path = require("node:path");
const {
  InputValidationError,
  evaluateClaim,
  openStore
} = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const claimId = process.argv[3] || "";

try {
  const requestedScope = JSON.parse(process.argv[4] || "{}");
  const conn = openStore(storePath, { readOnly: true }).connect();
  process.stdout.write(`${JSON.stringify(evaluateClaim(conn, claimId, requestedScope), null, 2)}\n`);
} catch (error) {
  const expected = error instanceof InputValidationError || error instanceof SyntaxError;
  process.stderr.write(`${JSON.stringify({ error: error.name, message: error.message })}\n`);
  process.exitCode = expected ? 2 : 1;
}
