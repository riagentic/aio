// An app/auth TOKEN never reaches a log line.
//
// A share link (`…/?token=<key>`) is the credential itself, and logs are what
// gets pasted into bug reports, CI output and scrollback. Three sites printed
// it: the "Electron not installed" line (the window URL carries the key), the
// forced-aio:// warning in the generated Electron main script, and the thin
// client's "launching aio client → <url>". The cli client's "DIFFERENT app"
// refusal printed the share link it was given, too.
//
// Two layers:
//   • a SOURCE gate over src/: a log/console call that builds `token=${…}` /
//     `token=' + …` is red, and so is one that prints a variable the same file
//     ASSIGNED such a URL to. The share-link lines at `--expose` boot print it
//     on purpose and say so: `// aio-ok(token-log): <why>` on the call.
//   • BEHAVIOUR at each fixed site, driven the cheap way (no real Electron
//     window: a fake binary where one is spawned at all).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { justified } from "../src/diagnostics/ok-marker.ts";
import {
  redactUrlToken,
  redactUrlTokenSource,
} from "../src/diagnostics/redact.ts";
import { electronMissingLines } from "../src/server/aio-lifecycle.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { within } from "./within.ts";

const SRC = new URL("../src/", import.meta.url).pathname;
const SECRET = "s3cr3t-KEY-9f2a";

// ── the source gate ─────────────────────────────────────────────────────────

/** A log/console call's opening. Generated-script text is scanned too — the
 *  Electron main scripts are source that logs, just not source Deno runs. */
const CALL =
  /\b(?:console|log|logger|globalLog)\.(?:log|warn|error|info|debug|fatal)\(|(?<![\w.])log\(/g;
/** A token VALUE spliced into text: `token=${…}` or `token=' + …`. */
const TOKEN_VALUE = /token=(?:\$\{|["'`]\s*\+)/;

/** Every .ts/.tsx under `dir`, recursively. */
async function* sources(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* sources(p);
    else if (e.isFile && /\.tsx?$/.test(e.name)) yield p;
  }
}

/** The call's text, from its `(` to the matching `)` (naive, which is fine:
 *  an unbalanced paren inside a string only widens the span — fails loud). */
function callSpan(src: string, at: number, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length && i - at < 4000; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at, at + 4000);
}

/** Every token-bearing log call in one file's text: `file:line  call`. */
function tokenLogFindings(file: string, src: string): string[] {
  // Variables this file builds a token-bearing URL into — and every variable
  // copied from one (`const shown = wsUrl` carries the key as surely as the
  // line that built it), to a fixed point. Through the redactor is not a copy.
  const decls = [
    ...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=([^;]*)/g),
  ].map((m) => ({
    name: m[1]!,
    init: (m[2] ?? "").replace(/redactUrlToken\([^)]*\)/g, ""),
  }));
  // The identifier, not the word: `--server-url` in a message is not `url`.
  const idRe = (names: string[]) =>
    new RegExp(`(?<![\\w.$-])(?:${names.join("|")})(?![\\w$-])`);
  const carriers = decls.filter((d) => TOKEN_VALUE.test(d.init))
    .map((d) => d.name);
  for (let grew = carriers.length > 0; grew;) {
    // A copy, a concatenation, a template, or a wrapper that keeps the text
    // (`new URL(u)`, `String(u)`, `encodeURI(u)`) — never any other ARGUMENT:
    // the socket built from `new WebSocket(wsUrl)` does not print its URL.
    const id = idRe(carriers).source;
    const copy = new RegExp(`(?<![(,]\\s*)${id}`);
    const kept = new RegExp(
      `(?:new\\s+URL|String|encodeURI(?:Component)?)\\(\\s*${id}`,
    );
    const more = decls.filter((d) =>
      !carriers.includes(d.name) && (copy.test(d.init) || kept.test(d.init))
    ).map((d) => d.name);
    carriers.push(...new Set(more));
    grew = more.length > 0;
  }
  const carrierRe = carriers.length ? idRe(carriers) : null;
  const lines = src.split("\n");
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    const call = callSpan(src, m.index!, m.index! + m[0].length - 1);
    // A carrier passed through the redactor is the fix, not a finding.
    const shown = call.replace(/redactUrlToken\([^)]*\)/g, "");
    if (!TOKEN_VALUE.test(shown) && !(carrierRe && carrierRe.test(shown))) {
      continue;
    }
    const first = src.slice(0, m.index!).split("\n").length; // 1-based
    const last = first + call.split("\n").length - 1;
    // The marker sits on the call or on the line above it.
    const ok = lines.slice(Math.max(0, first - 2), last)
      .some((l) => justified(l, "token-log"));
    if (!ok) {
      out.push(`${file}:${first}  ${call.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return out;
}

Deno.test("no-token-in-logs: no log/console call in src/ prints a token", async () => {
  const findings: string[] = [];
  let justifiedCount = 0;
  let files = 0;
  for await (const path of sources(SRC)) {
    files++;
    const src = await Deno.readTextFile(path);
    findings.push(...tokenLogFindings(path.slice(SRC.length), src));
    justifiedCount += src.split("\n")
      .filter((l) => /\baiol?-ok\([^)]*\btoken-log\b/.test(l)).length;
  }
  assertEquals(
    findings,
    [],
    `a log line prints a token-bearing URL. Show it through ` +
      `redactUrlToken() (src/diagnostics/redact.ts); if printing the token ` +
      `IS the point (a share link the operator copies), say so on the call: ` +
      `// aio-ok(token-log): <why>\n  ${findings.join("\n  ")}`,
  );
  assert(files > 300, `the scan saw only ${files} files — it is blind`);
  // The allow-list is exactly the two --expose share-link lines. A third is a
  // decision, and it belongs in this number.
  assertEquals(justifiedCount, 2, "aio-ok(token-log) markers in src/");
});

