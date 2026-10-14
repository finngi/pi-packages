import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fetchProfileRules } from "../../src/fetch-profile.ts";
import {
  canonicalizeHost,
  createFetchProxy,
  isPublicAddress,
  trackLeaseSocket,
} from "../../src/fetch-proxy.ts";

const request = (lease, host, auth = true) =>
  new Promise((resolve, reject) => {
    const url = new URL(lease.env.HTTPS_PROXY);
    const req = http.request({
      host: "127.0.0.1",
      port: lease.port,
      method: "CONNECT",
      path: host,
      headers: auth
        ? {
            "Proxy-Authorization":
              "Basic " + Buffer.from(`${url.username}:${url.password}`).toString("base64"),
          }
        : {},
    });
    req.on("connect", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
test("canonical hosts, public address filtering, profile shapes", () => {
  assert.equal(canonicalizeHost("EXAMPLE.COM.:443"), "example.com:443");
  for (const x of [
    "http://example.com",
    "*.example.com",
    "example.com/x",
    "x@y",
    "localhost",
    "x:0",
  ])
    assert.throws(() => canonicalizeHost(x));
  for (const x of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "2001::1",
    "2001:10::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "198.51.100.1",
    "203.0.113.1",
    "192.88.99.1",
    "2000::1",
    "2001::1",
    "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:4e00::1",
    "2001:c000::1",
    "2001:db8::1",
    "2002::1",
    "2b00::1",
    "2d00::1",
    "3000::1",
    "3f00::1",
    "3ffe::1",
    "3fff::1",
    "4000::1",
  ])
    assert.equal(isPublicAddress(x), false, x);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("192.31.196.1"), true);
  assert.equal(isPublicAddress("192.175.48.1"), true);
  assert.equal(isPublicAddress("2001:200::1"), true);
  assert.equal(isPublicAddress("2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff"), true);
  assert.equal(isPublicAddress("2001:1fff::1"), true);
  assert.equal(isPublicAddress("2001:db7:ffff:ffff:ffff:ffff:ffff:ffff"), true);
  assert.equal(isPublicAddress("2001:db9::1"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  assert.equal(isPublicAddress("2c00::1"), true);
  assert.equal(
    fetchProfileRules({ port: 1234 }),
    '(allow network-outbound (remote ip "localhost:1234"))\n(allow mach-lookup (global-name "com.apple.trustd.agent"))\n',
  );
  assert.throws(() => fetchProfileRules({ port: "1) (allow default)" }));
});
test("a socket arriving after lease release is destroyed immediately", () => {
  const lease = { active: false, sockets: new Set() };
  const socket = new PassThrough();
  assert.equal(trackLeaseSocket(lease, socket), false);
  assert.equal(socket.destroyed, true);
  assert.equal(lease.sockets.size, 0);
});
test("immutable lease intersections, private address refusal, credentials and release", async () => {
  const proxy = await createFetchProxy({ hosts: ["example.com", "github.com", "127.0.0.1"] });
  try {
    await assert.rejects(proxy.lease([]), /empty/);
    await assert.rejects(proxy.lease([["example.com"], ["github.com"]]), /empty/);
    const a = await proxy.lease(["example.com"]);
    const b = await proxy.lease(["github.com"]);
    assert.notEqual(a.env.HTTPS_PROXY, b.env.HTTPS_PROXY);
    assert.equal(a.port, b.port);
    assert.equal(await request(a, "github.com:443"), 403);
    assert.equal(await request(b, "example.com:443"), 403);
    assert.equal(await request(a, "example.com:443", false), 407);
    const privateLease = await proxy.lease(["127.0.0.1"]);
    assert.equal(await request(privateLease, "127.0.0.1:443"), 403);
    await a.release();
    assert.equal(await request(a, "example.com:443"), 407);
    await b.release();
    await privateLease.release();
  } finally {
    await proxy.close();
  }
});

test("unqualified grants allow only web ports; explicit ports are exact", async () => {
  let unqualifiedLookups = 0;
  const unqualified = await createFetchProxy({
    hosts: ["example.com"],
    resolveAddresses: async () => {
      unqualifiedLookups++;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  try {
    const lease = await unqualified.lease(["example.com"]);
    assert.equal(await request(lease, "example.com:22"), 403);
    assert.equal(unqualifiedLookups, 0, "non-web port is rejected before resolution or connection");
    assert.equal(await request(lease, "example.com:443"), 403);
    assert.equal(unqualifiedLookups, 1, "the standard HTTPS port passes host authorization");
    await lease.release();
  } finally {
    await unqualified.close();
  }

  let explicitLookups = 0;
  const explicit = await createFetchProxy({
    hosts: ["example.com:8443"],
    resolveAddresses: async () => {
      explicitLookups++;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  try {
    const lease = await explicit.lease(["example.com:8443"]);
    assert.equal(await request(lease, "example.com:443"), 403);
    assert.equal(explicitLookups, 0, "an explicit grant does not include other ports");
    assert.equal(await request(lease, "example.com:8443"), 403);
    assert.equal(explicitLookups, 1, "the explicitly granted port passes host authorization");
    await lease.release();
  } finally {
    await explicit.close();
  }
});

test("wildcard ceiling still uses exact-host leases and refuses private destinations", async () => {
  const lookedUp = [];
  const proxy = await createFetchProxy({
    hosts: ["*"],
    resolveAddresses: async (host) => {
      lookedUp.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  try {
    const publicLease = await proxy.lease(["*"]);
    assert.equal(await request(publicLease, "other.example:443"), 403);
    assert.deepEqual(lookedUp, ["other.example"]);
    await publicLease.release();
    lookedUp.length = 0;
    const lease = await proxy.lease(["new.example"]);
    assert.equal(await request(lease, "other.example:443"), 403);
    assert.deepEqual(lookedUp, []);
    assert.equal(await request(lease, "new.example:443"), 403);
    assert.deepEqual(lookedUp, ["new.example"]);
    await lease.release();
    assert.equal(await request(lease, "new.example:443"), 407);
  } finally {
    await proxy.close();
  }
});
