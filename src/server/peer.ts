// peer() — one aio app using another, by appId. Finds the running instance
// (lock files, no fixed port), connects over TCP or the local socket, and
// calls its methods BY NAME: no source of the other app, no cell definition,
// no client library. Everything the other app allows a client — and nothing
// more — goes through its own door: auth, `access`, `visible`.
//
//   const p = await peer("billing");          // null → not running
//   if (!p) return;
//   await p.describe();                       // what I may call
//   const id = await p.call("ledger", "credit", 42);
import { _connectCli, _connectCliUDS, type CliLink } from "./cli-client.ts";
import { resolve } from "@std/path";
import {
  AppLock,
  type InstanceInfo,
  instances,
  liveInstancesUnder,
} from "./single-instance-lock.ts";
import { appsDirEnv, instanceAppsDir, instanceNameError } from "./app-dirs.ts";
import { PEER_HEADER, signPeer } from "./peer-proof.ts";
import { log } from "../diagnostics/logger-api.ts";
import { endpointOf, servesTls } from "./lock-owner.ts";
import { isPipePath } from "./local-listen.ts";
import { errorCode } from "../protocol/envelope.ts";
import { DESCRIBE_TYPE, type PeerDescription } from "./peer-describe.ts";

const DESCRIBE_CELL = DESCRIBE_TYPE.slice(0, DESCRIBE_TYPE.indexOf(":"));
const DESCRIBE_METHOD = DESCRIBE_TYPE.slice(DESCRIBE_TYPE.indexOf(":") + 1);

export type { PeerDescription, PeerMethod } from "./peer-describe.ts";

/** Options of {@linkcode peer}.
 *  @experimental */
export type PeerOptions = {
  /** The other app's token, when it has auth — a string, or a function
   *  resolved before every (re)connect (see `connectCli`). */
  token?: string | (() => string | Promise<string>);
  /** A call made while disconnected: `"fail"` (default) rejects at once and
   *  is never sent later — a service answer is only worth having now.
   *  `"queue"` holds it and sends it on reconnect (`connectCli`'s default). */
  offline?: "fail" | "queue";
  /** How long the first connection may take, ms (default 5000). A wrong
   *  token or address throws instead of hanging. */
  readyTimeoutMs?: number;
  /** Ceiling for one call, ms (0 = wait for ever; default `connectCli`'s).
   *  A `stream()` restarts it at every chunk: it bounds the silence. */
  ackTimeoutMs?: number;
  /** Which local aio app this caller speaks FOR — its identity is proven to
   *  the other app (which admits it with `resolvePeer`). Default: the one app
   *  running in this process; none (a plain script) → no identity. Only for
   *  an appId target: a URL names no app to prove it to. */
  as?: string;
  /** Which `--instance` scope to find an appId in: a name (as `am start
   *  --instance=<name>` uses), or `null` for the default scope (no
   *  `--instance`). Absent: this process's own scope. An app started with
   *  `--instance=agent1` reaches a service running as the default instance
   *  with `{ instance: null }`. An identity (`as`) is proven within one scope
   *  only — a call into another scope carries none (asking for one throws).
   *  Only for an appId target. */
  instance?: string | null;
};

/** Keys the runtime reads on any object — never sent as a call. */
const NOT_METHODS = new Set([
  "then",
  "toJSON",
  "toString",
  "valueOf",
  "constructor",
  "inspect",
]);

// deno-lint-ignore no-explicit-any
type Fn = (...a: any[]) => any;

/** The callable half of `T`, every method answering over the wire. `T` is any
 *  interface of methods — a type the other app publishes, or `typeof cell`.
 *  @experimental */
