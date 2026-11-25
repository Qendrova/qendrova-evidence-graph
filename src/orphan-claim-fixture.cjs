const path = require("node:path");
const { openStore } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const conn = openStore(storePath).connect();
conn.query(
  "MATCH (:Option)-[binding:MAKES_CLAIM]->(:Claim {id: 'claim-buy-budget'}) " +
    "DELETE binding"
);
process.stdout.write('{"claimBindingRemoved":true}\n');
