const dns = require("node:dns");
const net = require("node:net");
const { URL } = require("node:url");

const MAX_URL_LENGTH = 2048;

function ipv4ToNumber(address) {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return (
    parts[0] * 0x1000000 +
    parts[1] * 0x10000 +
    parts[2] * 0x100 +
    parts[3]
  );
}

function inIpv4Range(value, start, end) {
  return value >= start && value <= end;
}

function isPrivateIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return true;

  // Non-global, special-purpose, documentation, benchmarking, multicast,
  // and reserved ranges. These are deliberately blocked conservatively.
  const blockedRanges = [
    [0x00000000, 0x00ffffff], // 0.0.0.0/8
    [0x0a000000, 0x0affffff], // 10.0.0.0/8
    [0x64400000, 0x647fffff], // 100.64.0.0/10 (shared)
    [0x7f000000, 0x7fffffff], // 127.0.0.0/8
    [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
    [0xac100000, 0xac1fffff], // 172.16.0.0/12
    [0xc0000000, 0xc00000ff], // 192.0.0.0/24
    [0xc0000200, 0xc00002ff], // 192.0.2.0/24
    [0xc0586300, 0xc05863ff], // 192.88.99.0/24
    [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
    [0xc6120000, 0xc613ffff], // 198.18.0.0/15
    [0xc6336400, 0xc63364ff], // 198.51.100.0/24
    [0xcb007100, 0xcb0071ff], // 203.0.113.0/24
    [0xe0000000, 0xffffffff], // Multicast and reserved
  ];

  return blockedRanges.some(([start, end]) => inIpv4Range(value, start, end));
}

function ipv6ToBigInt(address) {
  let normalized = String(address).toLowerCase();

  // Scoped addresses are not valid public crawl targets.
  if (!normalized || normalized.includes("%")) return null;

  // Expand an IPv4 tail into its two hexadecimal 16-bit words.
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = normalized.slice(lastColon + 1);
    const ipv4Number = ipv4ToNumber(ipv4);
    if (ipv4Number === null) return null;
    const high = ((ipv4Number >>> 16) & 0xffff).toString(16);
    const low = (ipv4Number & 0xffff).toString(16);
    normalized = normalized.slice(0, lastColon) + ":" + high + ":" + low;
  }

  if ((normalized.match(/::/g) || []).length > 1) return null;

  let words;
  if (normalized.includes("::")) {
    const [leftText, rightText] = normalized.split("::");
    const left = leftText ? leftText.split(":") : [];
    const right = rightText ? rightText.split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    words = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    words = normalized.split(":");
    if (words.length !== 8) return null;
  }

  if (
    words.length !== 8 ||
    words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))
  ) {
    return null;
  }

  return words.reduce(
    (value, word) => (value << 16n) | BigInt(parseInt(word, 16)),
    0n,
  );
}

function matchesIpv6Prefix(value, prefix, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (prefix >> shift);
}

function isPrivateIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;

  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const ipv4 = Number(value & 0xffffffffn);
    const dotted = [
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join(".");
    return isPrivateIpv4(dotted);
  }

  // IPv4-compatible, unspecified, loopback, unique-local, link-local,
  // multicast, NAT64, site-local, and other non-global ranges are outside
  // the only globally-routable unicast allocation (2000::/3).
  const globalUnicast = matchesIpv6Prefix(value, 0x2000n << 112n, 3);
  if (!globalUnicast) return true;

  // Special-purpose allocations within 2000::/3 are not crawl targets.
  if (matchesIpv6Prefix(value, 0x20010000000000000000000000000000n, 23)) {
    return true; // 2001::/23 protocol assignments, including Teredo
  }
  if (matchesIpv6Prefix(value, 0x20010db8n << 96n, 32)) {
    return true; // 2001:db8::/32 documentation range
  }
  if (matchesIpv6Prefix(value, 0x20020000000000000000000000000000n, 16)) {
    return true; // 6to4, which embeds an IPv4 destination
  }
  if (matchesIpv6Prefix(value, 0x3fff0000000000000000000000000000n, 20)) {
    return true; // Documentation range 3fff::/20
  }

  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

function isPrivateHostname(hostname) {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isPrivateAddress(unwrapped);
}

function validateTargetUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw new Error("URL must be a non-empty string no longer than 2,048 characters.");
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("A valid absolute URL is required.");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (target.username || target.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  if (!target.hostname) {
    throw new Error("URL hostname is required.");
  }

  if (isPrivateHostname(target.hostname)) {
    throw new Error("Private and reserved network targets are blocked.");
  }

  return target;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);

    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      return callback(new Error("Blocked private or reserved network address."));
    }

    if (options && options.all) {
      return callback(null, addresses);
    }

    const selected = addresses[0];
    return callback(null, selected.address, selected.family);
  });
}

function normalizeUrl(href, base) {
  if (typeof href !== "string" || href.length > MAX_URL_LENGTH) return null;

  try {
    const url = new URL(href, base);

    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || isPrivateHostname(url.hostname)) return null;
    if (url.href.length > MAX_URL_LENGTH) return null;

    url.hash = "";
    url.search = "";

    let normalized = url.toString();
    if (normalized.endsWith("/") && normalized.length > url.origin.length + 1) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

module.exports = {
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  normalizeUrl,
  safeLookup,
  validateTargetUrl,
};
