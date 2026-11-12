const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");

const app = require("../server");

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("health endpoint returns no-store and security headers", async () => {
  const response = await fetch(baseUrl + "/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.deepEqual(await response.json().then(({ status }) => ({ status })), { status: "ok" });
});

test("static HTML also receives security headers", async () => {
  const response = await fetch(baseUrl + "/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("crawl API rejects private IPv4 and IPv6 targets before network access", async () => {
  for (const url of [
    "http://127.0.0.1:3000",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    const response = await fetch(baseUrl + "/api/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, pages: 1 }),
    });
    assert.equal(response.status, 400, url);
    assert.match((await response.json()).error, /blocked/i);
  }
});

test("crawl API rejects malformed objects and non-integer limits", async () => {
  const nonObject = await fetch(baseUrl + "/api/crawl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(["https://example.com"]),
  });
  assert.equal(nonObject.status, 400);

  const fractional = await fetch(baseUrl + "/api/crawl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", pages: 1.5 }),
  });
  assert.equal(fractional.status, 400);
  assert.match((await fractional.json()).error, /whole number/i);
});

test("request parser returns bounded JSON errors", async () => {
  const malformed = await fetch(baseUrl + "/api/crawl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid",
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /malformed json/i);

  const oversized = await fetch(baseUrl + "/api/crawl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(40 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /32 KB/i);
});

test("unknown API routes return a compact JSON 404", async () => {
  const response = await fetch(baseUrl + "/api/not-found");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
});
