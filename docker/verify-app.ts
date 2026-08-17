// verify-app.ts — "is this app actually WORKING?", answered in tiers.
//
// Runs INSIDE the lab container (or anywhere), against an app that is already
// listening. It exists because every cheap check we had proves less than it
// looks like it proves:
//
//   • "the build succeeded"      → says nothing about the artifact running
//   • "the port is open"         → says nothing about the page
//   • "GET / returned 200"       → an EMPTY shell returns 200; a blank screen
//                                  is 200 with a script that threw
//   • "the initial state is set" → says nothing about a method ever running
//
// So each tier answers a question the tier before it cannot:
//
//   html      the server serves an HTML document that boots a client
//   health    the app says it is healthy about itself
//   surface   the UI TREE renders (dev only — the headless renderer is
//             dev-gated, like the trojan API it rides on)
//   dispatch  a method RUNS and the state changes (dev only, same reason)
//   browser   a real browser loads the page, paints non-empty text, and logs
//             no uncaught error — the only tier that can speak for a PROD
//             artifact, where the trojan API does not exist by design
//
// Exit code 0 = every requested tier passed. Anything else prints what failed
// and why, in the words someone debugging it would want.

const args = new Map<string, string>();
for (const a of Deno.args) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1]!, m[2] ?? "1");
}

const PORT = args.get("port") ?? "";
const BASE = args.get("base") ?? `http://127.0.0.1:${PORT}`;
const MODE = (args.get("mode") ?? "dev") as "dev" | "prod";
const BROWSER = args.get("browser") ?? "";
const APP_ID = args.get("app-id") ?? "";
const LOG_DIR = args.get("log-dir") ?? null;
const TIMEOUT_MS = Number(args.get("timeout") ?? 90_000);
const VERBOSE = args.has("verbose");
const INTERACT = args.has("interact");
const EXPECT = args.get("expect") ?? "";

if (!PORT && !args.has("base")) {
  console.error("verify-app: --port=<n> (or --base=<url>) is required");
  Deno.exit(2);
}

const results: { tier: string; ok: boolean; detail: string }[] = [];
const say = (s: string) => console.log(s);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function record(tier: string, ok: boolean, detail: string) {
  results.push({ tier, ok, detail });
  say(`${ok ? "\x1b[32m  ✓" : "\x1b[31m  ✗"} ${tier}\x1b[0m ${dim(detail)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns a value, or the deadline passes. */
async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  ms = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
    } catch (e) {
      lastErr = String(e);
    }
    await sleep(250);
  }
  throw new Error(
    `timed out after ${ms}ms waiting for ${what}${
      lastErr ? ` — last error: ${lastErr}` : ""
    }`,
  );
}

async function get(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "*/*" },
  });
  return res;
}

// ── tier: html ──────────────────────────────────────────────────────────

async function tierHtml(): Promise<string> {
  const html = await waitFor("the server to serve /", async () => {
    const res = await get("/");
    const body = await res.text();
    if (!res.ok) return null;
    return body;
  });

  if (html.trim().length === 0) throw new Error("GET / returned an EMPTY body");
  if (!/<html[\s>]/i.test(html)) {
    throw new Error(
      `GET / did not return an HTML document (first 120 chars: ${
        JSON.stringify(html.slice(0, 120))
      })`,
    );
  }
  // The shell has to actually BOOT something: an HTML page with no client
  // script is a blank screen that passes every status-code check.
  const boots = /<script/i.test(html) &&
    (/app\.js/.test(html) || /__aio/.test(html) || /type="module"/.test(html));
  if (!boots) {
    throw new Error(
      "the HTML has no client bootstrap (no <script> loading app.js or an " +
        "aio module) — this is the blank-screen shape",
    );
  }
  return `${html.length}B, mounts #root, boots a client`;
}

// ── tier: health ────────────────────────────────────────────────────────

async function tierHealth(): Promise<string> {
  const res = await get("/__aio/health");
  if (!res.ok) throw new Error(`/__aio/health → HTTP ${res.status}`);
  const body = await res.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!body) throw new Error("/__aio/health returned no JSON");
  const status = String(body.status ?? body.health ?? "unknown");
  if (/unhealthy|error|degraded/i.test(status)) {
    throw new Error(
      `the app reports itself ${status}: ${JSON.stringify(body)}`,
    );
  }
  return `status=${status}`;
}