Deno.test("no-token-in-logs: the gate goes red on each leak shape it guards", () => {
  const leaks = [
    "log.info(`at ${url}?token=${token}`);",
    "console.warn('[aio] at ' + base + '?token=' + tok);",
    "const u = `${base}?token=${t}`;\nlog.error(\n  `server is up at ${u}`,\n);",
    "const u = `${base}?token=${t}`;\nconst shown = u;\nlog.warn(`cannot reach ${shown}`);",
    "const u = `${base}?token=${t}`;\nconst p = new URL(u);\nlog.info(`at ${p}`);",
    "const u = `${base}?token=${t}`;\nconst s = String(u);\nconsole.log('at ' + s);",
  ];
  for (const src of leaks) {
    assertEquals(tokenLogFindings("x.ts", src).length, 1, src);
  }
  const fine = [
    "const u = `${base}?token=${t}`;\nlog.error(`at ${redactUrlToken(u)}`);",
    "// aio-ok(token-log): share link\nlog.info(`share: ${u}?token=${t}`);",
    'log.warn("authenticated via ?token= in the URL — prefer a header");',
  ];
  for (const src of fine) {
    assertEquals(tokenLogFindings("x.ts", src), [], src);
  }
  // A marker scoped to another gate does not cover this one.
  assertEquals(
    tokenLogFindings(
      "x.ts",
      "// aio-ok(silent-catch): no\nlog.info(`${u}?token=${t}`);",
    ).length,
    1,
  );
});

// ── the redactor, and its twin inside the Electron scripts ──────────────────

const SAMPLES = [
  `http://127.0.0.1:5173/?token=${SECRET}`,
  `http://127.0.0.1:5173/app?x=1&token=${SECRET}&y=2#top`,
  `ws://h:1/ws?token=${SECRET}`,
  `the server is up at http://h/?token=${SECRET} — open it`,
  `'http://h/?token=${SECRET}'`,
  "http://h/?access_token=keepme",
  "http://h/no-token-here",
];

Deno.test("no-token-in-logs: redactUrlToken hides the value and keeps the rest", () => {
  for (const s of SAMPLES) {
    const r = redactUrlToken(s);
    assert(!r.includes(SECRET), `leaked: ${r}`);
  }
  assertEquals(
    redactUrlToken(`http://h:1/app?x=1&token=${SECRET}&y=2#top`),
    "http://h:1/app?x=1&token=…&y=2#top",
  );
  assertEquals(
    redactUrlToken(`up at http://h/?token=${SECRET} — open it`),
    "up at http://h/?token=… — open it",
  );
  assertEquals(redactUrlToken("http://h/no-token"), "http://h/no-token");
});

Deno.test("no-token-in-logs: the generated-script redactor is the TS one", () => {
  const js = new Function(`return ${redactUrlTokenSource()};`)() as (
    s: unknown,
  ) => string;
  for (const s of SAMPLES) assertEquals(js(s), redactUrlToken(s));
});

// ── the fixed sites ─────────────────────────────────────────────────────────

