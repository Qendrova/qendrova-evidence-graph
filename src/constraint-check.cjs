const path = require("node:path");
const { openStore } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const conn = openStore(storePath).connect();
const before = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);

function blocked(statement, params = {}) {
  try {
    conn.query(statement, params);
    return { blocked: false, error: null };
  } catch (error) {
    return { blocked: true, error: error.message };
  }
}

const duplicate = blocked(
  "CREATE (:Claim {id: $id, text: 'Duplicate must fail', position: 'repair', status: 'OPEN'})",
  { id: "claim-repair-cost" }
);
const missingId = blocked(
  "CREATE (:Claim {text: 'Missing id must fail', position: 'repair', status: 'OPEN'})"
);
const after = Number(conn.query("MATCH (n) RETURN count(n) AS count").single().count);
const constraints = conn.query("SHOW KEY CONSTRAINTS").rows;

process.stdout.write(
  `${JSON.stringify({ before, after, duplicate, missingId, constraintCount: constraints.length })}\n`
);