// ── tier: surface (dev) ─────────────────────────────────────────────────

/** Every text node in a serialized surface tree, flattened. */
function surfaceText(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const n of node) surfaceText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    for (const k of ["text", "value", "label"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
    for (const k of ["children", "elements", "components", "roots"]) {
      if (o[k]) surfaceText(o[k], out);
    }
    return out;
  }
  if (typeof node === "string" && node.trim()) out.push(node.trim());
  return out;
}

async function tierSurface(): Promise<string> {
  const res = await get("/__aio/trojan/surface/server");
  if (res.status === 404) {
    throw new Error(
      "the headless surface renderer is not mounted — this app has no UI " +
        "entry, or it is a prod build (where the trojan API is dev-only by " +
        "design; use the browser tier instead)",
    );
  }
  if (!res.ok) throw new Error(`surface/server → HTTP ${res.status}`);
  const roots = await res.json();
  const texts = surfaceText(roots);
  if (texts.length === 0) {
    throw new Error(
      "the UI tree rendered EMPTY — a page with no text is the blank screen " +
        "this tier exists to catch",
    );
  }
  return `${texts.length} text nodes, e.g. ${
    JSON.stringify(texts.slice(0, 3))
  }`;
}

// ── tier: dispatch (dev) ────────────────────────────────────────────────

/** `{ cell: [method, …] }` — what this app can actually be told to do. */
async function cellMethods(): Promise<Record<string, string[]>> {
  const res = await get("/__aio/trojan/cells");
  if (!res.ok) throw new Error(`trojan/cells → HTTP ${res.status}`);
  const raw = await res.json() as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const [cell, v] of Object.entries(raw ?? {})) {
    const names = Array.isArray(v)
      ? v.map(String)
      : typeof v === "object" && v
      ? Object.keys(v as Record<string, unknown>)
      : [];
    if (names.length) out[cell] = names;
  }
  return out;
}

async function state(): Promise<unknown> {
  const res = await get("/__aio/trojan/state");
  if (!res.ok) throw new Error(`trojan/state → HTTP ${res.status}`);
  return await res.json();
}

