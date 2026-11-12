const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  normalizeUrl,
  validateTargetUrl,
} = require("../lib/network-policy");

test("IPv4 policy blocks private, shared, link-local, documentation and reserved ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.10",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPrivateIpv4(address), true, address);
  }

  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
});

test("IPv6 policy blocks non-global and special-purpose ranges", () => {
  for (const address of [
    "::",
    "::1",
    "::192.0.2.1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3fff::1",
    "64:ff9b::0808:0808",
  ]) {
    assert.equal(isPrivateIpv6(address), true, address);
  }

  for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateIpv6(address), false, address);
  }
});

test("URL validation rejects local targets, credentials, schemes and oversized input", () => {
  for (const value of [
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://user:pass@example.com/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "x".repeat(2049),
  ]) {
    assert.throws(() => validateTargetUrl(value));
  }

  assert.equal(validateTargetUrl("https://example.com/path").hostname, "example.com");
});

test("URL normalization strips fragments and queries and rejects private destinations", () => {
  assert.equal(
    normalizeUrl("/docs?a=1#section", "https://example.com/index"),
    "https://example.com/docs",
  );
  assert.equal(normalizeUrl("http://127.0.0.1/", "https://example.com"), null);
  assert.equal(normalizeUrl("http://[::1]/", "https://example.com"), null);
  assert.equal(normalizeUrl("javascript:alert(1)", "https://example.com"), null);
  assert.equal(normalizeUrl("https://user:pass@example.com", "https://example.com"), null);
});

test("isPrivateAddress distinguishes hostnames from IP literals", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("example.com"), false);
});
