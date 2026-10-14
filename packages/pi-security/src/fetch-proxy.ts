import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import net from "node:net";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";

interface LeaseState {
  sets: string[][];
  active: boolean;
  sockets: Set<Duplex>;
}
export function trackLeaseSocket(lease: Pick<LeaseState, "active" | "sockets">, socket: Duplex) {
  if (!lease.active) {
    socket.destroy();
    return false;
  }
  lease.sockets.add(socket);
  socket.once("close", () => lease.sockets.delete(socket));
  return true;
}

export function canonicalizeHost(value: string) {
  if (value === "*") return value;
  if (typeof value !== "string" || !value || /[\s/@?#\\*]/.test(value))
    throw Error("invalid fetch host");
  const url = new URL(`http://${value}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw Error("invalid fetch host");
  const hostname = domainToASCII(url.hostname.replace(/\.$/, "").toLowerCase());
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost"))
    throw Error("invalid fetch host");
  const explicitPort = value.startsWith("[")
    ? /\]:(\d+)$/.exec(value)?.[1]
    : /:(\d+)$/.exec(value)?.[1];
  if (explicitPort && (+explicitPort < 1 || +explicitPort > 65535))
    throw Error("invalid fetch port");
  return hostname + (explicitPort ? `:${+explicitPort}` : "");
}

function splitHost(value: string) {
  const key = canonicalizeHost(value);
  if (key === "*") throw Error("wildcard is a grant, not a fetch destination");
  const url = new URL(`http://${key}`);
  return {
    hostname: url.hostname,
    port: key.startsWith("[") ? /\]:(\d+)$/.exec(key)?.[1] : /:(\d+)$/.exec(key)?.[1],
  };
}
function matches(set: string[], hostname: string, port: number) {
  return set.some((key) => {
    if (key === "*") return true;
    const h = splitHost(key);
    return h.hostname === hostname && (h.port ? +h.port === port : port === 80 || port === 443);
  });
}

// Snapshot of IANA's allocated IPv6 global-unicast prefixes as of 2025-10-10.
// Unlisted space in 2000::/3 stays denied until a reviewed update adds it.
// Source: https://www.iana.org/assignments/ipv6-unicast-address-assignments
const allocatedIpv6 = new net.BlockList();
for (const [network, prefix] of [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
] as const) {
  allocatedIpv6.addSubnet(network, prefix, "ipv6");
}
const nonPublicIpv6 = new net.BlockList();
// Documentation space nested inside the allocated 2001:c00::/23 aggregate.
nonPublicIpv6.addSubnet("2001:db8::", 32, "ipv6");

// Pin the approved DNS result to the outbound socket; no second resolution can rebind it.
export function isPublicAddress(address: string) {
  if (net.isIPv4(address)) {
    // Exclude private, shared, link-local, documentation, benchmarking and reserved ranges.
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (!net.isIPv6(address) || address.includes("%")) return false;
  return allocatedIpv6.check(address, "ipv6") && !nonPublicIpv6.check(address, "ipv6");
}

export async function createFetchProxy({
  hosts,
  resolveAddresses = (hostname) => lookup(hostname, { all: true }),
}: {
  hosts: string[];
  resolveAddresses?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}) {
  if (!Array.isArray(hosts)) throw Error("fetch hosts must be an array");
  const globalHosts = hosts.map((host) => (host === "*" ? host : canonicalizeHost(host)));
  const credentials = new Map<string, LeaseState>();
  const sockets = new Set<Socket>();
  let closed = false;
  const server = http.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  function authorization(req: IncomingMessage) {
    const auth = req.headers["proxy-authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Basic ")) return undefined;
    return credentials.get(auth.slice(6));
  }
  async function destination(req: IncomingMessage, value: string, defaultPort: number) {
    const lease = authorization(req);
    if (!lease || !lease.active)
      throw Object.assign(Error("proxy credentials required"), { status: 407 });
    const { hostname, port: rawPort } = splitHost(value);
    const port = rawPort ? +rawPort : defaultPort;
    if (!lease.sets.every((set) => matches(set, hostname, port)))
      throw Error(`fetch host refused: ${hostname}:${port}`);
    const addresses = await resolveAddresses(hostname.replace(/^\[|\]$/g, ""));
    if (!addresses.length || addresses.some((row) => !isPublicAddress(row.address)))
      throw Error(
        `fetch address refused: ${hostname}:${port} does not resolve exclusively to public addresses`,
      );
    if (!lease.active) throw Error("fetch lease released");
    const pinned = addresses.find((row) => row.family === 4) ?? addresses[0];
    return { lease, address: pinned.address, family: pinned.family, port };
  }
  server.on("connect", async (req, socket, head) => {
    try {
      const dest = await destination(req, req.url!, 443);
      const upstream = net.connect({ host: dest.address, port: dest.port, family: dest.family });
      trackLeaseSocket(dest.lease, socket);
      trackLeaseSocket(dest.lease, upstream);
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    } catch (error) {
      socket.end(
        (error as Error & { status?: number }).status === 407
          ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fetch"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          : `HTTP/1.1 403 Forbidden\r\nX-Pi-Proxy-Error: ${String((error as Error).message).replace(/[^\x20-\x7e]/g, " ")}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url!);
      if (url.protocol !== "http:" || url.username || url.password)
        throw Error("invalid proxy URL");
      const dest = await destination(req, url.host, 80);
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          host: dest.address,
          family: dest.family,
          port: dest.port,
          method: req.method,
          path: url.pathname + url.search,
          headers,
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("socket", (socket) => trackLeaseSocket(dest.lease, socket));
      trackLeaseSocket(dest.lease, req.socket);
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (error) {
      res.writeHead(
        (error as Error & { status?: number }).status ?? 403,
        (error as Error & { status?: number }).status === 407
          ? { "Proxy-Authenticate": 'Basic realm="fetch"' }
          : {},
      );
      res.end((error as Error).message);
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    async lease(ruleHosts: string[] | string[][]) {
      if (closed) throw Error("fetch proxy closed");
      if (!Array.isArray(ruleHosts)) throw Error("rule hosts required");
      // A string list is one rule; a list of lists is the compound-call intersection.
      const rules: string[][] = ruleHosts.every((x) => typeof x === "string")
        ? [ruleHosts as string[]]
        : (ruleHosts as string[][]);
      if (!rules.every(Array.isArray)) throw Error("invalid rule hosts");
      const sets = [globalHosts, ...rules.map((set) => set.map(canonicalizeHost))];
      if (sets.some((set) => !set.length)) throw Error("empty fetch host intersection");
      const candidates = sets.flat().filter((host) => host !== "*");
      if (
        !sets.every((set) => set.includes("*")) &&
        !candidates.some((key) => {
          const h = splitHost(key);
          return sets.every((set) => matches(set, h.hostname, +(h.port ?? 443)));
        }) &&
        !candidates.some((key) => {
          const h = splitHost(key);
          return sets.every((set) => matches(set, h.hostname, +(h.port ?? 80)));
        })
      )
        throw Error("empty fetch host intersection");
      const token = randomBytes(32).toString("hex");
      const credential = Buffer.from(`lease:${token}`).toString("base64");
      const state = { sets, active: true, sockets: new Set<Duplex>() };
      credentials.set(credential, state);
      const proxy = `http://lease:${token}@127.0.0.1:${port}`;
      return {
        port,
        env: {
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ALL_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          all_proxy: proxy,
          NO_PROXY: "",
          no_proxy: "",
        },
        async release() {
          state.active = false;
          credentials.delete(credential);
          for (const socket of state.sockets) socket.destroy();
        },
      };
    },
    async close() {
      closed = true;
      credentials.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
