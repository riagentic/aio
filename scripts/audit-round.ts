#!/usr/bin/env -S deno run -A
// scripts/audit-round.ts — randomized adversarial probes over the alpha72 work
// AND the code it touches.
//
// Not a test file: tests pin the behaviour someone decided on. This asks a
// different question — "what happens on an input nobody chose" — with a seed
// on the command line so any answer it finds can be replayed exactly.
//
//   deno run -A scripts/audit-round.ts <round> [--seed=N]
//
// A round prints `FINDING: …` for anything it cannot explain and exits 1.
// Silence and exit 0 mean the round asked its question and got a defensible
// answer every time.
import {
  _clearEncodedCache,
  availableEncodings,
  compress,
  encodeResponse,
  etagMatches,
  etagOf,
  isCompressible,
  isStreamingType,
  mergeVary,
  negotiate,
} from "../src/server/http-encoding.ts";
import {
  contentSecurityPolicy,
  frameAncestors,
  securityHeaders,
} from "../src/server/security-headers.ts";
import {
  composeAsyncHooks,
  composeHooks,
  definePlugin,
  type Plugin,
  resolvePlugins,
} from "../src/server/plugin.ts";
import { hunksOf, mergeText3, tokenize } from "../src/sync/merge-text.ts";
import { mergeField } from "../src/sync/merge.ts";
import type { HLC } from "../src/sync/types.ts";
import { appThemeCss, appThemeTokensCss } from "../src/build/app-theme.ts";
import { UI_CSS } from "../src/ui/styles.ts";
import { cell, composeCells } from "../mod.ts";
import { appMeantHint, parseNumArg } from "../src/am/am-utils.ts";
import { cloneState } from "../src/state/immutable.ts";
import {
  _resetStopProcess,
  _setExitFn,
  _setWatchdogMs,
  registerRuntime,
  stopProcess,
} from "../src/server/shutdown.ts";
import * as winMod from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, mount, setDevMode } from "../src/air/aio-renderer.ts";
import {
  _resetControlIds,
  Alert,
  Breadcrumb,
  EmptyState,
  Menu,
  Progress,
  RadioGroup,
  Skeleton,
  Switch,
  Tabs,
  Tooltip,
} from "../src/ui/controls.ts";
import {
  CONFIG_DOCS,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
} from "../src/server/config.ts";
import { testServer } from "../src/testing/server-test.ts";
import { cspHostSource } from "../src/server/security-headers.ts";
import {
  frozenWriteMessage,
  isFrozenWriteError,
} from "../src/state/immutable.ts";
import {
  _resetFrozenWriteHint,
  log as logApi,
} from "../src/diagnostics/logger-api.ts";
import { produceWithPatches } from "immer";
import {
  applyCellFieldFilter,
  filterPatchesByStrategy,
} from "../src/state/state-filter.ts";
import { applyWirePatches, type WirePatch } from "../src/protocol/patch-ops.ts";
import { narrowStringPatches } from "../src/state/patch-compact.ts";
import { parseCli } from "../src/server/aio-cli.ts";
import { awaitPredecessor } from "../src/server/updates-apply.ts";
import {
  AIO_RUNTIME_FLAG_SPECS,
  AIO_RUNTIME_FLAGS,
} from "../src/diagnostics/runtime-flags.ts";

// ── harness ─────────────────────────────────────────────────────────

const findings: string[] = [];
function finding(round: string, msg: string): void {
  findings.push(`[${round}] ${msg}`);
}

/** Deterministic PRNG — an audit that cannot be replayed is an anecdote. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));

/** Strings chosen to break things: empty, whitespace, control chars, unicode
 *  planes, surrogate pairs, RTL marks, very long, injection-shaped. */
const NASTY = [
  "",
  " ",
  "\n",
  "\r\n",
  "\t",
  "\0",
  "a",
  "ünïcödé",
  "🙂👨‍👩‍👧‍👦",
  "\u{1F600}\u{1F601}",
  "עברית",
  "العربية",
  "中文字符",
  "​‎‮",
  '"; DROP TABLE x; --',
  "<script>alert(1)</script>",
  "../../etc/passwd",
  "a".repeat(5000),
  "line\n".repeat(200),
  "\\",
  "%00",
  "${x}",
  "`x`",
];

const A: HLC = [1000, 0, "a"];
const B: HLC = [2000, 0, "b"];
const enc = new TextEncoder();

// ── rounds ──────────────────────────────────────────────────────────

/** 1 — encodeResponse never changes what a body SAYS. */
async function round1(r: () => number): Promise<void> {
  const TYPES = [
    "text/html",
    "text/plain; charset=utf-8",
    "application/json",
    "application/javascript",
    "image/png",
    "image/svg+xml",
    "font/woff2",
    "application/octet-stream",
    "text/event-stream",
    "application/x-ndjson",
    "multipart/mixed; boundary=x",
    "application/wasm",
  ];
  for (let i = 0; i < 600; i++) {
    const ct = pick(r, TYPES);
    const body = r() < 0.2
      ? pick(r, NASTY)
      : pick(r, NASTY).repeat(int(r, 1, 60));
    const headers: Record<string, string> = { "Content-Type": ct };
    if (r() < 0.3) {
      headers["Cache-Control"] = pick(r, [
        "no-cache",
        "no-store",
        "public, max-age=60",
        "no-transform",
      ]);
    }
    if (r() < 0.15) headers["ETag"] = `"seeded-${i}"`;
    if (r() < 0.15) headers["Set-Cookie"] = `sid=${i}; HttpOnly`;
    const ae = pick(r, [
      "br, gzip",
      "gzip",
      "deflate",
      "*",
      "identity",
      "gzip;q=0",
      "",
    ]);
    const method = pick(r, ["GET", "GET", "GET", "HEAD"]);
    const req = new Request("http://x/probe", {
      method,
      headers: ae ? { "Accept-Encoding": ae } : {},
    });
    // Streaming types must never be buffered; give them a body that never ends
    // so a regression HANGS this round rather than passing it.
    const isStream = isStreamingType(ct);
    const resp = isStream
      ? new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(body));
          },
        }),
        { headers },
      )
      : new Response(body, { headers });

    let out: Response;
    try {
      out = await encodeResponse(req, resp);
    } catch (e) {
      finding("1", `threw on ct=${ct} ae=${ae}: ${e}`);
      continue;
    }
    if (isStream) {
      if (out !== resp) finding("1", `a ${ct} stream was not passed through`);
      await out.body?.cancel();
      continue;
    }
    if (out.status === 304) {
      finding("1", `unexpected 304 with no If-None-Match (ct=${ct})`);
      continue;
    }
    // Whatever the encoding, the DECODED body must be the body.
    const ce = out.headers.get("Content-Encoding");
    if (method === "HEAD") {
      // Deno's HTTP layer drops a HEAD body itself (verified), so a
      // body-bearing Response here is harmless. What matters is that a HEAD
      // never advertises an encoding a GET would not have sent, and never
      // advertises a length that is not the identity length.
      if (ce) finding("1", `HEAD advertised ${ce}`);
      const hl = out.headers.get("Content-Length");
      if (hl !== null && Number(hl) !== enc.encode(body).length) {
        finding("1", `HEAD Content-Length ${hl} != ${enc.encode(body).length}`);
      }
      await out.body?.cancel();
      continue;
    }
    let back: string;
    try {
      back = ce === null
        ? await out.text()
        : ce === "br"
        ? new TextDecoder().decode(
          (await import("node:zlib")).brotliDecompressSync(
            new Uint8Array(await out.arrayBuffer()),
          ),
        )
        : await new Response(
          out.body!.pipeThrough(
            new DecompressionStream(ce as "gzip" | "deflate"),
          ),
        ).text();
    } catch (e) {
      finding("1", `body could not be decoded (ct=${ct} ce=${ce}): ${e}`);
      continue;
    }
    if (back !== body) {
      finding(
        "1",
        `body CHANGED (ct=${ct} ce=${ce} len ${body.length}→${back.length})`,
      );
    }
    // An encoding must be one the client offered.
    if (ce) {
      const offered = ae === "*" ||
        ae.split(",").some((p) => p.trim().split(";")[0]!.trim() === ce);
      if (!offered) finding("1", `sent ${ce} for Accept-Encoding: "${ae}"`);
    }
    // Content-Length must match what is actually sent.
    const cl = out.headers.get("Content-Length");
    if (cl !== null && ce === null && Number(cl) !== enc.encode(body).length) {
      finding("1", `Content-Length ${cl} != ${enc.encode(body).length}`);
    }
  }
}

/** 2 — Accept-Encoding parsing never produces something not on offer. */
function round2(r: () => number): void {
  const TOK = [
    "gzip",
    "br",
    "deflate",
    "identity",
    "*",
    "zstd",
    "GZIP",
    "Br",
    "",
    "  ",
    "gzip;q=0",
    "br;q=0.0",
    "*;q=0",
    "gzip;q=1.0",
    "br;q=abc",
    "gzip;;q=1",
    ";q=1",
    "q=1",
  ];
  const AVAIL = [
    ["br", "gzip", "deflate"],
    ["gzip", "deflate"],
    ["gzip"],
    [],
  ] as const;
  for (let i = 0; i < 4000; i++) {
    const header = Array.from({ length: int(r, 0, 5) }, () => pick(r, TOK))
      .join(", ");
    const avail = pick(r, AVAIL);
    let got: string | null;
    try {
      got = negotiate(header || null, avail);
    } catch (e) {
      finding("2", `threw on ${JSON.stringify(header)}: ${e}`);
      continue;
    }
    if (got === null) continue;
    if (!avail.includes(got as never)) {
      finding("2", `chose ${got}, not available in [${avail.join(",")}]`);
    }
    // Never choose something explicitly refused with q=0.
    for (const part of header.split(",")) {
      const [name, ...ps] = part.split(";");
      if (name!.trim().toLowerCase() !== got) continue;
      if (ps.some((p) => /^\s*q\s*=\s*0(\.0+)?\s*$/i.test(p))) {
        finding("2", `chose ${got} despite q=0 in ${JSON.stringify(header)}`);
      }
    }
  }
}

