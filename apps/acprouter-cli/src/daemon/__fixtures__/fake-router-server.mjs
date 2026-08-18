// Standalone fake Router, spawned as its own OS process by the integration
// test rather than hosted inline in the test runner. A server hosted in the
// test *process* is unreachable from the CLI subprocess the test itself
// spawns (a grandchild relative to the test runner) — sibling processes can
// reach each other over loopback, but a grandchild cannot reach a server
// living in its grandparent. Prints `SERVER_READY <port>` once listening.
import { createServer } from "node:http";

let counter = 0;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/v1/machines/redeem") {
    counter += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ machineId: `fake_machine_${counter}` }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`SERVER_READY ${port}`);
});
