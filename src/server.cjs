const path = require("node:path");
const { createLocalServer } = require("./ui-server.cjs");

const storePath = process.argv[2] || path.join(__dirname, "..", ".data", "qendrova-evidence-phase3.rl");
const rawPort = process.argv[3] || "0";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('{"error":"INVALID_PORT"}\n');
  process.exit(2);
}

const server = createLocalServer(storePath);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ listening: true, address: address.address, port: address.port, readOnly: true })}\n`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