/** 3 — the ETag is a usable equality token at scale. */
function round3(r: () => number): void {
  const seen = new Map<string, string>();
  const buf = new Uint8Array(int(r, 8, 512)) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < 200_000; i++) {
    crypto.getRandomValues(buf);
    const key = etagOf(buf);
    const body = String(buf.length) + ":" + buf.slice(0, 16).join(",");
    const prev = seen.get(key);
    if (prev !== undefined && prev !== body) {
      finding("3", `etag collision at ${i}: ${key}`);
      return;
    }
    seen.set(key, body);
  }
  // Stability: the same bytes must always give the same tag.
  const fixed = enc.encode("stability probe") as Uint8Array<ArrayBuffer>;
  const once = etagOf(fixed);
  for (let i = 0; i < 1000; i++) {
    if (etagOf(fixed) !== once) {
      finding("3", "etagOf is not deterministic");
      return;
    }
  }
  // And the quoted-string shape holds for every length.
  for (let n = 0; n < 300; n++) {
    const t = etagOf(new Uint8Array(n) as Uint8Array<ArrayBuffer>);
    if (!/^"[^"]+"$/.test(t)) finding("3", `malformed etag for len ${n}: ${t}`);
  }
}

/** 4 — If-None-Match handling, every documented spelling. */
function round4(r: () => number): void {
  const tag = '"abc123"';
  const CASES: [string, boolean][] = [
    [tag, true],
    [`W/${tag}`, true],
    [`  ${tag}  `, true],
    [`"zzz", ${tag}`, true],
    [`${tag}, "zzz"`, true],
    [`W/"zzz", W/${tag}`, true],
    ["*", true],
    [" * ", true],
    ['"zzz"', false],
    ["", false],
    ['"abc123', false],
    ['abc123"', false],
    ['"ABC123"', false],
  ];
  for (const [header, want] of CASES) {
    if (etagMatches(header, tag) !== want) {
      finding("4", `etagMatches(${JSON.stringify(header)}) !== ${want}`);
    }
  }
  // Never matches a DIFFERENT tag, however the header is shaped.
  for (let i = 0; i < 5000; i++) {
    const other = `"${int(r, 0, 1e9).toString(36)}"`;
    if (other === tag) continue;
    const header = pick(r, [other, `W/${other}`, `${other}, ${other}`]);
    if (etagMatches(header, tag)) {
      finding("4", `false match: ${header} vs ${tag}`);
    }
  }
  // Vary merging never loses a field.
  for (let i = 0; i < 2000; i++) {
    const existing = r() < 0.3 ? null : pick(r, [
      "Cookie",
      "Accept",
      "Accept-Encoding",
      "*",
      "Cookie, Accept",
    ]);
    const out = mergeVary(existing, "Accept-Encoding");
    if (
      existing && existing !== "*" && !out.includes(existing.split(",")[0]!)
    ) {
      finding("4", `mergeVary lost "${existing}" → "${out}"`);
    }
    if (existing === "*" && out !== "*") {
      finding("4", `mergeVary widened "*" → "${out}"`);
    }
  }
}

/** 5 — the security policy is always syntactically valid CSP. */
function round5(r: () => number): void {
  const ORIGIN_BITS = [
    "a.com",
    "https://a.com",
    "http://a.com:8080",
    "a.com:8080",
    "*",
    "",
    "  ",
    "https://a.com/",
    "https://a.com/path",
    "sub.domain.example",
    "127.0.0.1:3000",
    "[::1]:3000",
    ...NASTY.slice(0, 8),
  ];
  for (let i = 0; i < 3000; i++) {
    const origins = Array.from(
      { length: int(r, 0, 4) },
      () => pick(r, ORIGIN_BITS),
    );
    const cfg = {
      headers: r() < 0.9,
      csp: pick(r, ["basic", "strict", "off", false, undefined]) as never,
      frameOptions: r() < 0.8,
      hsts: pick(r, [true, false, "max-age=1", undefined]) as never,
    };
    let h: Record<string, string>;
    try {
      h = securityHeaders(cfg, {
        allowedOrigins: origins,
        secure: r() < 0.5,
        operatorCert: r() < 0.5,
      });
    } catch (e) {
      finding("5", `threw for origins=${JSON.stringify(origins)}: ${e}`);
      continue;
    }
    const csp = h["Content-Security-Policy"];
    if (!csp) continue;
    // A CSP is `directive source*` pairs separated by `;`. A newline or a
    // stray `;` inside a source would let a value break the header.
    if (/[\r\n]/.test(csp)) {
      finding("5", `CSP contains a newline: ${JSON.stringify(csp)}`);
    }
    for (const d of csp.split(";")) {
      const t = d.trim();
      if (!t) continue;
      if (!/^[a-z-]+( .+)?$/.test(t)) {
        finding("5", `malformed directive ${JSON.stringify(t)}`);
      }
    }
    // XFO and a permissive frame-ancestors must never disagree.
    const anc = frameAncestors(origins);
    if (h["X-Frame-Options"] && anc !== "'self'") {
      finding("5", `XFO sent alongside frame-ancestors "${anc}"`);
    }
    // Every header value must be a legal HTTP field value.
    for (const [k, v] of Object.entries(h)) {
      try {
        new Headers({ [k]: v });
      } catch {
        finding("5", `header ${k} is not a legal field value: ${v}`);
      }
    }
  }
  // The basic policy must never restrict what an app already loads.
  const basic = contentSecurityPolicy(undefined, "'self'")!;
  for (const forbidden of ["default-src", "script-src", "connect-src"]) {
    if (basic.includes(forbidden)) {
      finding("5", `the DEFAULT policy contains ${forbidden}`);
    }
  }
}

/** 6 — plugin resolution: every collision is caught, and only real ones. */
async function round6(r: () => number): Promise<void> {
  const CELL_IDS = ["a", "b", "c"];
  const ROUTES = ["/x", "/y", "/z"];
  const cells = Object.fromEntries(
    CELL_IDS.map((id) => [
      id,
      cell(`audit-${id}-${int(r, 0, 1e9)}`, { state: { n: 0 }, methods: {} }),
    ]),
  );
  for (let i = 0; i < 1500; i++) {
    const n = int(r, 0, 4);
    const specs = Array.from({ length: n }, (_, k) => ({
      name: `p${k}`,
      cells: Array.from({ length: int(r, 0, 2) }, () => pick(r, CELL_IDS)),
      routes: Array.from({ length: int(r, 0, 2) }, () => pick(r, ROUTES)),
    }));
    const plugins: Plugin[] = specs.map((sp) =>
      definePlugin({
        name: sp.name,
        cells: sp.cells.map((c) => cells[c]!),
        routes: Object.fromEntries(
          sp.routes.map((p) => [p, () => new Response("x")]),
        ),
      })
    );
    // What SHOULD collide: the same cell or route claimed by two plugins.
    const cellOwners = new Map<string, string>();
    const routeOwners = new Map<string, string>();
    let expectCollision = false;
    for (const sp of specs) {
      for (const c of new Set(sp.cells)) {
        if (cellOwners.has(c) && cellOwners.get(c) !== sp.name) {
          expectCollision = true;
        }
        cellOwners.set(c, sp.name);
      }
      for (const p of new Set(sp.routes)) {
        if (routeOwners.has(p) && routeOwners.get(p) !== sp.name) {
          expectCollision = true;
        }
        routeOwners.set(p, sp.name);
      }
    }
    let threw = false;
    try {
      await resolvePlugins(plugins, { appId: "audit", dev: true });
    } catch (e) {
      threw = true;
      const m = String((e as Error).message);
      if (!m.includes("collision")) {
        finding("6", `threw a non-collision error: ${m.slice(0, 120)}`);
      }
      // The message must name BOTH sides — that is its whole job.
      const named = specs.filter((sp) => m.includes(`"${sp.name}"`)).length;
      if (named < 2) {
        finding("6", `collision named ${named} plugin(s): ${m.slice(0, 160)}`);
      }
    }
    if (threw !== expectCollision) {
      finding(
        "6",
        `collision ${
          threw ? "raised" : "missed"
        }, expected ${expectCollision}: ` +
          JSON.stringify(specs),
      );
    }
  }
}

