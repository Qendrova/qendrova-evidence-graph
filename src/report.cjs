const path = require("node:path");
const { buildReport } = require("./evidence-graph.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence-phase3.rl");
const caseId = process.argv[3] || "case-laptop";
process.stdout.write(`${JSON.stringify(buildReport(storePath, caseId), null, 2)}\n`);
