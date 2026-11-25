const path = require("node:path");
const { openStore } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const conn = openStore(storePath).connect();
conn.query(
  "MATCH (p:Passage {id: 'passage-repair-cost'}) " +
    "SET p.text = 'Tampered text that no longer matches the bound fingerprint.'"
);
process.stdout.write('{"tampered":true}\n');