/** 7 — composed hooks: every one runs, whatever the others do. */
async function round7(r: () => number): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const n = int(r, 0, 5);
    const ran: number[] = [];
    const errs: unknown[] = [];
    const hooks = Array.from({ length: n }, (_, k) => () => {
      ran.push(k);
      if (r() < 0.3) throw new Error(`hook ${k}`);
    });
    const own = r() < 0.5 ? () => void ran.push(-1) : undefined;
    const composed = composeHooks(hooks, own, (e) => errs.push(e));
    if (n === 0 && !own) {
      if (composed !== undefined) {
        finding("7", "empty compose is not undefined");
      }
      continue;
    }
    composed!();
    const expect = [...hooks.map((_, k) => k), ...(own ? [-1] : [])];
    if (JSON.stringify(ran) !== JSON.stringify(expect)) {
      finding(
        "7",
        `ran ${JSON.stringify(ran)}, expected ${JSON.stringify(expect)}`,
      );
    }
  }
  // Async: order, awaiting, and reverse unwind.
  for (let i = 0; i < 400; i++) {
    const n = int(r, 1, 4);
    const ran: number[] = [];
    const hooks = Array.from({ length: n }, (_, k) => async () => {
      await new Promise((res) => setTimeout(res, r() < 0.3 ? 1 : 0));
      ran.push(k);
      if (r() < 0.25) throw new Error(`async ${k}`);
    });
    const stop = composeAsyncHooks(hooks, undefined, "stop", () => {})!;
    await stop();
    const expect = hooks.map((_, k) => k).reverse();
    if (JSON.stringify(ran) !== JSON.stringify(expect)) {
      finding(
        "7",
        `stop order ${JSON.stringify(ran)} != ${JSON.stringify(expect)}`,
      );
    }
  }
}

/** 8 — text merge under adversarial unicode and pathological shapes. */
function round8(r: () => number): void {
  const PIECES = [
    ...NASTY,
    "\uD83D", // a LONE high surrogate
    "\uDE00", // a lone low surrogate
    "é", // combining acute
    "́",
    "a‍b",
  ];
  const mk = () =>
    Array.from({ length: int(r, 0, 6) }, () => pick(r, PIECES)).join("");
  for (let i = 0; i < 4000; i++) {
    const base = mk();
    const local = r() < 0.3 ? base : mk();
    const remote = r() < 0.3 ? base : mk();
    let x, y;
    try {
      x = mergeText3(base, local, A, remote, B);
      y = mergeText3(base, remote, B, local, A);
    } catch (e) {
      finding(
        "8",
        `threw: ${e}\n base=${JSON.stringify(base)} l=${
          JSON.stringify(local)
        } r=${JSON.stringify(remote)}`,
      );
      continue;
    }
    if (x.value !== y.value) {
      finding(
        "8",
        `DIVERGED\n base=${JSON.stringify(base)}\n local=${
          JSON.stringify(local)
        }\n remote=${JSON.stringify(remote)}\n A=${
          JSON.stringify(x.value)
        }\n B=${JSON.stringify(y.value)}`,
      );
    }
    if (x.conflict !== y.conflict) {
      finding("8", `conflict flag differs for ${JSON.stringify(base)}`);
    }
    // One side unchanged ⇒ the other side, exactly.
    if (base === local && x.value !== remote) {
      finding("8", `unchanged-local did not yield remote`);
    }
    // tokenize must round-trip whatever it is given.
    for (const s of [base, local, remote]) {
      if (tokenize(s).join("") !== s) {
        finding("8", `tokenize lost data on ${JSON.stringify(s)}`);
      }
    }
    // hunksOf must produce ordered, non-overlapping, in-range hunks.
    const bt = tokenize(base), lt = tokenize(local);
    if (bt.length < 500 && lt.length < 500) {
      let at = -1;
      for (const h of hunksOf(bt, lt)) {
        if (h.from < at) finding("8", `hunks out of order`);
        if (h.from > h.to) finding("8", `inverted hunk ${h.from}>${h.to}`);
        if (h.to > bt.length) finding("8", `hunk past the end`);
        at = h.to;
      }
    }
  }
}

/** 9 — the merge dispatcher: shape refusals and delegation. */
function round9(r: () => number): void {
  const VALUES = [
    null,
    undefined,
    "",
    "text",
    42,
    0,
    true,
    false,
    {},
    { a: 1 },
    [],
    [1, 2],
  ];
  for (let i = 0; i < 3000; i++) {
    const local = pick(r, VALUES);
    const remote = pick(r, VALUES);
    const base = pick(r, VALUES);
    let out: unknown, threw: string | null = null;
    try {
      out = mergeField("text", local, A, remote, B, base).value;
    } catch (e) {
      threw = String((e as Error).message);
    }
    const strings = typeof local === "string" && typeof remote === "string";
    const nullish = local == null || remote == null;
    if (nullish) {
      if (threw) {
        finding("9", `a nullish side threw instead of delegating to lww`);
      }
    } else if (!strings) {
      if (!threw) {
        finding("9", `a non-string merged silently → ${JSON.stringify(out)}`);
      } else if (!threw.includes("string")) {
        finding("9", `refusal does not name the expected shape: ${threw}`);
      }
    } else if (typeof base === "string" || base == null) {
      if (threw) finding("9", `two strings threw: ${threw}`);
      if (typeof out !== "string") {
        finding("9", `two strings produced ${typeof out}`);
      }
    }
  }
}

/** 10 — the declaration is frozen, whatever a cell looks like. */
function round10(r: () => number): void {
  for (let i = 0; i < 400; i++) {
    const depth = int(r, 0, 4);
    const build = (d: number): unknown => {
      if (d === 0) return pick(r, [1, "s", true, null, [1, 2], { k: 1 }]);
      return r() < 0.5
        ? { a: build(d - 1), b: build(d - 1) }
        : [build(d - 1), build(d - 1)];
    };
    const state = { root: build(depth), n: 0 } as Record<string, unknown>;
    const c = cell(`audit-frozen-${i}-${int(r, 0, 1e9)}`, {
      state,
      methods: {
        bump(s: Record<string, unknown>) {
          s.n = (s.n as number) + 1;
        },
      },
    });
    const composed = composeCells([c]);
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== "object") return;
      if (!Object.isFrozen(v)) {
        finding("10", `unfrozen at ${path} (depth ${depth})`);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(composed.initialState, "$");
    // …and the author's own object is NOT frozen by composing.
    if (Object.isFrozen(state)) {
      finding("10", "composing froze the DECLARED object");
    }
  }
}