export type PeerCell<T> = {
  [K in keyof T as T[K] extends Fn ? K : never]: T[K] extends
    (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

/** A streamed call: iterate its chunks as they come (`emitChunk` in the
 *  method), and `result` is what the method returned. A call that fails ends
 *  the iteration with its error, and `result` rejects with it.
 *  @experimental */
export type PeerStream<C = unknown, R = unknown> = AsyncIterable<C> & {
  readonly result: Promise<R>;
};

/** A blob stored in the other app (`peer().upload`).
 *  @experimental */
export type PeerBlob = { id: string; size: number; name?: string };

/** A connection to another aio app — see {@linkcode peer}.
 *  @experimental */
export type Peer<S = Record<string, unknown>> = {
  /** The appId (or URL) this peer was opened with. */
  readonly target: string;
  /** The other app's state as this caller may see it (null until first). */
  readonly state: S | null;
  readonly connected: boolean;
  /** Call `cell.method(...args)` in the other app; resolves with its return
   *  value. Rejects with the other app's reason (unknown method, access
   *  denied, the method threw) — or at once when offline (`offline: "fail"`). */
  call<R = unknown>(
    cell: string,
    method: string,
    ...args: unknown[]
  ): Promise<R>;
  /** A typed handle: `p.cell<Ledger>("ledger").credit(42)` = `p.call(…)`. */
  cell<T>(name: string): PeerCell<T>;
  /** `call`, receiving the result in pieces as the method sends them
   *  (`emitChunk`): `for await (const t of p.stream("chat", "ask", q))`. A
   *  method that sends none still works — no chunks, then `result`. */
  stream<C = unknown, R = unknown>(
    cell: string,
    method: string,
    ...args: unknown[]
  ): PeerStream<C, R>;
  /** The bytes of a blob in the other app's store (`app.blobs`), streamed —
   *  a method returns the id, this fetches it. `range`: bytes [start, end),
   *  integers with 0 ≤ start ≤ end (end past the blob's end is clamped);
   *  anything else, or a start past the end, throws. */
  blob(
    id: string,
    range?: { start: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  /** Put bytes into the other app's blob store, streamed; answers its id —
   *  pass that to a method. Only a PROVEN peer may (the other app sets
   *  `resolvePeer`); anyone else uploads through a route that app wrote. */
  upload(
    data: ReadableStream<Uint8Array> | Uint8Array | Blob,
    opts?: { name?: string },
  ): Promise<PeerBlob>;
  /** The cells and methods this caller may call — asked live, so it always
   *  matches the running app and this caller's rights. */
  describe(): Promise<PeerDescription>;
  /** Fires with `connected` each time it changes — false when the other app
   *  goes away, true when it is back (re-register, re-acquire) — on a new
   *  port too, for an appId target (followed by its lock). Returns
   *  unsubscribe. */
  onStatus(fn: (connected: boolean) => void): () => void;
  /** Fires on every state change of the other app; returns unsubscribe. */
  subscribe(fn: (state: S) => void): () => void;
  close(): void;
  [Symbol.dispose](): void;
};

/** Connect to another aio app. `target`: its appId (found among the running
 *  instances on this machine) or a URL (`http(s)://host:port`). Resolves
 *  `null` when no instance of that appId is running — the normal "service is
 *  not there" answer. THROWS on a misconfiguration: two running instances it
 *  cannot choose between, or a first connection that fails (wrong token,
 *  wrong address, untrusted certificate).
 *
 *  @experimental — the shape may still change while the first services adopt
 *  it; it joins the frozen surface after that. */
export async function peer<S = Record<string, unknown>>(
  target: string,
  opts: PeerOptions = {},
): Promise<Peer<S> | null> {
  const o = {
    offline: opts.offline ?? "fail",
    readyTimeoutMs: opts.readyTimeoutMs ?? 5_000,
    ...(opts.ackTimeoutMs !== undefined
      ? { ackTimeoutMs: opts.ackTimeoutMs }
      : {}),
  } as const;
  /** Asked for an identity it cannot carry: said, never dropped. */
  const noIdentity = (why: string) => {
    if (opts.as === undefined) return;
    throw new Error(`peer("${target}", { as: "${opts.as}" }): ${why}`);
  };
  if (opts.as !== undefined && opts.token !== undefined) {
    noIdentity("pass a token OR an identity — with a token, the token decides");
  }
  // Which scope's locks name the target: this process's own, or another
  // `--instance` (opts.instance), read without moving into it.
  let list = (id: string) => instances(id);
  let foreign = false;
  if (opts.instance !== undefined) {
    const said = `peer("${target}", { instance: ${
      JSON.stringify(opts.instance)
    } })`;
    if (target.includes("://")) {
      throw new Error(`${said}: a URL names no instance — pass the appId`);
    }
    const bad = opts.instance === null
      ? null
      : instanceNameError(opts.instance);
    if (bad) throw new Error(`${said}: ${bad}`);
    const root = opts.instance === null
      ? ""
      : resolve(instanceAppsDir(opts.instance));
    if (root !== (appsDirEnv() ?? "")) {
      foreign = true;
      noIdentity(
        "an identity is proven within one --instance scope, and that one is " +
          "not this process's — drop `as`, or give the service a token",
      );
      list = (id) => liveInstancesUnder(root).filter((i) => i.appId === id);
    }
  }
  let link: CliLink<S>;
  /** The HTTP side of the same door (blobs) — absent for an app whose only
   *  door is its NDJSON socket. */
  let http:
    | {
      base: () => string;
      headers: () => Promise<Record<string, string>>;
      /** Set when the HTTP door is a unix socket: every request goes there. */
      client?: Deno.HttpClient;
      /** How a failure names the door. */
      where: () => string;
    }
    | undefined;
  const tokenHeader = async (): Promise<Record<string, string>> => {
    const t = typeof opts.token === "function"
      ? await opts.token()
      : opts.token;
    return t ? { authorization: `Bearer ${t}` } : {};
  };
  if (target.includes("://")) {
    noIdentity("a URL names no app to prove an identity to — pass its appId");
    link = _connectCli<S>(target, { ...o, token: opts.token });
    const u = new URL(target);
    const secure = u.protocol === "https:" || u.protocol === "wss:";
    const base = `${secure ? "https" : "http"}://${u.host}`;
    http = { base: () => base, headers: tokenHeader, where: () => base };
  } else {
    const live = pickInstance(target, list);
    if (!live) return null;
    // The port when there is one (it carries a token; the socket does not),
    // the socket only for a socket-only app. A lock written before `host` was
    // recorded: the default loopback bind.
    const at = live.port > 0
      ? endpointOf({ port: live.port, host: live.host }) ??
        { hostnames: ["127.0.0.1"], port: live.port }
      : endpointOf(live);
    if (!at) {
      throw new Error(
        `peer("${target}"): the running instance (pid ${live.pid}) has ` +
          `neither a port nor a socket — it cannot be called`,
      );
    }
    const hs = live.httpSocketPath;
    if ("socket" in at) {
      if (opts.token !== undefined) {
        throw new Error(
          `peer("${target}"): it listens on local sockets only, whose calls ` +
            `carry no token — a token cannot be sent. Start it with a port, ` +
            `or drop the token (the socket admits only this OS user).`,
        );
      }
      // Calls go over the NDJSON socket (a named pipe on Windows), proven by
      // an identity hello — the same proof as a TCP handshake, keyed to the
      // boot holding THAT socket. A socket-only app (the Electron default)
      // also serves its HTTP handler on a unix socket beside it: the blob
      // store's door, with the same proof.
      const self = foreign ? undefined : selfFor(target, opts.as);
      const sock = at.socket;
      const proofAt = (holds: (i: InstanceInfo) => boolean, door: string) =>
        self ? () => proofFor(self, target, holds, door, opts.as) : undefined;
      const callProof = proofAt(
        (i) => i.socketPath === sock,
        `socket ${sock}`,
      );
      if (hs && !isPipePath(hs)) {
        const proof = proofAt((i) => i.httpSocketPath === hs, `socket ${hs}`);
        http = {
          base: () => "http://localhost",
          headers: async () => proof ? await proof() : {},
          client: Deno.createHttpClient({
            proxy: { transport: "unix", path: hs },
          }),
          where: () => `the socket ${hs}`,
        };
      }
      link = _connectCliUDS<S>(sock, {
        ...o,
        ...(callProof
          ? { proof: async () => (await callProof())[PEER_HEADER] }
          : {}),
      });
    } else {
      const h = at.hostnames.includes("127.0.0.1")
        ? "127.0.0.1"
        : at.hostnames[0]!;
      const host = h.includes(":") ? `[${h}]` : h;
      let scheme = servesTls(live) ? "https" : "http";
      let port = at.port;
      const base = () => `${scheme}://${host}:${port}`;
      // Proven on loopback only — the callee refuses a proof from any other
      // address, and a working anonymous call must not turn into a 401.
      const loop = h === "127.0.0.1" || h === "::1";
      if (!loop) {
        noIdentity(`it listens on ${h}; identity is proven on loopback only`);
      }
      const self = loop && opts.token === undefined && !foreign
        ? selfFor(target, opts.as)
        : undefined;
      const proof = self
        ? () =>
          proofFor(
            self,
            target,
            (i) => i.port === port,
            `port ${port}`,
            opts.as,
          )
        : undefined;
      http = {
        base,
        headers: async () => ({
          ...await tokenHeader(),
          ...(proof ? await proof() : {}),
        }),
        where: base,
      };
      link = _connectCli<S>(base(), {
        ...o,
        token: opts.token,
        ...(proof ? { headers: proof } : {}),
        // A restarted app binds a FREE port, so its next boot is almost never
        // on the old one: re-read the lock files before every reconnect and
        // follow it — same bind address, a new port. Two instances, none, or
        // one on another address: stay put (the old port may come back).
        retarget: () => {
          let now;
          try {
            now = pickInstance(target, list);
          } catch {
            return undefined; // two instances: never guess between them
          }
          if (!now || now.port <= 0 || now.port === port) return undefined;
          const e = endpointOf({ port: now.port, host: now.host });
          if (e && "hostnames" in e && !e.hostnames.includes(h)) {
            return undefined;
          }
          port = now.port;
          scheme = servesTls(now) ? "https" : "http";
          return base();
        },
      });
    }
  }
  let shut = false;
  const close = () => {
    shut = true;
    link.close();
    try {
      http?.client?.close();
    } catch { /* aio-ok: closed already — close() is idempotent */ }
  };
  try {
    await link.ready;
  } catch (e) {
    close();
    // peer() gives up here, so the client's "reconnection continues" is not
    // true of it.
    throw new Error(
      `peer("${target}"): ${
        (e as Error).message.replace(/ Reconnection continues.*$/s, "")
      }`,
      { cause: e },
    );
  }

  const call = <R>(cell: string, method: string, ...args: unknown[]) =>
    link.call(cell, method, ...args) as Promise<R>;
  /** One HTTP exchange with the other app's blob door, failing loud. */
  const fetchDoor = async (path: string, init: RequestInit = {}) => {
    // As call() after close(): refused, not quietly served by a door this
    // handle no longer holds.
    if (shut) {
      throw new Error(
        `peer("${target}"): closed — ${init.method ?? "GET"} ${path} was ` +
          `not sent (open a new peer())`,
      );
    }
    if (!http) {
      throw new Error(
        `peer("${target}"): it has no HTTP door this caller can reach — ` +
          `blob bytes travel over HTTP, and it serves none on a port or a ` +
          `unix socket (a production app with no routes serves no HTTP at ` +
          `all; on Windows its HTTP door is a named pipe). Start it with a ` +
          `port (--port=N)`,
      );
    }
    const method = init.method ?? "GET";
    let res: Response;
    try {
      res = await fetch(`${http.base()}${path}`, {
        ...init,
        headers: { ...await http.headers(), ...(init.headers ?? {}) },
        ...(http.client ? { client: http.client } : {}),
      });
    } catch (e) {
      // A bare "fetch failed" named neither the app nor the door.
      const why = (e as Error).cause ?? e;
      throw new Error(
        `peer("${target}") ${method} ${path} failed — ${
          (why as Error)?.message ?? why
        }${
          link.connected
            ? ""
            : ` (not connected to it now: ${http.where()} is down or moved)`
        }`,
        { cause: e },
      );
    }
    if (!res.ok && res.status !== 206) {
      const why = await res.text().catch(() => "");
      throw new Error(
        `peer("${target}") ${method} ${path}: ${res.status} ${
          why.slice(0, 200)
        }`,
      );
    }
    return res;
  };
  return {
    target,
    get state() {
      return link.state;
    },
    get connected() {
      return link.connected;
    },
    call,
    cell<T>(name: string): PeerCell<T> {
      return new Proxy({}, {
        // Only method names call out: `await`, `JSON.stringify`, `String()`
        // and inspection read these, and none of them is a remote method.
        get: (_, key) =>
          typeof key === "string" && !NOT_METHODS.has(key)
            ? (...args: unknown[]) => call(name, key, ...args)
            : undefined,
      }) as PeerCell<T>;
    },
    describe: () =>
      call<PeerDescription>(DESCRIBE_CELL, DESCRIBE_METHOD).catch((e) => {
        // Only an app that does not know the request answers "unknown cell";
        // every other failure (offline, timeout, lost) is passed through as is.
        if (
          errorCode(e) !== "ACTION_REFUSED" ||
          !String((e as Error)?.message).includes(`'${DESCRIBE_CELL}'`)
        ) throw e;
        throw new Error(
          `peer("${target}").describe(): ${(e as Error).message} — this app ` +
            `runs an aio older than describe(); call() still works`,
          { cause: e },
        );
      }),
    stream<C, R>(cell: string, method: string, ...args: unknown[]) {
      return chunked<C, R>((onChunk) =>
        link.stream(cell, method, args, onChunk) as Promise<R>
      );
    },
    async blob(id, range) {
      if (!/^[0-9a-f]{64}$/.test(id)) {
        throw new Error(`peer("${target}").blob: not a blob id: ${id}`);
      }
      const { start = 0, end } = range ?? {};
      if (
        !Number.isSafeInteger(start) || start < 0 ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))
      ) {
        throw new RangeError(
          `peer("${target}").blob: not a byte range [${start}, ${end}) — ` +
            `integers, 0 ≤ start ≤ end`,
        );
      }
      if (end === start) return new Response(new Uint8Array()).body!;
      const ranged = start > 0 || end !== undefined;
      const res = await fetchDoor(`/__aio/blobs/${id}`, {
        ...(ranged
          ? {
            headers: {
              range: `bytes=${start}-${end === undefined ? "" : end - 1}`,
            },
          }
          : {}),
      });
      // A valid range inside the blob is always a 206 (past its end is a 416,
      // already thrown); a ranged ask answered whole is the wrong bytes.
      if (ranged && res.status !== 206) {
        await res.body?.cancel();
        throw new Error(
          `peer("${target}").blob: asked bytes [${start}, ${end ?? "end"}) ` +
            `of ${id}, got ${res.status} instead of 206`,
        );
      }
      return res.body ?? new Response(new Uint8Array()).body!;
    },
    async upload(data, o = {}) {
      const q = o.name ? `?name=${encodeURIComponent(o.name)}` : "";
      const res = await fetchDoor(`/__aio/blobs${q}`, {
        method: "POST",
        // A typed array's buffer may be shared; the body takes a Blob of it.
        body: data instanceof Uint8Array ? new Blob([data as BlobPart]) : data,
      });
      return await res.json() as PeerBlob;
    },
    subscribe: (fn) => link.subscribe(fn),
    onStatus: (fn) => link.onStatus(fn),
    close,
    [Symbol.dispose]: close,
  };
}

/** The ONE started instance of `appId`. Several (two data homes) → throw,
 *  naming them: guessing would call the wrong app's data. */
function pickInstance(
  appId: string,
  list: (id: string) => InstanceInfo[] = instances,
) {
  const up = list(appId).filter((i) =>
    i.alive && i.status === "started" && !i.maintenance
  );
  if (up.length <= 1) return up[0];
  throw new Error(
    `peer("${appId}"): ${up.length} instances are running (${
      up.map((i) =>
        `pid ${i.pid} ${
          i.port > 0 ? `port ${i.port}` : `socket ${i.socketPath}`
        } home ${i.home ?? "default"}`
      ).join("; ")
    }) — stop the one you do not mean, or pass its URL: ` +
      `peer("http://127.0.0.1:<port>") (a socket-only instance has no URL)`,
  );
}

/** The local app this process speaks for when calling `target`: `as`, else
 *  the ONE app running here (none, or several: no identity — said in debug,
 *  since most targets do not ask). `as` naming no app here throws. */
function selfFor(target: string, as: string | undefined): AppLock | undefined {
  const mine = AppLock.live().filter((l) => l.appId !== target);
  if (as !== undefined) {
    const self = mine.find((l) => l.appId === as);
    if (self) return self;
    throw new Error(
      `peer("${target}", { as: "${as}" }): no app "${as}" runs in this ` +
        `process (running: ${mine.map((l) => l.appId).join(", ") || "none"})`,
    );
  }
  if (mine.length === 1) return mine[0];
  if (mine.length > 1) {
    log.debug(
      "peer",
      `peer("${target}"): ${mine.length} apps run in this process and no ` +
        `{ as } says which is calling — no identity sent`,
    );
  }
  return undefined;
}

/** The proof header for THIS (re)connect: signed for the boot of `target`
 *  that holds the door (`holds`: its port, or its HTTP socket) now. None when
 *  that boot is gone — a listener squatting the door while the callee is down
 *  is never handed a proof. */
async function proofFor(
  self: AppLock,
  target: string,
  holds: (i: InstanceInfo) => boolean,
  door: string,
  as: string | undefined,
): Promise<Record<string, string>> {
  const live = instances(target).filter((i) =>
    i.alive && i.status === "started" && !i.maintenance && holds(i)
  );
  if (live.length !== 1) {
    const say = `peer("${target}"): no identity sent — ${
      live.length === 0
        ? `no started instance holds ${door} now`
        : `${live.length} instances hold ${door}`
    }`;
    if (as !== undefined) log.warn("peer", say);
    else log.debug("peer", say);
    return {};
  }
  const r = await signPeer(self.appId, self.home, target, live[0]!.pid);
  if ("header" in r) return { [PEER_HEADER]: r.header };
  const say = `peer("${target}"): no identity for "${self.appId}" — ${r.error}`;
  if (as !== undefined) log.warn("peer", say);
  else log.debug("peer", say);
  return {};
}

/** A streamed call as an async iterable: chunks queue as they arrive and are
 *  handed out in order; the call's end (or error) ends the iteration. */
function chunked<C, R>(
  start: (onChunk: (value: unknown) => void) => Promise<R>,
): PeerStream<C, R> {
  const queue: C[] = [];
  /** Every iterator waiting — one slot let a second iterator's wait replace
   *  the first's, which then never woke. */
  let waiting: (() => void)[] = [];
  const wakeAll = () => {
    const w = waiting;
    waiting = [];
    for (const r of w) r();
  };
  let done = false;
  let failed: { error: unknown } | null = null;
  const result = start((value) => {
    queue.push(value as C);
    wakeAll();
  });
  result.then(
    () => done = true,
    (error) => {
      done = true;
      failed = { error };
    },
  ).finally(wakeAll);
  // Iterating is how most callers read it; a failure then surfaces there, so
  // `result` alone must not also crash the process as unhandled.
  result.catch(() => {
    // aio-ok: the same rejection is delivered by the iteration and by
    // `result` itself — this only stops it counting as unhandled
  });
  return {
    result,
    // A reader that breaks out leaves the rest queued: a later `for await`
    // over the same stream picks up where it stopped (as in 1.0.24).
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) {
          if (failed) throw (failed as { error: unknown }).error;
          return;
        }
        await new Promise<void>((r) => waiting.push(r));
      }
    },
  };
}