Deno.test("no-token-in-logs: 'Electron not installed' shows the URL without its key", () => {
  const lines = electronMissingLines(`http://127.0.0.1:4100/?token=${SECRET}`);
  const text = lines.join("\n");
  assert(!text.includes(SECRET), `the missing-Electron lines leak:\n${text}`);
  assertStringIncludes(text, "http://127.0.0.1:4100/?token=…");
  assertStringIncludes(text, "deno task install:electron");
});

Deno.test("no-token-in-logs: the generated UDS main script logs no token", () => {
  const script = electronMainScriptUDS(
    `http://127.0.0.1:4100/?token=${SECRET}`,
    "/tmp/none.sock",
    { forceProtocol: true },
  );
  // The key IS in the script — the window has to load it — but only where
  // the URL is used, never on a line that logs.
  assert(script.includes(SECRET), "the functional URL lost its token");
  const logging = script.split("\n").filter((l) => /\bconsole\.\w+\(/.test(l));
  // Not blind: the three URL-printing lines are among those scanned.
  for (
    const want of [
      "HTTP_URL_SHOWN",
      "_shownUrl(failedUrl)",
      "_shownUrl(u.href)",
    ]
  ) {
    assert(
      logging.some((l) => l.includes(want)),
      `no console line prints ${want} — the scan is blind`,
    );
  }
  // aio-ok: `logging` is proven to hold the three URL-printing lines above
  for (const l of logging) {
    assert(!l.includes(SECRET), `a console line carries the token: ${l}`);
    // Dynamic URLs reach a log only through the redactor.
    const bare = l.replace(/_shownUrl\([^)]*\)/g, "");
    assert(
      !/\b(?:HTTP_URL|failedUrl|u\.href)\b/.test(bare),
      `a console line prints a URL unredacted: ${l}`,
    );
  }
  assertStringIncludes(
    script,
    `const HTTP_URL_SHOWN = "http://127.0.0.1:4100/?token=…"`,
  );
});

