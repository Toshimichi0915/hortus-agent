/**
 * A hostile upstream and the Worker attacking through hortusd's proxy, in one forked child, so that
 * neither the server's nor the client's work runs on the event loop the test measures. The parent sends
 * `{ attack, proxy, n }` over IPC and gets `{ result }` back; `{ open }` reports the server's open sockets.
 *
 * Upstream hosts (reached through `dev.upstreams`, routed by Host): `slow.test` (headers, then a byte a second),
 * `never.test` (never answers), `endless.test` (an endless fast chunked body), `huge.test` (1 GB, content-length),
 * `headers.test` (100 MB of headers), `bomb.test` (gzip of 256 MB of zeros), `ws.test` (WebSocket: `flood` sends 64 KB
 * text frames without end, `fragments` an unending fragmented message). `tls` is a TCP port that never speaks TLS.
 */
import http from "node:http";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";

const MB = 1024 * 1024;
const sockets = new Set<Socket>();
const track = (s: Socket) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
  s.on("error", () => {});
};

const chunk = Buffer.alloc(64 * 1024, "a");
// 256 MB of zeros, gzipped (~250 KB), made on first use
let bomb: Buffer | undefined;

/** Writes `chunk` while the socket takes it, for as long as it stays open. */
function pump(res: http.ServerResponse, left = Number.POSITIVE_INFINITY): void {
  const go = () => {
    while (left > 0 && !res.destroyed) {
      const c = left >= chunk.length ? chunk : chunk.subarray(0, left);
      left -= c.length;
      if (!res.write(c)) return void res.once("drain", go);
    }
    if (left <= 0) res.end();
  };
  go();
}

const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  req.resume();
  switch (host) {
    case "slow.test": {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write("a")), 1000);
      return;
    }
    case "never.test":
      return;
    case "endless.test":
      res.writeHead(200, { "content-type": "application/json" });
      return pump(res);
    case "huge.test":
      res.writeHead(200, { "content-type": "application/json", "content-length": String(1024 * MB) });
      return pump(res, 1024 * MB);
    case "headers.test": {
      // raw: 100 MB of header lines, as fast as the socket takes them
      const s = res.socket as Socket;
      s.write("HTTP/1.1 200 OK\r\n");
      const line = Buffer.from(`x-junk: ${"j".repeat(8000)}\r\n`);
      let n = 0;
      const go = () => {
        while (n < (100 * MB) / line.length && !s.destroyed) {
          n++;
          if (!s.write(line)) return void s.once("drain", go);
        }
      };
      return go();
    }
    case "bomb.test":
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      bomb ??= gzipSync(Buffer.alloc(256 * MB));
      return res.end(bomb);
    default:
      res.writeHead(404).end();
  }
});
server.on("connection", track);
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  if (req.url === "/flood") {
    const go = () => {
      while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8 * MB) ws.send(chunk.toString());
      if (ws.readyState === WebSocket.OPEN) setTimeout(go, 5);
    };
    go();
  } else if (req.url === "/fragments") {
    const go = () => {
      for (let i = 0; i < 64 && ws.readyState === WebSocket.OPEN; i++) ws.send(chunk.toString(), { fin: false });
      if (ws.readyState === WebSocket.OPEN) setTimeout(go, 5);
    };
    go();
  }
});
// read (and drop) the ClientHello, so the peer's close is seen
const tls = createServer((s) => {
  track(s);
  s.resume();
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));

// ---- the attacking Worker ------------------------------------------------------------------------------------------

interface Ask {
  attack: string;
  proxy: number;
  n: number;
  ms: number;
  /** the Worker's local address (default 127.0.0.2); `swarm` uses `clients` addresses from 127.0.0.2 up */
  from?: string;
  clients?: number;
}

/** One request through the proxy as the Worker (local address 127.0.0.2); reads up to `max` bytes, gives up at `ms`. */
function get(
  a: Ask,
  host: string,
  o: { path?: string; method?: string; body?: string; max?: number; hold?: boolean } = {},
): Promise<string> {
  return new Promise((resolve) => {
    let got = 0;
    const r = http.request(
      {
        host: "127.0.0.1",
        port: a.proxy,
        localAddress: a.from ?? "127.0.0.2",
        method: o.method ?? "GET",
        path: o.path ?? "/",
        // not the global agent: its SO_KEEPALIVE at 1 s, 10 probes, on 2,640 sockets dropped its own probes on a loaded
        // loopback and the kernel ended a search with ETIMEDOUT
        agent: false,
      },
      (res) => {
        res.on("data", (c: Buffer) => {
          got += c.length;
          if (got >= (o.max ?? Number.POSITIVE_INFINITY)) {
            r.destroy();
            resolve(`${res.statusCode} read ${Math.round(got / MB)} MB`);
          }
        });
        res.on("end", () => resolve(String(res.statusCode)));
        res.on("error", () => resolve(`${res.statusCode} cut`));
      },
    );
    r.setHeader("host", host);
    r.on("error", (e) =>
      resolve(
        `error ${(e as NodeJS.ErrnoException).code ?? e.message} ${(e as NodeJS.ErrnoException).syscall ?? ""}`.trim(),
      ),
    );
    setTimeout(() => {
      r.destroy();
      resolve("gave up");
    }, a.ms).unref();
    // hold: the body is written but never ended (a Worker holding its request open)
    if (o.hold) r.write(o.body ?? "");
    else r.end(o.body);
  });
}