/** 11 — the generated theme is valid, direction-agnostic CSS for any name. */
function round11(r: () => number): void {
  const NAMES = [
    ...NASTY,
    "a",
    "my-app",
    "MyApp",
    "app.with.dots",
    "app_underscore",
    "0",
    "-",
    "a".repeat(200),
  ];
  const PHYSICAL =
    /(^|[{;\s])(margin|padding|border)-(left|right)\s*:|(^|[{;\s])(left|right)\s*:|text-align\s*:\s*(left|right)\b|float\s*:\s*(left|right)\b/;
  for (const name of NAMES) {
    for (const css of [appThemeCss(name), appThemeTokensCss(name)]) {
      // Balanced braces — an unbalanced sheet silently drops everything after.
      let depth = 0;
      for (const ch of css) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) {
        finding("11", `unbalanced braces for name ${JSON.stringify(name)}`);
      }
      // No NaN / undefined leaking into a value.
      if (/NaN|undefined|Infinity/.test(css)) {
        finding("11", `NaN/undefined in the sheet for ${JSON.stringify(name)}`);
      }
      // No unrounded float noise.
      if (/\d\.\d{4,}/.test(css)) {
        finding("11", `float noise for ${JSON.stringify(name)}`);
      }
      for (const line of css.split("\n")) {
        const code = line.replace(/\/\*.*?\*\//g, "");
        if (/\baio-ok\b\s*[:\-—]/.test(line)) continue;
        if (PHYSICAL.test(code)) {
          finding("11", `physical property: ${code.trim().slice(0, 90)}`);
        }
      }
    }
  }
  for (const line of UI_CSS.split("\n")) {
    const code = line.replace(/\/\*.*?\*\//g, "");
    if (/\baio-ok\b\s*[:\-—]/.test(line)) continue;
    if (PHYSICAL.test(code)) {
      finding("11", `UI_CSS physical property: ${code.trim().slice(0, 90)}`);
    }
  }
  void r;
}

/** 12 — `am`'s hint never turns a readable error into an unreadable one. */
function round12(r: () => number): void {
  for (let i = 0; i < 4000; i++) {
    const raw = r() < 0.5
      ? pick(r, NASTY)
      : Array.from({ length: int(r, 0, 3) }, () => pick(r, NASTY)).join("");
    let hint: string;
    try {
      hint = appMeantHint(raw);
    } catch (e) {
      finding("12", `appMeantHint threw on ${JSON.stringify(raw)}: ${e}`);
      continue;
    }
    if (typeof hint !== "string") finding("12", `hint is ${typeof hint}`);
    if (hint && !hint.includes("--app=")) {
      finding("12", `a hint that does not name the flag: ${hint}`);
    }
    const parsed = parseNumArg(raw, "--x");
    if (parsed.ok && !Number.isFinite(parsed.value)) {
      finding(
        "12",
        `parseNumArg returned a non-finite ok for ${JSON.stringify(raw)}`,
      );
    }
    if (!parsed.ok && typeof parsed.error !== "string") {
      finding("12", "parseNumArg error is not a string");
    }
  }
  // A number is always a number.
  for (let i = 0; i < 2000; i++) {
    const n = (r() - 0.5) * 1e9;
    const p = parseNumArg(String(n), "--x");
    if (!p.ok || p.value !== Number(String(n))) {
      finding("12", `parseNumArg rejected ${n}`);
    }
  }
}

/** 13 — compression is never a pessimisation, at any size. */
async function round13(r: () => number): Promise<void> {
  const encs = await availableEncodings();
  for (let i = 0; i < 300; i++) {
    const size = int(r, 0, 20000);
    const kind = r();
    const body = kind < 0.4
      ? "a".repeat(size)
      : kind < 0.7
      ? Array.from({ length: size }, () => pick(r, [..."abcdefg"])).join("")
      : Array.from(
        { length: size },
        () => String.fromCharCode(int(r, 32, 126)),
      ).join("");
    const bytes = enc.encode(body) as Uint8Array<ArrayBuffer>;
    _clearEncodedCache();
    const req = new Request("http://x/p", {
      headers: { "Accept-Encoding": "br, gzip, deflate" },
    });
    const out = await encodeResponse(
      req,
      new Response(body, { headers: { "Content-Type": "text/plain" } }),
    );
    const sent = Number(out.headers.get("Content-Length"));
    if (Number.isFinite(sent) && sent > bytes.byteLength) {
      finding(
        "13",
        `sent ${sent} for a ${bytes.byteLength}-byte body (${
          out.headers.get("Content-Encoding")
        })`,
      );
    }
    if (bytes.byteLength > 0 && sent === 0) {
      finding("13", `a ${bytes.byteLength}-byte body sent as 0 bytes`);
    }
  }
  // Every codec round-trips at every size boundary.
  for (const e of encs) {
    for (const n of [0, 1, 2, 859, 860, 861, 4095, 4096, 65536]) {
      const body = "x".repeat(n);
      const bytes = enc.encode(body) as Uint8Array<ArrayBuffer>;
      const out = await compress(e, bytes);
      if (out.byteLength === 0 && n > 0) {
        finding("13", `${e} produced 0 bytes for ${n}`);
      }
    }
  }
  // isCompressible must be total and stable.
  for (const ct of [...NASTY, "text/html", "image/png", null]) {
    const a = isCompressible(ct as string | null);
    const b = isCompressible(ct as string | null);
    if (a !== b) finding("13", `isCompressible is not deterministic for ${ct}`);
  }
}

/** 14 — boot's working copy is mutable at every depth, from every shape. */
function round14(r: () => number): void {
  for (let i = 0; i < 300; i++) {
    const depth = int(r, 1, 4);
    const build = (d: number): unknown =>
      d === 0
        ? pick(r, [1, "s", true, [1], { k: 1 }])
        : r() < 0.5
        ? { a: build(d - 1), b: build(d - 1) }
        : [build(d - 1)];
    const decl = { root: build(depth), n: 0 } as Record<string, unknown>;
    const c = cell(`audit-boot-${i}-${int(r, 0, 1e9)}`, {
      state: decl,
      methods: {},
    });
    const frozen = composeCells([c]).initialState;
    // What boot does: a deep mutable copy of the frozen declaration.
    const working = cloneState(frozen) as Record<string, unknown>;
    const writable = (v: unknown, path: string): void => {
      if (v === null || typeof v !== "object") return;
      if (Object.isFrozen(v)) {
        finding("14", `boot copy still frozen at ${path}`);
        return;
      }
      try {
        if (Array.isArray(v)) v.push(undefined as never), v.pop();
        else {
          (v as Record<string, unknown>).__probe = 1;
          delete (v as Record<string, unknown>).__probe;
        }
      } catch (e) {
        finding("14", `boot copy refused a write at ${path}: ${e}`);
        return;
      }
      for (const [k, x] of Object.entries(v)) writable(x, `${path}.${k}`);
    };
    writable(working, "$");
    // …and the copy must not alias the frozen original.
    const alias = (a: unknown, b: unknown): boolean => {
      if (a === null || typeof a !== "object") return false;
      if (a === b) return true;
      if (b === null || typeof b !== "object") return false;
      for (const k of Object.keys(a as Record<string, unknown>)) {
        if (
          alias(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
          )
        ) return true;
      }
      return false;
    };
    if (alias(working, frozen)) {
      finding("14", `the boot copy ALIASES the frozen declaration`);
    }
  }
}

/** 15 — the exit watchdog under racing signals and misbehaving runtimes. */
async function round15(r: () => number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const n = int(r, 0, 3);
    const unregs: Array<() => void> = [];
    let stopped = 0;
    for (let k = 0; k < n; k++) {
      const kind = r();
      unregs.push(registerRuntime(() => {
        stopped++;
        if (kind < 0.25) return new Promise<void>(() => {}); // never settles
        if (kind < 0.4) return Promise.reject(new Error("stop failed"));
        if (kind < 0.7) {
          return new Promise<void>((res) => setTimeout(res, int(r, 0, 20)));
        }
        return Promise.resolve();
      }));
    }
    let exits = 0;
    let code: number | null = null;
    const restoreExit = _setExitFn((c: number) => {
      exits++;
      if (code === null) code = c;
      return undefined as never;
    });
    const restoreWd = _setWatchdogMs(30);
    try {
      const signals = int(r, 1, 4);
      for (let k = 0; k < signals; k++) stopProcess(0);
      await new Promise((res) => setTimeout(res, 220));
      if (exits !== 1) finding("15", `${signals} signal(s) → ${exits} exit(s)`);
      if (stopped > n) {
        finding("15", `${n} runtime(s) stopped ${stopped} times`);
      }
      if (code === null) finding("15", `never exited (n=${n})`);
      else if (code !== 0 && code !== 75 && code !== 1) {
        finding("15", `unexpected exit code ${code}`);
      }
    } finally {
      restoreWd();
      restoreExit();
      _resetStopProcess();
      for (const u of unregs) u();
    }
  }
}

/** 16 — every control renders valid ARIA from arbitrary props. */
function round16(r: () => number): void {
  const { Window } = winMod;
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const g = globalThis as { CSS?: { escape(s: string): string } };
  if (!g.CSS) g.CSS = { escape: (x: string) => x.replace(/[^\w-]/g, "\\$&") };
  _setDocument(doc);
  const label = () => pick(r, [...NASTY, undefined as unknown as string]);
  const MAKERS: Array<() => unknown> = [
    () =>
      h(Switch, { label: label(), checked: r() < 0.5, disabled: r() < 0.3 }),
    () =>
      h(RadioGroup, {
        label: label(),
        value: label(),
        options: Array.from({ length: int(r, 0, 4) }, (_, k) => ({
          value: `v${k}`,
          label: label() ?? "x",
          disabled: r() < 0.3,
        })),
      }),
    () =>
      h(Tabs, {
        label: label(),
        tabs: Array.from({ length: int(r, 0, 4) }, (_, k) => ({
          id: `t${k}`,
          label: label() ?? "x",
          disabled: r() < 0.4,
          children: label(),
        })),
      }),
    () =>
      h(Menu, {
        trigger: label() ?? "m",
        label: label(),
        items: Array.from({ length: int(r, 0, 4) }, (_, k) => ({
          id: `i${k}`,
          label: label() ?? "x",
          disabled: r() < 0.3,
          danger: r() < 0.2,
        })),
      }),
    () =>
      h(Progress, {
        value: pick(r, [undefined, 0, 50, 100, -5, 1e9, NaN]) as number,
        max: pick(r, [undefined, 100, 0, 1]) as number,
        label: label(),
        showValue: r() < 0.5,
      }),
    () =>
      h(Alert, {
        variant: pick(r, ["info", "success", "warn", "error"]) as never,
        title: label(),
      }, label()),
    () =>
      h(Tooltip, {
        text: label() ?? "t",
        placement: pick(r, ["top", "bottom"]) as never,
      }, label()),
    () =>
      h(Breadcrumb, {
        items: Array.from({ length: int(r, 0, 4) }, () => ({
          label: label() ?? "x",
          href: r() < 0.5 ? "/x" : undefined,
        })),
      }),
    () => h(Skeleton, { lines: int(r, 0, 5), circle: r() < 0.3 }),
    () =>
      h(EmptyState, {
        title: label() ?? "t",
        description: label(),
        icon: label(),
      }),
  ];
  for (let i = 0; i < 500; i++) {
    _resetControlIds();
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const make = pick(r, MAKERS);
    try {
      mount(root as unknown as HTMLElement, () => make() as never);
    } catch (e) {
      finding("16", `render threw: ${e}`);
      continue;
    }
    // Every id referenced by aria-controls / aria-labelledby / describedby
    // must exist, or the association it makes is a lie.
    for (
      const attr of ["aria-controls", "aria-labelledby", "aria-describedby"]
    ) {
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        for (const id of (el.getAttribute(attr) ?? "").split(/\s+/)) {
          if (!id) continue;
          if (!root.querySelector(`[id="${id}"]`)) {
            finding("16", `${attr}="${id}" points at nothing`);
          }
        }
      }
    }
    // Ids must be unique within the tree.
    const ids = [...root.querySelectorAll("[id]")].map((e) =>
      e.getAttribute("id")
    );
    if (new Set(ids).size !== ids.length) {
      finding("16", `duplicate id in one tree`);
    }
    // Every button aio writes carries a type (its own dev check would warn).
    for (const b of root.querySelectorAll("button")) {
      if (!b.getAttribute("type")) finding("16", `a kit <button> with no type`);
    }
    // aria-selected / aria-expanded must be the string "true"/"false".
    for (const attr of ["aria-selected", "aria-expanded", "aria-hidden"]) {
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        const v = el.getAttribute(attr);
        if (v !== "true" && v !== "false") {
          finding("16", `${attr}=${JSON.stringify(v)} is not a boolean string`);
        }
      }
    }
    root.remove();
  }
  win.happyDOM.close();
}