async function tierDispatch(): Promise<string> {
  const methods = await cellMethods();
  const entries = Object.entries(methods);
  if (entries.length === 0) {
    throw new Error("the app exposes no cell methods — nothing can be driven");
  }
  const before = JSON.stringify(await state());

  // Try zero-argument methods first: they are the ones we can call blind.
  // A method that needs arguments is not evidence of a broken app, so a
  // no-op result only fails the tier if NOTHING moved the state.
  const tried: string[] = [];
  for (const [cell, names] of entries) {
    for (const name of names) {
      if (name.startsWith("__")) continue;
      const type = `${cell}:${name}`;
      tried.push(type);
      const res = await fetch(`${BASE}/__aio/trojan/dispatch`, {
        method: "POST",
        // The control plane is CSRF-protected: a POST without `X-AIO` is
        // refused, so a cross-origin form cannot drive a developer's app.
        headers: { "content-type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ type, payload: { args: [] } }),
      });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      await res.json().catch(() => null);
      await sleep(150);
      const after = JSON.stringify(await state());
      if (after !== before) return `${type} changed the state`;
      if (tried.length >= 12) break;
    }
    if (tried.length >= 12) break;
  }
  throw new Error(
    `dispatched ${tried.length} method(s) and the state never changed ` +
      `(${tried.slice(0, 6).join(", ")}${tried.length > 6 ? ", …" : ""}). ` +
      `Either every one needs arguments, or methods are not running — which ` +
      `is the failure an SSR check can never see.`,
  );
}

// ── tier: browser ───────────────────────────────────────────────────────

/** A minimal Chrome DevTools Protocol client — enough to evaluate expressions
 *  in the page and hear its console. No dependency: CDP is a WebSocket and
 *  JSON, and pulling a driver into the lab image would test the driver's
 *  environment as much as ours. */
class CDP {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (r: unknown) => void>();
  /** Everything the page complained about, in order. */
  readonly problems: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)!(msg);
        this.#pending.delete(msg.id);
        return;
      }
      // An uncaught exception and a console.error are the two ways a page says
      // "I am broken" — a UI that paints and then throws is not working, and
      // this is the only place that difference is visible.
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.problems.push(
          `uncaught: ${d?.exception?.description ?? d?.text ?? "unknown"}`,
        );
      }
      if (
        msg.method === "Runtime.consoleAPICalled" &&
        msg.params?.type === "error"
      ) {
        this.problems.push(
          `console.error: ${
            (msg.params.args ?? []).map((
              a: { value?: unknown; description?: string },
            ) => String(a.value ?? a.description ?? "")).join(" ")
          }`,
        );
      }
    };
  }

  static async attach(devtoolsPort: number, deadlineMs: number): Promise<CDP> {
    const target = await waitFor("chrome to expose a page target", async () => {
      const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
      const list = await res.json() as {
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
        null;
    }, deadlineMs);
    const ws = new WebSocket(target.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("could not attach to the page"));
    });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return cdp;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<
    { result?: { result?: { value?: unknown } } }
  > {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve as (r: unknown) => void);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression IN THE PAGE and return its value. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value as T;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch { /* already gone */ }
  }
}

/** Is the UI THERE — the one a user is supposed to see?
 *
 *  Not "did the port open" and not "did a click work": is the screen a user
 *  lands on the expected app, rather than one of the four things it is when
 *  something went wrong —
 *
 *    • BLANK: the mount point is empty. `200 OK`, HTML served, nothing in it.
 *    • STUCK: still a loader/"Connecting…" long after the app should be up.
 *    • BROKEN: the framework's own module-error page ("fix to continue"),
 *      which is what a failed build serves in place of the app.
 *    • DEAD: painted, but the client cannot reach the server — the status
 *      widget says "Reconnecting…" or "Protocol mismatch", so nothing on that
 *      screen will ever respond.
 *
 *  It POLLS rather than snapshots: a loader that clears in two seconds is a
 *  normal app starting, and only a loader that is still there at the deadline
 *  is a finding. The failure message quotes what was actually on screen,
 *  because "the UI did not come up" is not something anyone can act on. */
