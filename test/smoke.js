const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("../server");

const server = http.createServer(app);

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;

  try {
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");

    const ssrf = await fetch(base + "/api/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:3000", pages: 1 }),
    });
    assert.equal(ssrf.status, 400);

    const malformed = await fetch(base + "/api/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    assert.equal(malformed.status, 400);

    console.log("Netverse smoke tests passed.");
  } finally {
    server.close();
  }
});