/** 17 — the kit never trips the framework's OWN dev a11y warnings. */
function round17(r: () => number): void {
  const { Window } = winMod;
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  setDevMode(true);
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(String(a[0]));
  try {
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    _resetControlIds();
    mount(root as unknown as HTMLElement, () =>
      h(
        "div",
        null,
        h(Switch, { label: "Notifications", checked: true }),
        h(RadioGroup, {
          label: "Env",
          value: "a",
          options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
        }),
        h(Tabs, {
          label: "S",
          tabs: [{ id: "x", label: "X", children: "body" }],
        }),
        h(Menu, { trigger: "Actions", items: [{ id: "a", label: "A" }] }),
        h(Progress, { value: 40, label: "Uploading", showValue: true }),
        h(Alert, { variant: "error", title: "T" }, "b"),
        h(Tooltip, { text: "tip" }, h("span", null, "?")),
        h(Breadcrumb, { items: [{ label: "H", href: "/" }, { label: "N" }] }),
        h(Skeleton, { lines: 2 }),
        h(EmptyState, { title: "None", icon: "x" }),
      ) as never);
    for (const w of warnings) {
      if (w.includes("[aio-dev]")) {
        finding("17", `the kit's own output warns: ${w.slice(0, 140)}`);
      }
    }
  } finally {
    console.warn = orig;
    setDevMode(false);
    win.happyDOM.close();
  }
  void r;
}

/** 18 — the new config keys are accepted, and only in their own shapes. */
function round18(r: () => number): void {
  for (const k of ["security", "plugins", "_pluginNames"]) {
    if (!VALID_AIO_CONFIG_KEYS.has(k) && !VALID_FEATURES_CONFIG_KEYS.has(k)) {
      finding("18", `${k} is not in either config allowlist`);
    }
  }
  if (!VALID_UI_KEYS.has("dir")) finding("18", "ui.dir is not allowlisted");
  // A typo near a real key must still be refused.
  for (
    const typo of [
      "securty",
      "plugin",
      "Security",
      "plugins ",
      "ui.dir",
      "dirr",
    ]
  ) {
    if (
      VALID_AIO_CONFIG_KEYS.has(typo) || VALID_FEATURES_CONFIG_KEYS.has(typo)
    ) {
      finding("18", `"${typo}" is allowlisted and should not be`);
    }
  }
  // Every allowlisted key must be documented (the printed table is the docs).
  for (const k of VALID_FEATURES_CONFIG_KEYS) {
    if (k.startsWith("_")) continue;
    if (!(k in CONFIG_DOCS) && !VALID_UI_KEYS.has(k)) {
      finding("18", `${k} is settable and undocumented`);
    }
  }
  void r;
}

/** 19 — the encoded-body memo is bounded however much churn it sees. */
async function round19(r: () => number): Promise<void> {
  _clearEncodedCache();
  const before = (Deno.memoryUsage?.().heapUsed ?? 0) / 1e6;
  for (let i = 0; i < 400; i++) {
    // Every body distinct, so every one is a cache MISS.
    const body = `${i}-`.repeat(int(r, 500, 2000));
    await encodeResponse(
      new Request("http://x/p", { headers: { "Accept-Encoding": "br" } }),
      new Response(body, { headers: { "Content-Type": "text/plain" } }),
    );
  }
  const after = (Deno.memoryUsage?.().heapUsed ?? 0) / 1e6;
  // The cache is bounded at 32 MB of BODIES; the heap may move for other
  // reasons, so the bar is deliberately loose — it catches "unbounded", not
  // "grew".
  if (after - before > 200) {
    finding(
      "19",
      `heap grew ${(after - before).toFixed(0)} MB over 400 misses`,
    );
  }
  _clearEncodedCache();
}

/** 20 — the text strategy through the REAL dispatcher, in both directions. */
function round20(r: () => number): void {
  const WORDS = ["alpha", "beta", "gamma", "delta", "", "\n", "x"];
  const mk = () =>
    Array.from({ length: int(r, 0, 8) }, () => pick(r, WORDS)).join(
      pick(r, ["\n", " ", ""]),
    );
  for (let i = 0; i < 3000; i++) {
    const base = mk(), local = mk(), remote = mk();
    const one = mergeField("text", local, A, remote, B, base);
    const two = mergeField("text", remote, B, local, A, base);
    if (one.value !== two.value) {
      finding(
        "20",
        `dispatcher diverged: ${JSON.stringify({ base, local, remote })}`,
      );
    }
    if (typeof one.value !== "string") {
      finding("20", `dispatcher produced ${typeof one.value}`);
    }
    // A merge must never be longer than both sides plus the base — an
    // unbounded result is a duplication bug.
    if (
      (one.value as string).length > base.length + local.length + remote.length
    ) {
      finding("20", `merge grew beyond base+local+remote`);
    }
  }
}

/** 21 — `isCompressible` / `isStreamingType` are total and disjoint. */
async function round21(r: () => number): Promise<void> {
  const streaming: string[] = [];
  const PARTS = [
    "text",
    "application",
    "image",
    "font",
    "video",
    "multipart",
    "",
    "TEXT",
    "x",
  ];
  const SUBS = [
    "html",
    "plain",
    "json",
    "javascript",
    "event-stream",
    "x-ndjson",
    "svg+xml",
    "png",
    "woff2",
    "wasm",
    "",
    "*",
    ...NASTY.slice(0, 6),
  ];
  for (let i = 0; i < 20000; i++) {
    const ct = `${pick(r, PARTS)}/${pick(r, SUBS)}${
      r() < 0.3 ? "; charset=utf-8" : ""
    }`;
    let a: boolean, b: boolean;
    try {
      a = isCompressible(ct);
      b = isStreamingType(ct);
    } catch (e) {
      finding("21", `threw on ${JSON.stringify(ct)}: ${e}`);
      continue;
    }
    if (typeof a !== "boolean" || typeof b !== "boolean") {
      finding("21", `non-boolean for ${JSON.stringify(ct)}`);
    }
    // Case must not matter.
    if (isCompressible(ct.toUpperCase()) !== a) {
      finding("21", `case-sensitive for ${JSON.stringify(ct)}`);
    }
    // The two predicates OVERLAP by design (`text/event-stream` is `text/`),
    // and that is harmless only because `encodeResponse` asks the streaming
    // question FIRST. The invariant worth checking is that ordering, not
    // disjointness — so check the ordering, on a body that never ends.
    if (b) streaming.push(ct);
  }
  // Every streaming type this round could name must pass through untouched.
  // If one is ever buffered instead, this hangs rather than reporting — which
  // is the correct failure for "waits for an end that is not coming".
  const legal = [...new Set(streaming)].filter((ct) => {
    try {
      new Headers({ "Content-Type": ct });
      return true;
    } catch {
      return false; // not a header value at all — the runtime refuses first
    }
  });
  for (const ct of legal.slice(0, 60)) {
    const resp = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("data: x\n\n"));
        },
      }),
      { headers: { "Content-Type": ct } },
    );
    const out = await encodeResponse(
      new Request("http://x/p", { headers: { "Accept-Encoding": "br" } }),
      resp,
    );
    if (out !== resp) {
      finding("21", `${JSON.stringify(ct)} was not passed through`);
    }
    await out.body?.cancel();
  }
}

/** 22 — every documented merge strategy name resolves and is total. */
function round22(r: () => number): void {
  const STRATEGIES = [
    "lww",
    "counter",
    "lww-per-key",
    "set-add",
    "set-remove",
    "text",
  ] as const;
  const VALUES: unknown[] = [
    null,
    undefined,
    "",
    "a\nb",
    0,
    7,
    [{ id: "1" }, { id: "2" }],
    [],
    { a: 1 },
    {},
    true,
  ];
  for (let i = 0; i < 6000; i++) {
    const st = pick(r, STRATEGIES);
    const local = pick(r, VALUES);
    const remote = pick(r, VALUES);
    const base = pick(r, VALUES);
    let out: { value: unknown; conflict: boolean } | null = null;
    let err: string | null = null;
    try {
      out = mergeField(st, local, A, remote, B, base);
    } catch (e) {
      err = String((e as Error).message);
    }
    if (err) {
      // A refusal must NAME the strategy and what it wanted — a bare
      // "cannot read property" would send the reader to the wrong file.
      if (!err.includes(st)) {
        finding(
          "22",
          `${st} refusal does not name the strategy: ${err.slice(0, 100)}`,
        );
      }
      continue;
    }
    if (!out || typeof out.conflict !== "boolean") {
      finding("22", `${st} returned a malformed result`);
      continue;
    }
    // Never `undefined` where both sides were defined — that is data loss.
    if (
      out.value === undefined && local !== undefined && remote !== undefined
    ) {
      finding(
        "22",
        `${st} produced undefined from ${JSON.stringify({ local, remote })}`,
      );
    }
  }
}

