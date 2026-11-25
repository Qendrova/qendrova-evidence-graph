const path = require("node:path");
const { openStore } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const conn = openStore(storePath).connect();
conn.query(
  "MATCH (s:Scope {id: 'scope-repair-v1'}) " +
    "SET s.validTo = '2026-02-30'"
);
process.stdout.write('{"invalidScopeDateApplied":true}\n');
