const path = require("node:path");
const { openStore } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence.rl");
const conn = openStore(storePath).connect();
conn.query(
  "MATCH (r:Review {id: 'review-human-1'}) " +
    "SET r.result = 'AUTO_APPROVED_NOT_IN_ALLOWLIST'"
);
process.stdout.write('{"invalidReviewApplied":true}\n');