/** 23 — the response finisher over a REAL server, every route shape. */
async function round23(r: () => number): Promise<void> {
  const marker = cell(`audit-live-${int(r, 0, 1e9)}`, {
    state: { n: 0 },
    methods: {},
  });
  const srv = await testServer({
    cells: [marker],
    routes: {
      "/a/json": () => Response.json({ ok: true, pad: "x".repeat(3000) }),
      "/a/text": () => new Response("t".repeat(4000)),
      "/a/empty": () => new Response(null, { status: 204 }),
      "/a/redirect": () =>
        new Response(null, { status: 302, headers: { Location: "/" } }),
      "/a/err": () => new Response("boom", { status: 500 }),
      "/a/png": () =>
        new Response(new Uint8Array(4000), {
          headers: { "Content-Type": "image/png" },
        }),
      "/a/sse": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: hi\n\n"));
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      "/a/notransform": () =>
        new Response("n".repeat(4000), {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-transform",
          },
        }),
    },
  });
  try {
    const PATHS = [
      "/",
      "/a/json",
      "/a/text",
      "/a/empty",
      "/a/redirect",
      "/a/err",
      "/a/png",
      "/a/sse",
      "/a/notransform",
      "/__aio/health",
      "/does-not-exist",
    ];
    for (let i = 0; i < 220; i++) {
      const path = pick(r, PATHS);
      const ae = pick(r, ["br, gzip", "gzip", "identity", "", "*"]);
      const method = pick(r, ["GET", "GET", "GET", "HEAD"]);
      let res: Response;
      try {
        res = await fetch(`${srv.url}${path}`, {
          method,
          redirect: "manual",
          headers: ae ? { "Accept-Encoding": ae } : {},
        });
      } catch (e) {
        finding("23", `${method} ${path} (ae=${ae}) failed: ${e}`);
        continue;
      }
      const body = await res.arrayBuffer();
      if (res.status >= 500 && path !== "/a/err") {
        finding("23", `${method} ${path} → ${res.status}`);
        continue;
      }
      // Security headers on every response the app serves.
      if (res.status === 200 && !res.headers.get("x-content-type-options")) {
        finding("23", `${path} has no nosniff`);
      }
      // A declared Content-Length must match the bytes actually delivered
      // (fetch decodes, so this only holds for identity).
      const cl = res.headers.get("content-length");
      if (
        method === "GET" && cl !== null &&
        !res.headers.get("content-encoding") &&
        Number(cl) !== body.byteLength && res.status === 200
      ) {
        finding(
          "23",
          `${path}: content-length ${cl} but ${body.byteLength} bytes`,
        );
      }
      // A no-transform route must never come back encoded.
      if (path === "/a/notransform" && res.headers.get("content-encoding")) {
        finding("23", `no-transform was re-encoded`);
      }
    }
    // Revalidation over the wire.
    const first = await fetch(`${srv.url}/a/json`);
    await first.arrayBuffer();
    const etag = first.headers.get("etag");
    if (etag) {
      const again = await fetch(`${srv.url}/a/json`, {
        headers: { "If-None-Match": etag },
      });
      await again.arrayBuffer();
      if (again.status !== 304) {
        finding("23", `revalidation returned ${again.status}, not 304`);
      }
    }
  } finally {
    await srv.close();
  }
}

/** 24 — every refusal alpha72 added names the CAUSE and the FIX. */
async function round24(_r: () => number): Promise<void> {
  const cases: Array<{ what: string; run: () => unknown | Promise<unknown> }> =
    [
      {
        what: "definePlugin with no name",
        run: () => definePlugin({ name: "" } as never),
      },
      {
        what: "two plugins claiming one route",
        run: () =>
          resolvePlugins([
            definePlugin({
              name: "aa",
              routes: { "/h": () => new Response("") },
            }),
            definePlugin({
              name: "bb",
              routes: { "/h": () => new Response("") },
            }),
          ], { appId: "x", dev: true }),
      },
      {
        what: "the same plugin twice",
        run: () => {
          const p = definePlugin({ name: "twice" });
          return resolvePlugins([p, p], { appId: "x", dev: true });
        },
      },
      {
        what: "a plugin whose setup throws",
        run: () =>
          resolvePlugins([
            definePlugin({
              name: "needs-env",
              setup() {
                throw new Error("STRIPE_KEY is not set");
              },
            }),
          ], { appId: "x", dev: true }),
      },
      {
        what: "a header value that cannot be sent",
        run: () => securityHeaders({ permissionsPolicy: "camera=(ü)" }, {}),
      },
      {
        what: "a `text` merge of a non-string",
        run: () => mergeField("text", 42, A, "ok", B, ""),
      },
    ];
  for (const { what, run } of cases) {
    let msg: string | null = null;
    try {
      await run();
    } catch (e) {
      msg = String((e as Error).message ?? e);
    }
    if (msg === null) {
      finding("24", `"${what}" did not refuse at all`);
      continue;
    }
    if (msg.length < 40) {
      finding("24", `"${what}" refused in ${msg.length} chars: ${msg}`);
    }
    // A refusal has to be actionable: it must say what to DO, not only what
    // went wrong. These are the words this project's own messages use.
    const actionable =
      /\b(fix|use|add|pass|write|drop|set|check|call|run|instead|must|need|rename|remove)\b/i
        .test(msg);
    if (!actionable) {
      finding("24", `"${what}" names no action: ${msg.slice(0, 140)}`);
    }
    if (/^\s*(undefined|null|\[object)/i.test(msg)) {
      finding("24", `"${what}" leaked a raw value: ${msg.slice(0, 80)}`);
    }
  }
  // The frozen-write message is the exception that PROVES the rule: it is the
  // ENGINE's sentence, so the framework has to recognise it and add its own.
  // Every path that hits it — an effect, a hook, a route handler — is caught
  // by the framework and LOGGED, so the logger is where the explanation goes.
  for (
    const raw of [
      "Cannot assign to read only property 'n' of object '#<Object>'",
      "Cannot add property 1, object is not extensible",
      "Cannot delete property 'x' of #<Object>",
    ]
  ) {
    if (!isFrozenWriteError(raw)) {
      finding("24", `no longer recognised as a frozen write: ${raw}`);
    }
    const taught = frozenWriteMessage(raw, "notes");
    if (!taught.includes("notes") || !/method/i.test(taught)) {
      finding("24", `the explanation lost the cell or the fix: ${taught}`);
    }
    _resetFrozenWriteHint();
    const said: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) =>
      void said.push(a.map(String).join(" "));
    try {
      logApi.error(`something threw — TypeError: ${raw}`);
    } finally {
      console.error = orig;
    }
    if (!said.join("\n").includes("frozen")) {
      finding("24", `logging "${raw}" produced no explanation`);
    }
  }
}

/** 25 — every new public symbol is exported deliberately and documented. */
async function round25(_r: () => number): Promise<void> {
  const snapshot = JSON.parse(
    await Deno.readTextFile(
      new URL("../docs/api-snapshot.json", import.meta.url),
    ),
  ) as { entries: Record<string, { symbols: Record<string, unknown> }> };
  const NEW = [
    ["definePlugin", "."],
    ["Plugin", "."],
    ["PluginContribution", "."],
    ["PluginSetupContext", "."],
    ["Alert", "./ui"],
    ["Breadcrumb", "./ui"],
    ["EmptyState", "./ui"],
    ["Menu", "./ui"],
    ["Progress", "./ui"],
    ["RadioGroup", "./ui"],
    ["Skeleton", "./ui"],
    ["Switch", "./ui"],
    ["Tabs", "./ui"],
    ["Tooltip", "./ui"],
  ] as const;
  for (const [sym, entry] of NEW) {
    if (!snapshot.entries[entry]?.symbols[sym]) {
      finding("25", `${sym} is not on the ${entry} surface`);
    }
  }
  // Nothing internal leaked: a `_`-prefixed seam must never be public.
  for (const [entry, { symbols }] of Object.entries(snapshot.entries)) {
    for (const sym of Object.keys(symbols)) {
      if (/^_[a-z]/.test(sym) && !sym.startsWith("__")) {
        finding("25", `${entry} exports the internal seam ${sym}`);
      }
    }
  }
}

/** 26 — every new pure function is deterministic, and free of hidden state. */
function round26(r: () => number): void {
  const same = <T>(label: string, f: () => T) => {
    const a = JSON.stringify(f());
    for (let i = 0; i < 20; i++) {
      if (JSON.stringify(f()) !== a) {
        finding("26", `${label} is not deterministic`);
        return;
      }
    }
  };
  for (let i = 0; i < 200; i++) {
    const origins = Array.from(
      { length: int(r, 0, 3) },
      () => pick(r, ["a.com", "https://b.com", "*", "", "x y"]),
    );
    same(
      "securityHeaders",
      () => securityHeaders(undefined, { allowedOrigins: origins }),
    );
    same("frameAncestors", () => frameAncestors(origins));
    const name = pick(r, ["app", "notes", "x", "MyApp"]);
    same("appThemeCss", () => appThemeCss(name).length);
    same("appThemeTokensCss", () => appThemeTokensCss(name).length);
    const base = pick(r, NASTY), l = pick(r, NASTY), rm = pick(r, NASTY);
    same("mergeText3", () => mergeText3(base, l, A, rm, B));
    same("tokenize", () => tokenize(base));
    const bytes = enc.encode(base) as Uint8Array<ArrayBuffer>;
    same("etagOf", () => etagOf(bytes));
    same("isCompressible", () => isCompressible(base));
    same("cspHostSource", () => cspHostSource(base));
  }
  // Argument objects must not be mutated — a pure function that edits its
  // input is the hardest bug class to see.
  for (let i = 0; i < 500; i++) {
    const origins = ["a.com", "https://b.com", " x "];
    const before = JSON.stringify(origins);
    securityHeaders(undefined, { allowedOrigins: origins });
    frameAncestors(origins);
    if (JSON.stringify(origins) !== before) {
      finding("26", "securityHeaders/frameAncestors mutated allowedOrigins");
    }
    const cfg = { csp: "strict" as const, headers: true };
    const cfgBefore = JSON.stringify(cfg);
    securityHeaders(cfg, {});
    if (JSON.stringify(cfg) !== cfgBefore) {
      finding("26", "securityHeaders mutated its config");
    }
  }
}

