const path = require("node:path");
const { importDecisionPacketsToEmptyStore, InputValidationError } = require("./evidence-graph.cjs");
const { loadFixturePacket, loadPrivateFixturePackets } = require("./decision-packet.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence-phase3.rl");
const fixtureNames = process.argv.slice(3);

try {
  const packets = fixtureNames.length ? fixtureNames.map(loadFixturePacket) : loadPrivateFixturePackets();
  process.stdout.write(`${JSON.stringify(importDecisionPacketsToEmptyStore(storePath, packets))}\n`);
} catch (error) {
  const expected = error instanceof InputValidationError || error instanceof SyntaxError;
  process.stderr.write(`${JSON.stringify({ error: error.name, message: error.message })}\n`);
  process.exitCode = expected ? 2 : 1;
}