/** `{ "<outcome>": count }` */
const tally = (xs: string[]) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
};

/** A WebSocket through the proxy that never reads (its socket paused), open for `ms`. */
function wsIdle(a: Ask, path: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${a.proxy}${path}`, {
      headers: { host: "ws.test" },
      localAddress: "127.0.0.2",
    } as WebSocket.ClientOptions);
    let closed = "open";
    ws.on("upgrade", (res) => res.socket.pause());
    ws.on("error", (e) => (closed = `error ${e.message}`));
    ws.on("close", (code) => (closed = `closed ${code}`));
    setTimeout(() => {
      ws.terminate();
      resolve(closed);
    }, a.ms);
  });
}

async function run(a: Ask): Promise<unknown> {
  const many = (f: () => Promise<string>) => Promise.all(Array.from({ length: a.n }, f)).then(tally);
  switch (a.attack) {
    case "slow":
      return many(() => get(a, "slow.test"));
    case "never":
      return many(() => get(a, "never.test"));
    case "tls":
      return many(() => get(a, "tls.test"));
    case "endless":
      return many(() => get(a, "endless.test", { max: 24 * MB }));
    case "huge":
      return many(() => get(a, "huge.test", { max: 24 * MB }));
    case "headers":
      return many(() => get(a, "headers.test"));
    case "bomb":
      return many(() => get(a, "bomb.test", { max: 24 * MB }));
    case "flood":
      return many(() => wsIdle(a, "/flood"));
    case "fragments":
      return many(() => wsIdle(a, "/fragments"));
    case "search":
      // a.n searches for a common trigram at once, as the Worker's RPC
      return many(() =>
        get(a, "hortusd.internal", {
          method: "POST",
          path: "/rpc/dof.search",
          body: JSON.stringify({ q: "the", limit: 200 }),
        }),
      );
    case "swarm": {
      // `clients` Workers at once, each with a.n searches, a.n never-answered requests and 4 endless bodies
      const each = await Promise.all(
        Array.from({ length: a.clients ?? 20 }, (_, i) => {
          const w = { ...a, from: `127.0.0.${2 + i}` };
          return Promise.all([
            ...Array.from({ length: a.n }, () =>
              get(w, "hortusd.internal", {
                method: "POST",
                path: "/rpc/dof.search",
                body: JSON.stringify({ q: "the", limit: 200 }),
              }).then((r) => `search ${r}`),
            ),
            ...Array.from({ length: a.n }, () => get(w, "never.test").then((r) => `never ${r}`)),
            ...Array.from({ length: 4 }, () => get(w, "endless.test", { max: 24 * MB }).then((r) => `endless ${r}`)),
          ]);
        }),
      );
      return tally(each.flat());
    }
    case "bodies": {
      // `clients` Workers, each holding a.n request bodies of just under 1 MB open (written, never ended), half as
      // RPCs and half through the pipeline to a buffering host
      const body = "x".repeat(MB - 1024);
      const each = await Promise.all(
        Array.from({ length: a.clients ?? 1 }, (_, i) => {
          const w = { ...a, from: `127.0.0.${2 + i}` };
          return Promise.all(
            Array.from({ length: a.n }, (_, j) =>
              j % 2
                ? get(w, "never.test", { method: "POST", body, hold: true })
                : get(w, "hortusd.internal", { method: "POST", path: "/rpc/ping", body, hold: true }),
            ),
          );
        }),
      );
      return tally(each.flat());
    }
    default:
      throw new Error(`no attack ${a.attack}`);
  }
}

process.on("message", (m: Ask | { open: true }) => {
  if ("open" in m) return process.send?.({ open: sockets.size });
  run(m).then(
    (result) => process.send?.({ result }),
    (e) => process.send?.({ error: String(e) }),
  );
});
process.send?.({
  ports: { http: (server.address() as AddressInfo).port, tls: (tls.address() as AddressInfo).port },
});