/** 27 — the finisher under concurrency: shared cache, no cross-talk. */
async function round27(r: () => number): Promise<void> {
  _clearEncodedCache();
  for (let batch = 0; batch < 40; batch++) {
    const bodies = Array.from(
      { length: int(r, 2, 12) },
      (_, k) => `${batch}:${k}:` + "x".repeat(int(r, 900, 4000)),
    );
    const results = await Promise.all(bodies.map((body) =>
      encodeResponse(
        new Request("http://x/p", {
          headers: {
            "Accept-Encoding": pick(r, ["br", "gzip", "deflate", ""]),
          },
        }),
        new Response(body, { headers: { "Content-Type": "text/plain" } }),
      ).then(async (out) => {
        const ce = out.headers.get("Content-Encoding");
        const back = ce === null
          ? await out.text()
          : ce === "br"
          ? new TextDecoder().decode(
            (await import("node:zlib")).brotliDecompressSync(
              new Uint8Array(await out.arrayBuffer()),
            ),
          )
          : await new Response(
            out.body!.pipeThrough(
              new DecompressionStream(ce as "gzip" | "deflate"),
            ),
          ).text();
        return back;
      })
    ));
    for (let k = 0; k < bodies.length; k++) {
      if (results[k] !== bodies[k]) {
        // The failure this catches: a shared cache keyed loosely enough that
        // one response hands back another response's bytes.
        finding(
          "27",
          `concurrent response ${batch}:${k} came back as someone else's body`,
        );
      }
    }
  }
  // The same body concurrently, so every request races the SAME cache key.
  const body = "same-".repeat(400);
  const outs = await Promise.all(
    Array.from({ length: 40 }, () =>
      encodeResponse(
        new Request("http://x/p", { headers: { "Accept-Encoding": "gzip" } }),
        new Response(body, { headers: { "Content-Type": "text/plain" } }),
      )),
  );
  const lens = new Set<number>();
  for (const o of outs) {
    lens.add((await o.arrayBuffer()).byteLength);
  }
  if (lens.size !== 1) {
    finding(
      "27",
      `40 identical bodies produced ${lens.size} different lengths`,
    );
  }
}

/** 28 — the client's projection is the same whether it was SENT or PATCHED.
 *
 *  A cell with `visible: { exclude }` has TWO deciders that must agree: the
 *  full-state path (`applyCellFieldFilter`) and the delta path
 *  (`filterPatchesByStrategy`). A client gets the first once, then the second
 *  forever — so a disagreement is a screen that drifts away from the server
 *  and never comes back, which is the corruption class this project's own
 *  doctrine calls "one fact decided in two places".
 *
 *  Two properties, on random state, random filters and random mutations:
 *    AGREEMENT — patching the projected previous state yields exactly the
 *                projection of the next state.
 *    NO LEAK   — a value at an excluded path never appears in the ops.
 */
function round28(r: () => number): void {
  const SECRET = "s3cr3t-marker";
  const deepEq = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);

  /** A cell slice: a few scalars, an array of rows, a nested object. Every
   *  shape carries a `secret` somewhere, so an exclude has something to hide. */
  const mkState = () => ({
    title: "t" + int(r, 0, 99),
    count: int(r, 0, 99),
    secret: SECRET,
    profile: {
      name: "n" + int(r, 0, 99),
      email: SECRET,
      nested: { deep: int(r, 0, 9) },
    },
    rows: Array.from({ length: int(r, 0, 4) }, (_, i) => ({
      id: i,
      text: "r" + int(r, 0, 99),
      token: SECRET,
    })),
  });

  const PATHS = [
    "secret",
    "profile.email",
    "rows.token",
    "profile",
    "rows",
    "title",
    "count",
    "profile.nested",
  ];

  for (let i = 0; i < 600; i++) {
    const prev = mkState();
    const mode = r() < 0.5 ? "exclude" : "include";
    const keys = Array.from({ length: int(r, 1, 3) }, () => pick(r, PATHS));
    const filter = mode === "exclude"
      ? { exclude: [...new Set(keys)] }
      : { include: [...new Set(keys)] };

    // The strategy map, built exactly as `buildUIStateGetter` builds it.
    const plain = keys.filter((k) => !k.includes("."));
    const deep = keys.filter((k) => k.includes(".")).map((k) => k.split("."));
    const strategies = new Map([["c", "filter" as const]]);
    const fields = new Map([[
      "c",
      mode === "exclude"
        ? {
          mode: "exclude" as const,
          fields: new Set(plain),
          ...(deep.length ? { deepExcludes: deep } : {}),
        }
        : {
          mode: "include" as const,
          fields: new Set(plain),
          ...(deep.length ? { deepIncludes: deep } : {}),
        },
    ]]);

    // A random mutation, described by Immer exactly as a dispatch would.
    const [next, ops] = produceWithPatches(prev, (d: typeof prev) => {
      switch (int(r, 0, 6)) {
        case 0:
          d.count = int(r, 100, 999);
          break;
        case 1:
          d.profile.name = "N" + int(r, 0, 99);
          break;
        case 2:
          d.profile.email = SECRET + int(r, 0, 9);
          break;
        case 3:
          d.rows.push({ id: 99, text: "new", token: SECRET });
          break;
        case 4:
          if (d.rows.length) d.rows[0]!.text = "changed";
          break;
        case 5:
          if (d.rows.length) d.rows.splice(0, 1);
          break;
        default:
          d.title = "T" + int(r, 0, 99);
      }
    });
    if (ops.length === 0) continue;

    const viewPrev = applyCellFieldFilter(filter, prev as never);
    const viewNext = applyCellFieldFilter(filter, next as never);
    const filtered = filterPatchesByStrategy(
      [{ cell: "c", ops: ops as WirePatch[] }],
      strategies,
      fields,
    );
    // `undefined` is the deliberate full-state fallback — the safe answer,
    // and not this property's business.
    if (filtered === undefined) continue;
    const kept = filtered[0]?.ops ?? [];

    if (mode === "exclude") {
      // NO LEAK. An excluded path's value must not travel in a delta — the
      // full-state path already refuses it, and a delta is the same secret
      // on the same socket.
      const excludedSecret = keys.some((k) =>
        k === "secret" || k === "profile.email" || k === "rows.token" ||
        k === "profile" || k === "rows"
      );
      if (excludedSecret && JSON.stringify(kept).includes(SECRET)) {
        const stillVisible = JSON.stringify(viewNext).includes(SECRET);
        if (!stillVisible) {
          finding(
            "28",
            `case ${i}: a delta carried ${SECRET} that the full-state ` +
              `projection hides — filter ${JSON.stringify(filter)}`,
          );
        }
      }
    }

    let applied: unknown;
    try {
      applied = applyWirePatches(viewPrev, kept);
    } catch (e) {
      finding(
        "28",
        `case ${i}: a filtered delta could not apply to the filtered state ` +
          `(${(e as Error).message.slice(0, 120)}) — filter ${
            JSON.stringify(filter)
          }, ops ${JSON.stringify(kept).slice(0, 200)}`,
      );
      continue;
    }
    if (!deepEq(applied, viewNext)) {
      finding(
        "28",
        `case ${i}: patched projection ≠ sent projection\n    filter=${
          JSON.stringify(filter)
        }\n    ops=${JSON.stringify(kept).slice(0, 200)}\n    patched=${
          JSON.stringify(applied).slice(0, 200)
        }\n    sent=   ${JSON.stringify(viewNext).slice(0, 200)}`,
      );
    }
  }
}

/** 29 — `append` compaction says exactly what `replace` said.
 *
 *  `narrowStringPatches` rewrites a whole-string `replace` as the suffix that
 *  grew, and every peer applies it through `applyWirePatches`. The two are a
 *  generator and an applier of the same wire op, in different folders, and
 *  the failure mode is a string that is silently WRONG on the client — a
 *  plausible value nobody can tell is wrong.
 *
 *  PROPERTY: for any previous state and any Immer patch list,
 *  `apply(prev, narrow(prev, ops))` === `apply(prev, ops)`, exactly.
 */
function round29(r: () => number): void {
  const chunk = (n: number) =>
    "abcdefghij".repeat(Math.ceil(n / 10)).slice(0, n);
  for (let i = 0; i < 800; i++) {
    // Strings straddling APPEND_MIN_LENGTH from both sides, so the compaction
    // boundary is exercised rather than assumed.
    const baseLen = int(r, 0, 600);
    const prev = {
      reply: chunk(baseLen),
      other: chunk(int(r, 0, 400)),
      rows: Array.from({ length: int(r, 0, 3) }, () => ({
        text: chunk(int(r, 0, 500)),
      })),
      n: int(r, 0, 9),
    };
    const [next, ops] = produceWithPatches(prev, (d: typeof prev) => {
      const moves = int(r, 1, 3);
      for (let m = 0; m < moves; m++) {
        switch (int(r, 0, 5)) {
          case 0: // the growth `append` exists for
            d.reply = d.reply + chunk(int(r, 1, 400));
            break;
          case 1: // a REWRITE, which must stay a replace
            d.reply = chunk(int(r, 0, 700));
            break;
          case 2:
            if (d.rows.length) d.rows[0]!.text += chunk(int(r, 1, 400));
            break;
          case 3:
            if (d.rows.length) d.rows.splice(0, 1);
            break;
          case 4:
            d.other = d.other + chunk(int(r, 1, 300));
            break;
          default:
            d.n = int(r, 10, 99);
        }
      }
    });
    if (ops.length === 0) continue;
    const narrowed = narrowStringPatches(prev, ops as WirePatch[]);
    let viaNarrow: unknown, viaRaw: unknown;
    try {
      viaNarrow = applyWirePatches(prev, narrowed);
      viaRaw = applyWirePatches(prev, ops as WirePatch[]);
    } catch (e) {
      finding(
        "29",
        `case ${i}: applying a compacted patch threw — ${
          (e as Error).message.slice(0, 140)
        }`,
      );
      continue;
    }
    if (JSON.stringify(viaNarrow) !== JSON.stringify(viaRaw)) {
      finding(
        "29",
        `case ${i}: compaction changed the result\n    ops=${
          JSON.stringify(ops).slice(0, 160)
        }\n    narrowed=${JSON.stringify(narrowed).slice(0, 160)}`,
      );
    }
    if (JSON.stringify(viaNarrow) !== JSON.stringify(next)) {
      finding("29", `case ${i}: the wire result is not the produced state`);
    }
    // An `append` must never carry the whole string: that is the bug it was
    // written to fix, and it would be invisible (the value still applies).
    for (const op of narrowed) {
      if (op.op === "append" && op.value.length === 0) {
        finding("29", `case ${i}: an empty append was emitted`);
      }
    }
  }
}

