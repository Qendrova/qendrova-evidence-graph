const path = require("node:path");
const { seedSyntheticDecision } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence-phase3.rl");
const result = seedSyntheticDecision(storePath);
process.stdout.write(`${JSON.stringify(result)}\n`);