async function tierBrowser(): Promise<string> {
  const profile = await Deno.makeTempDir({ prefix: "aio-lab-chrome-" });
  const devtoolsPort = 9222 + Math.floor(Deno.pid % 500);
  let chrome: Deno.ChildProcess | null = null;
  let cdp: CDP | null = null;

  // What the page looks like right now, in one round trip.
  const PROBE = `(() => {
    const root = document.querySelector('#root, #app, [data-aio-root]') || document.body;
    const text = (document.body && document.body.innerText || '').trim();
    // The framework's connection widget is a fixed-position overlay it appends
    // to <body>; its text is the client's own account of the socket.
    const overlay = [...document.querySelectorAll('body > div')]
      .filter((d) => d.style && d.style.position === 'fixed' && d.style.zIndex === '99999')
      .map((d) => (d.innerText || '').trim())[0] || '';
    return {
      title: document.title || '',
      rootChildren: root ? root.children.length : 0,
      text,
      overlay,
    };
  })()`;

  type Probe = {
    title: string;
    rootChildren: number;
    text: string;
    overlay: string;
  };
  const LOADING =
    /^(loading|connecting|please wait|initializing|starting|booting)\b/i;

  const verdict = (p: Probe): string | null => {
    if (/Module Errors/i.test(p.title) || /fix to continue/i.test(p.text)) {
      return `the server is serving the module-error page instead of the app — ` +
        `the build is broken: ${JSON.stringify(p.text.slice(0, 200))}`;
    }
    if (/Protocol mismatch/i.test(p.overlay)) {
      return `the client refuses to talk to this server: "${p.overlay}"`;
    }
    if (/Reconnect/i.test(p.overlay)) {
      return `the page is painted but DEAD — the client cannot reach the ` +
        `server ("${p.overlay}"), so nothing on this screen will respond`;
    }
    if (p.rootChildren === 0) {
      return "the mount point is EMPTY — a blank screen (the server answered " +
        "200 and the client rendered nothing)";
    }
    const own = p.overlay ? p.text.replace(p.overlay, "").trim() : p.text;
    if (own.length === 0) {
      return "nothing is on screen except the framework's status widget";
    }
    if (LOADING.test(own) && own.length < 40) {
      return `still showing a loader (${JSON.stringify(own)}) — the UI never ` +
        `finished coming up`;
    }
    if (EXPECT && !p.text.includes(EXPECT)) {
      return `the UI is up but does not contain the expected text ` +
        `${JSON.stringify(EXPECT)} — on screen: ${
          JSON.stringify(own.slice(0, 120))
        }`;
    }
    return null; // this is the app, and it is ready
  };

  try {
    chrome = new Deno.Command(BROWSER, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${devtoolsPort}`,
        `${BASE}/`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();

    cdp = await CDP.attach(devtoolsPort, 30_000);

    let last: Probe = { title: "", rootChildren: 0, text: "", overlay: "" };
    let why = "the page never loaded";
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      last = await cdp.eval<Probe>(PROBE);
      const problem = verdict(last);
      if (problem === null) {
        ready = true;
        break;
      }
      why = problem;
      await sleep(400);
    }
    if (!ready) throw new Error(why);

    // A UI that paints and then throws is not working; it only looks like it.
    if (cdp.problems.length > 0) {
      throw new Error(
        `the UI is on screen but the page logged ${cdp.problems.length} ` +
          `error(s): ${cdp.problems.slice(0, 3).join(" | ")}`,
      );
    }

    // Opt-in only (`--interact`): the question here is whether the UI is
    // THERE, and clicking the first control it finds is a different question
    // with a different failure mode.
    let extra = "";
    if (INTERACT) {
      const before = last.text;
      const clicked = await cdp.eval<string | null>(`(() => {
        const sel = 'button, [role=button], .button, input[type=button], input[type=submit]';
        const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
        if (!el) return null;
        const label = (el.innerText || el.value || '').trim();
        el.click();
        return label || '(unlabelled)';
      })()`);
      if (clicked) {
        const changed = await waitFor("the UI to react", async () => {
          const now = await cdp!.eval<string>("document.body.innerText");
          return now !== before ? now : null;
        }, 8_000).catch(() => null);
        if (changed === null) {
          throw new Error(
            `clicked "${clicked}" and nothing on screen changed within 8s`,
          );
        }
        extra = ` · clicking "${clicked}" worked`;
      }
    }

    const shown = last.text.replace(/\s+/g, " ").slice(0, 60);
    return `the app is on screen: ${JSON.stringify(shown)} · ` +
      `${last.rootChildren} element(s) mounted · no console errors${extra}`;
  } finally {
    cdp?.close();
    try {
      chrome?.kill("SIGKILL");
      await chrome?.status;
    } catch { /* already gone */ }
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
}

/** NO ERRORS — anywhere the app could have put one.
 *
 *  Three sources, because each knows something the others do not:
 *
 *    • the SERVER's own error channel (`/__aio/error`, what `am errors` reads)
 *      — cell failures the UI may never show;
 *    • `error.log` / `app.log` on disk — anything logged at error level,
 *      including things that happened before a client connected;
 *    • `client.log` — the browser's console, forwarded by the framework, so a
 *      page error survives even if nobody was watching the tab.
 *
 *  An app that serves a page while logging errors is not "working" — it is
 *  failing quietly, which this framework treats as worse than failing loudly.
 */
async function tierNoErrors(): Promise<string> {
  const found: string[] = [];

  // 1. the server's error channel — the same endpoint `am errors` reads.
  try {
    const res = await get("/__aio/error");
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && text !== "null" && text !== "{}") {
        const parsed = JSON.parse(text) as { errors?: unknown[] } | null;
        const errs = Array.isArray(parsed?.errors) ? parsed!.errors : [];
        for (const e of errs.slice(0, 3)) found.push(`server: ${String(e)}`);
      }
    } else {
      await res.body?.cancel();
    }
  } catch { /* endpoint absent on this build — the logs below still speak */ }

  // 2 + 3. the app's own log directory.
  const dir = LOG_DIR ??
    (APP_ID ? `${Deno.env.get("HOME")}/.${APP_ID}/logs` : null);
  let scanned = 0;
  if (dir) {
    // A log directory that is not there is a FINDING, not a quiet pass. It
    // means one of two things and both matter: logging is off, or the app's
    // identity is not what we think it is — which is exactly how this tier
    // reported "0 log file(s) clean" while the app was writing to
    // `~/.<app>-<version>/`, because installing it under a versioned file name
    // had renamed it. Checking nothing and reporting success is the failure
    // this whole lab exists to remove.
    try {
      await Deno.stat(dir);
    } catch {
      throw new Error(
        `no log directory at ${dir} — either this app has logging disabled, ` +
          `or its identity is not "${APP_ID}" and it writes somewhere else. ` +
          `Nothing was scanned, so "no errors" would have meant "nothing was ` +
          `looked at".`,
      );
    }
    for (
      const [file, pattern] of [
        ["error.log", /\S/],
        ["app.log", /\bERROR\b/],
        ["client.log", /\[ERROR\]/],
      ] as const
    ) {
      let text = "";
      try {
        text = await Deno.readTextFile(`${dir}/${file}`);
      } catch {
        continue; // absent is the normal, healthy case for error.log
      }
      scanned++;
      const hits = text.split("\n").filter((l) => pattern.test(l));
      for (const h of hits.slice(0, 3)) {
        found.push(`${file}: ${h.trim().slice(0, 200)}`);
      }
    }
  }

  if (found.length > 0) {
    throw new Error(
      `${found.length} error(s) recorded while the app was "working":\n    ` +
        found.slice(0, 5).join("\n    "),
    );
  }
  return dir
    ? `server error channel clean · ${scanned} log file(s) clean`
    : "server error channel clean (no log dir known — pass --app-id or --log-dir)";
}

// ── run ─────────────────────────────────────────────────────────────────

const tiers: [string, () => Promise<string>][] = [
  ["html", tierHtml],
  ["health", tierHealth],
];
if (MODE === "dev") {
  tiers.push(["surface", tierSurface], ["dispatch", tierDispatch]);
}
if (BROWSER) tiers.push(["browser", tierBrowser]);
// LAST, always: it is the only tier that can see what the app said while every
// other tier was declaring success.
tiers.push(["no-errors", tierNoErrors]);

say(`\nverifying ${BASE} (${MODE}${BROWSER ? ", with browser" : ""})`);
for (const [name, fn] of tiers) {
  try {
    record(name, true, await fn());
  } catch (e) {
    record(name, false, (e as Error).message);
  }
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  say(`\n\x1b[32m✓ app verified\x1b[0m — ${results.length} tier(s) passed\n`);
  Deno.exit(0);
}
say(
  `\n\x1b[31m✗ app NOT working\x1b[0m — ${failed.length}/${results.length} ` +
    `tier(s) failed: ${failed.map((f) => f.tier).join(", ")}\n`,
);
Deno.exit(1);