/** 30 — a flag aio ACCEPTS is a flag aio ACTS ON.
 *
 *  `parseCli` refuses an unknown flag and an unusable value, both loudly.
 *  What nothing checked is the third case: a flag on the known list that the
 *  parse loop never assigns. That flag is accepted in silence and does
 *  nothing — the exact shape of "declared and never connected" that
 *  `check:dead-wiring` gates for features, one layer down, on the surface an
 *  operator types at 2am.
 */
async function round30(r: () => number): Promise<void> {
  const base = JSON.stringify(parseCli([]));

  // A plausible value per value-taking flag. A flag missing from here is a
  // NEW flag, and the round says so rather than skipping it.
  const VALUES: Record<string, string> = {
    "--port=": "8123",
    "--client=": "browser",
    "--title=": "T",
    "--channel=": "beta",
    "--width=": "800",
    "--height=": "600",
    "--tls-cert=": "/tmp/c.pem",
    "--tls-key=": "/tmp/k.pem",
    "--cert=": "/tmp/c.pem",
    "--key=": "/tmp/k.pem",
    "--isolate=": "worker",
    "--transport=": "ws",
    "--log-budget=": "10mb",
    "--db-path=": "/tmp/x.db",
    "--host=": "192.168.1.20",
    "--cdp=": "9222",
    "--__aio-relaunch-after=": "123",
  };

  // The one flag whose value is deliberately NOT a `CliFlags` field: the
  // relaunch handshake reads it straight off argv in `awaitPredecessor`,
  // before any config exists. It is checked below by being USED, so the
  // exception cannot quietly grow into "this flag does nothing".
  const RAW_ARGV_ONLY = new Set(["--__aio-relaunch-after="]);

  for (const spec of AIO_RUNTIME_FLAG_SPECS) {
    const arg = spec.endsWith("=")
      ? (VALUES[spec] === undefined ? null : spec + VALUES[spec])
      : spec;
    if (arg === null) {
      finding(
        "30",
        `${spec} is a value flag with no probe value here — add one, or the ` +
          `round silently stops checking it`,
      );
      continue;
    }
    let out: string;
    try {
      out = JSON.stringify(parseCli([arg]));
    } catch (e) {
      finding(
        "30",
        `${arg} is on the known list and was REFUSED: ${
          (e as Error).message.split("\n")[0]
        }`,
      );
      continue;
    }
    if (out === base && !RAW_ARGV_ONLY.has(spec)) {
      finding(
        "30",
        `${arg} parsed to no change at all — an accepted flag that does ` +
          `nothing is worse than a refused one`,
      );
    }
    if (out !== base && RAW_ARGV_ONLY.has(spec)) {
      finding(
        "30",
        `${arg} now lands in CliFlags — take it out of RAW_ARGV_ONLY so the ` +
          `round checks it like every other flag`,
      );
    }
  }

  // …and RAW_ARGV_ONLY is only defensible if something really does read it.
  // Proven, not asserted: `awaitPredecessor` must WAIT on the pid the flag
  // carries, and return at once without it.
  {
    let probed = 0;
    const alive = () => (probed++ < 2);
    const t0 = performance.now();
    await awaitPredecessor([`--__aio-relaunch-after=${Deno.pid}`], {
      timeoutMs: 2_000,
      isAlive: alive,
    });
    if (probed === 0) {
      finding(
        "30",
        "--__aio-relaunch-after is exempt from the effect check because " +
          "awaitPredecessor consumes it — and awaitPredecessor never read it",
      );
    }
    if (performance.now() - t0 > 1_900) {
      finding("30", "awaitPredecessor ignored its own timeout");
    }
    // …and with no flag at all it must not wait for anything.
    let probedBare = 0;
    await awaitPredecessor(["--verbose"], {
      timeoutMs: 2_000,
      isAlive: () => {
        probedBare++;
        return true;
      },
    });
    if (probedBare !== 0) {
      finding("30", "awaitPredecessor probed a pid nobody named");
    }
  }

  // An unknown flag is ALWAYS refused, whatever it is made of.
  for (let i = 0; i < 500; i++) {
    const name = "--" + pick(r, NASTY).slice(0, 30).replace(/\s/g, "x") +
      int(r, 0, 999);
    if (AIO_RUNTIME_FLAGS.has(name.split("=")[0]!)) continue;
    let threw: Error | null = null;
    try {
      parseCli([name]);
    } catch (e) {
      threw = e as Error;
    }
    if (!threw) {
      finding("30", `unknown flag ${JSON.stringify(name)} was accepted`);
    } else if (!(threw instanceof Error) || threw.message.trim() === "") {
      finding("30", `refusing ${JSON.stringify(name)} threw an empty error`);
    } else if (!threw.message.includes(name.split("=")[0]!)) {
      finding(
        "30",
        `refusing ${JSON.stringify(name)} did not name the flag: ${
          threw.message.split("\n")[0]
        }`,
      );
    }
  }

  // Everything after a bare `--` belongs to the app, never to aio.
  for (let i = 0; i < 200; i++) {
    const appArgs = Array.from(
      { length: int(r, 1, 4) },
      () => "--" + pick(r, NASTY).slice(0, 20).replace(/\s/g, "x"),
    );
    try {
      const withApp = JSON.stringify(parseCli(["--", ...appArgs]));
      if (withApp !== base) {
        finding(
          "30",
          `arguments after \`--\` changed aio's own flags: ${
            JSON.stringify(appArgs)
          }`,
        );
      }
    } catch (e) {
      finding(
        "30",
        `arguments after \`--\` were parsed by aio and refused: ${
          (e as Error).message.split("\n")[0]
        }`,
      );
    }
  }

  // Deterministic: the same argv, the same answer, every time.
  const argv = ["--port=9001", "--verbose", "--client=cli"];
  const first = JSON.stringify(parseCli(argv));
  for (let i = 0; i < 20; i++) {
    if (JSON.stringify(parseCli(argv)) !== first) {
      finding("30", "parseCli is not deterministic for one argv");
      break;
    }
  }
}

// ── dispatch ────────────────────────────────────────────────────────

const ROUNDS: Record<string, (r: () => number) => void | Promise<void>> = {
  "1": round1,
  "2": round2,
  "3": round3,
  "4": round4,
  "5": round5,
  "6": round6,
  "7": round7,
  "8": round8,
  "9": round9,
  "10": round10,
  "11": round11,
  "12": round12,
  "13": round13,
  "14": round14,
  "15": round15,
  "16": round16,
  "17": round17,
  "18": round18,
  "19": round19,
  "20": round20,
  "21": round21,
  "22": round22,
  "23": round23,
  "24": round24,
  "25": round25,
  "26": round26,
  "27": round27,
  "28": round28,
  "29": round29,
  "30": round30,
};

// Env FIRST, argv second. A round that boots a real server calls `parseCli()`,
// which reads `Deno.args` — and this script's own arguments are not aio's, so
// `audit-round.ts 23 --seed=1` made the server refuse an unknown flag. Running
// those rounds as `AUDIT_ROUND=23 AUDIT_SEED=1 deno run …` keeps argv empty.
const which = Deno.env.get("AUDIT_ROUND") ??
  Deno.args.find((a) => !a.startsWith("--")) ?? "";
const seedArg = Deno.args.find((a) => a.startsWith("--seed="));
const seed = Number(Deno.env.get("AUDIT_SEED") ?? "") ||
  (seedArg ? Number(seedArg.slice(7)) : 1);
const fn = ROUNDS[which];
if (!fn) {
  console.error(
    `usage: audit-round.ts <${Object.keys(ROUNDS).join("|")}> [--seed=N]`,
  );
  Deno.exit(2);
}
const t0 = performance.now();
await fn(rng(seed));
const ms = (performance.now() - t0).toFixed(0);
if (findings.length) {
  console.log(`round ${which} (seed ${seed}) — ${findings.length} FINDING(s):`);
  for (const f of findings.slice(0, 40)) console.log(`  FINDING: ${f}`);
  if (findings.length > 40) console.log(`  … ${findings.length - 40} more`);
  Deno.exit(1);
}
console.log(`round ${which} (seed ${seed}) clean in ${ms}ms`);