Deno.test({
  name:
    "no-token-in-logs: the thin client's launch line hides a --server-url key",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { launchElectronClient } = await import(
      "../src/electron/electron-spawn.ts"
    );
    const dir = await tempDir("aio-token-log");
    // A fake runtime: exits at once, so no window can ever appear.
    const fake = join(dir, "electron");
    await Deno.writeTextFile(fake, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(fake, 0o755);
    const was = Deno.env.get("ELECTRON_PATH");
    Deno.env.set("ELECTRON_PATH", fake);
    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      debug: () => {},
    };
    try {
      const proc = await launchElectronClient(
        log as never,
        `http://10.0.0.2:4100/?token=${SECRET}`,
      );
      assert(proc, "the fake runtime was not launched");
      await proc.status;
      const hit = lines.find((l) => l.includes("launching aio client"));
      assert(hit, `no launch line:\n${lines.join("\n")}`);
      assertStringIncludes(hit, "http://10.0.0.2:4100/?token=…");
      assert(
        !lines.some((l) => l.includes(SECRET)),
        `a log line carries the token:\n${lines.join("\n")}`,
      );
    } finally {
      if (was === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", was);
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "no-token-in-logs: --server-url's 'connecting to' line hides the key",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { handleThinClient } = await import(
      "../src/server/aio-run-helpers.ts"
    );
    const dir = await tempDir("aio-token-thin");
    const fake = join(dir, "electron");
    await Deno.writeTextFile(fake, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(fake, 0o755);
    const was = Deno.env.get("ELECTRON_PATH");
    Deno.env.set("ELECTRON_PATH", fake);
    const cap = captureLog();
    // handleThinClient ends the process when the window closes; here it
    // must only return.
    const origExit = Deno.exit;
    let exited: number | undefined;
    Deno.exit = ((code?: number) => {
      exited = code ?? 0;
    }) as typeof Deno.exit;
    try {
      await handleThinClient(`http://10.0.0.2:4100/?token=${SECRET}`, () => {});
    } finally {
      Deno.exit = origExit;
      cap.restore();
      if (was === undefined) Deno.env.delete("ELECTRON_PATH");
      else Deno.env.set("ELECTRON_PATH", was);
      await dropTempDir(dir);
    }
    assertEquals(exited, 0, "the fake window's exit was not reached");
    const hit = cap.lines.find((l) => l.includes("connecting to"));
    assert(hit, `no 'connecting to' line:\n${cap.lines.join("\n")}`);
    assertStringIncludes(hit, "http://10.0.0.2:4100/?token=…");
    assert(
      !cap.lines.some((l) => l.includes(SECRET)),
      `a log line carries the key:\n${cap.lines.join("\n")}`,
    );
  },
});

// ── the CLI client: health probe credential, and its log lines ─────────────

/** Captures every log line the cli client emits, any level. */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (_lvl: string, cat: string, msg?: string) =>
        lines.push(`${cat} ${msg ?? ""}`),
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  return { lines, restore: () => setLogger(prev) };
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** A keyed fake aio server: `/__aio/health` answers `appId()` and records how
 *  it was asked; `/ws` admits only `Bearer <key>`. */
function keyedFake(key: string, appId: () => string) {
  const health: { auth: string | null; url: string }[] = [];
  const sockets = new Set<WebSocket>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: freePort(), onListen: () => {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/__aio/health") {
        health.push({ auth: req.headers.get("authorization"), url: req.url });
        return Response.json({ status: "healthy", appId: appId() });
      }
      if (req.headers.get("authorization") !== `Bearer ${key}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => {
        sockets.add(socket);
        socket.send(JSON.stringify({ v: 2, t: "state", d: { ok: true } }));
      };
      socket.onclose = () => sockets.delete(socket);
      return response;
    },
  );
  return { server, health, sockets, port: server.addr.port };
}

const PROBE_CASES: [string, (p: number) => [string, string | undefined]][] = [
  [
    "the share link's ?token=",
    (p) => [`http://127.0.0.1:${p}/?token=${SECRET}`, undefined],
  ],
  ["opts.token", (p) => [`http://127.0.0.1:${p}`, SECRET]],
];
for (const [how, mk] of PROBE_CASES) {
  Deno.test(`cli health probe: the key (${how}) rides as Bearer, never in the URL`, async () => {
    const cap = captureLog();
    const fake = keyedFake(SECRET, () => "app-a");
    const [url, token] = mk(fake.port);
    const cli = connectCli(url, token ? { token } : undefined);
    try {
      const ready = await within(cli.ready, 5000, "TIMED OUT" as const);
      assert(ready !== "TIMED OUT", "never connected to the keyed server");
      assert(
        await waitFor(() => fake.health.length > 0, 5000),
        "the client never probed /__aio/health",
      );
      for (const h of fake.health) {
        assertEquals(h.auth, `Bearer ${SECRET}`, "health probe credential");
        assert(!h.url.includes("token"), `the key rode in the URL: ${h.url}`);
      }
    } finally {
      cli.close();
      await fake.server.shutdown();
      cap.restore();
    }
    assert(
      !cap.lines.some((l) => l.includes(SECRET)),
      `a cli log line carries the key:\n${cap.lines.join("\n")}`,
    );
  });
}

Deno.test("cli client: the 'DIFFERENT app' refusal does not print the share link's key", async () => {
  const cap = captureLog();
  let id = "app-a";
  const fake = keyedFake(SECRET, () => id);
  const cli = connectCli(`http://127.0.0.1:${fake.port}/?token=${SECRET}`);
  try {
    const ready = await within(cli.ready, 5000, "TIMED OUT" as const);
    assert(ready !== "TIMED OUT", "never connected");
    assert(await waitFor(() => fake.health.length > 0, 5000), "no probe");
    await new Promise((r) => setTimeout(r, 100)); // the identity lands
    // Another app answers on the same port: the client refuses to reattach.
    id = "app-b";
    for (const s of fake.sockets) s.close();
    const hit = await waitFor(
      () => cap.lines.some((l) => l.includes("DIFFERENT app")),
      10_000,
    );
    assert(hit, `no refusal logged:\n${cap.lines.join("\n")}`);
  } finally {
    cli.close();
    await fake.server.shutdown();
    cap.restore();
  }
  const line = cap.lines.find((l) => l.includes("DIFFERENT app"))!;
  assertStringIncludes(line, "?token=…");
  assert(
    !cap.lines.some((l) => l.includes(SECRET)),
    `a cli log line carries the key:\n${cap.lines.join("\n")}`,
  );
});

Deno.test("cli client: 'cannot reach' never prints the key", async () => {
  const cap = captureLog();
  const cli = connectCli(`http://127.0.0.1:${freePort()}/?token=${SECRET}`);
  cli.ready.catch(() => {}); // never connects — close() may reject it
  try {
    const hit = await waitFor(
      () => cap.lines.some((l) => l.includes("cannot reach")),
      10_000,
    );
    assert(hit, `no 'cannot reach' line:\n${cap.lines.join("\n")}`);
  } finally {
    cli.close();
    cap.restore();
  }
  assert(
    !cap.lines.some((l) => l.includes(SECRET)),
    `a cli log line carries the key:\n${cap.lines.join("\n")}`,
  );
});
