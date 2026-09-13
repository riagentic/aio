/**
 * @module
 * The words `am agent` prints: ONE page that turns a model that knows nothing
 * about aio into one that can build, run, test, debug and ship an aio app —
 * starting from `am create` — plus deeper sections behind `--task=<slug>`.
 *
 * Why a command and not another page in `docs/`: agents do not browse. Three
 * field reports finished a whole build before discovering `am expect`; one
 * wrote `am state <path> | python3 -c …` about thirty times. An agent greps for
 * its own word and composes primitives it already knows. A command named in
 * `am help`, in the app's own `AGENTS.md` and in the error it just hit is in
 * front of it at the moment it is searching.
 *
 * Shape: the DEFAULT output is the page (`page: true` sections, in order) and
 * must stand on its own — concept, API, commands, the new-app flow, testing,
 * debugging, shipping. `--task=<slug>` prints any one section (page or deep);
 * `--task=all` prints everything. Written as a cheat-sheet: every line carries
 * a fact; `NO:`/`YES:` pairs where people err; code that shows many features.
 *
 * Its first rules exist because agents were measured doing the opposite:
 * killing aio apps by process match (takes down every aio app on the box),
 * opening windows on the user's desktop (steals focus mid-keystroke), and
 * scripting around `am`.
 *
 * A LEAF: it imports nothing, so a gate can read it without the runtime, and
 * `am-cmd-create.ts` scaffolds `AGENTS.md` from the same module.
 *
 * GATED, not trusted (tests/am-agent-*.test.ts): every `am <verb>` exists and
 * every `--flag` shown after it is accepted by THAT verb; every template and
 * target matches the scaffolder; every snippet below type-checks against the
 * repo and the test snippet RUNS; every API name exists on the entry it is
 * listed under; every `cell()` / `aio.run()` / `ui` key is a real key; every
 * call-like identifier is a real export; every `docs/…` path exists. A brief
 * that names something the framework does not have sends the reader to a dead
 * end with full confidence.
 */

/** One section of the brief. `slug` is what `--task=` selects. */
export type BriefSection = {
  readonly slug: string;
  /** One line, for `am agent --list`. */
  readonly title: string;
  readonly body: string;
  /** Part of the default page (`am agent` with no `--task`). Deep sections
   *  print only when asked for. */
  readonly page: boolean;
};

/** A code sample the brief prints. Every one is type-checked against the repo
 *  by the gate, laid out at `path` as a mini-app; `run: true` files are also
 *  executed with `deno test`. */
export type BriefSnippet = {
  readonly path: string;
  readonly code: string;
  readonly run?: boolean;
};

import type { Target, Template } from "./am-help-text.ts";
import { DEFAULT_ENTRY, UI_ENTRY } from "../server/app-files.ts";

/** Indent a snippet under a `// path` header for the page. */
function show(s: BriefSnippet): string {
  return [
    `  // ${s.path}`,
    ...s.code.trimEnd().split("\n").map((l) => "  " + l),
  ]
    .join("\n");
}

// ── snippets (one mini-app, checked + run by the gate) ─────────────────────

const APP_TS: BriefSnippet = {
  path: DEFAULT_ENTRY,
  code:
    `import "./cell.ts"; // a cell registers when imported — unimported = not in the app
import { aio } from "aio";
await aio.run({ ui: { theme: "auto", title: "Notes" }, journal: true });
`,
};

const CELL_TS: BriefSnippet = {
  path: "src/cell.ts",
  code: `import { cell, schedule, self } from "aio";
export type Note = { id: string; text: string; done: boolean; at: number };

export const notes = cell("notes", {             // "notes" = wire + storage identity
  version: 1, onMigrate: (s) => s,                // bump + migrate when the SHAPE changes
  state: { items: [] as Note[], busy: false, token: "" },
  persist: { exclude: ["busy"] },                 // default "all"
  visible: { exclude: ["token"] },                // clients never receive it
  args: { add: [(v) => (typeof v === "string" && v.trim() !== "") || "text required"] },
  concurrency: { refresh: "newest" },             // a new call aborts the running one
  methods: {
    add(s, text: string, id: string, at: number) { // SYNC: atomic draft; id/clock come IN
      s.items.push({ id, text, done: false, at });
    },
    toggle(s, id: string) {
      const n = s.items.find((x) => x.id === id);
      if (!n) throw new Error(\`no note \${id}\`);     // throw = nothing written, await rejects
      n.done = !n.done;
    },
    clearDone(s): number {
      s.items = s.items.filter((x) => !x.done);
      return s.items.length;                        // resolves the caller's await
    },
    later(s) { s.$do(schedule.after("notes:sweep", 60_000, self("clearDone"))); },
    async refresh(s) {                              // ASYNC: server context, may await
      s.busy = true;                                // every await commits: UI shows busy
      const io = await import("./notes.server.ts"); // server-only code = dynamic import
      const text = await io.hostName();
      if (s.$signal.aborted) return;                // superseded by a newer call
      s.items.push({ id: crypto.randomUUID(), text, done: false, at: Date.now() });
      s.busy = false;
    },
  },
  selectors: { open: (s) => s.items.filter((x) => !x.done).length }, // notes.open()
});
`,
};

const NOTES_SERVER_TS: BriefSnippet = {
  path: "src/notes.server.ts",
  code:
    `export const hostName = (): Promise<string> => Promise.resolve(Deno.hostname());
`,
};

const APP_TSX: BriefSnippet = {
  path: "src/App.tsx",
  code: `import type { JSX } from "aio";
import { Link, Route, useLocal, useRoute } from "aio/air";
import { Button, Field, Input } from "aio/ui";
import { notes } from "./cell.ts";

function Detail(): JSX.Element {
  const { params } = useRoute("/note/:id");          // typed params
  return <p class="muted">{notes.items.find((x) => x.id === params.id)?.text ?? "gone"}</p>;
}
export default function App(): JSX.Element {
  const [draft, setDraft] = useLocal("");            // per-mount UI state, never synced
  return (
    <main>
      <h1>Notes ({notes.open()})</h1>                  {/* reading a cell subscribes */}
      <Field label="Note"><Input value={draft} onInput={(v) => setDraft(v)} /></Field>
      <Button variant="primary" disabled={!draft.trim()}
        onClick={() => { notes.add(draft, crypto.randomUUID(), Date.now()); setDraft(""); }}>
        Add
      </Button>
      <ul>{notes.items.map((n) => (
        <li key={n.id}>
          <input type="checkbox" aria-label={\`Done \${n.text}\`} checked={n.done}
            onChange={() => notes.toggle(n.id)} />
          <Link to={\`/note/\${n.id}\`}>{n.text}</Link>
        </li>))}
      </ul>
      <Button t="refresh" disabled={notes.busy} onClick={() => notes.refresh()}>Refresh</Button>
      <Route path="/note/:id" element={<Detail />} />
    </main>
  );
}
`,
};

const TEST_TSX: BriefSnippet = {
  path: "tests/notes.test.tsx",
  run: true,
  code: `import { assertEquals } from "@std/assert";
import { bootCells, testCell, testUI } from "aio/testing";
import { notes } from "../src/cell.ts";
import App from "../src/App.tsx";

testCell(notes, "add, toggle, refuse", async (t) => {
  t.send.add("milk", "n1", 1);                          // a sync write is visible at once
  t.send.toggle("n1");
  t.expect.state((s) => s.items[0]?.done === true);
  await t.expect.rejects(() => t.send.toggle("nope"), /no note/);
  assertEquals(await t.send.clearDone(), 0);            // the method's return value
});

testUI(App, "type, click, check", async (ui) => {
  ui.NoteInput.type("milk");                            // actions queue — no await
  ui.AddButton.click();
  await ui.expectCell(notes, (s) => s.items.length === 1); // observations await
  ui.DoneMilkCheckbox.check();
  await ui.expectCell(notes, (s) => s.items[0]?.done === true);
});

Deno.test("a schedule fires on the virtual clock", async () => {
  await using h = await bootCells([notes]);
  await notes.add("x", "n1", 1);
  await notes.toggle("n1");
  await notes.later();
  await h.advance(60_000);
  assertEquals(notes.items.length, 0);
});
`,
};

const FILES_SERVER_TS: BriefSnippet = {
  path: "src/files.server.ts",
  code:
    `import { serverFns, serverUser } from "aio";          // NOT from "aio/server"
export const files = serverFns("files", {
  list: async (dir: string) => (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name),
  whoami: () => serverUser()?.id ?? "anonymous",
}, { access: true });
`,
};

const FILES_TSX: BriefSnippet = {
  path: "src/Files.tsx",
  code: `import { type JSX, serverFn } from "aio";
import { resource } from "aio/air";
import type { files } from "./files.server.ts";          // type-only: erased from the bundle
const api = serverFn<typeof files>("files");               // typed WS proxy; offline rejects
const listing = resource(() => ".", (dir) => api.list(dir));
export const Files = (): JSX.Element => <ul>{(listing.value ?? []).map((f) => <li key={f}>{f}</li>)}</ul>;
`,
};

const EDGE_TS: BriefSnippet = {
  path: "src/edge.ts",
  code: `import { aio, integer, log, pk, route, table, text } from "aio";
import { notes } from "./cell.ts";
import "./files.server.ts";
await aio.run({
  db: { audit: table({ id: pk(), at: integer(), what: text() }) },   // SQL-only table
  routes: { "/api/note/:id": route((ctx) => ctx.json({ id: ctx.params.id })) },
  schedules: [{ id: "sweep", every: 3_600_000, action: notes.clearDone.action() }],
  auth: true,                          // accounts + sessions at /__aio/auth/*
  redactActions: ["notes:add"],        // payload never reaches journal/timeline
  onStart: async (app) => {
    await app.db!.execute("INSERT INTO audit (at, what) VALUES (?, ?)", [Date.now(), "boot"]);
    const b = await app.blobs!.put(new TextEncoder().encode("hi"), { name: "hi.txt" });
    log.info("edge", app.blobs!.url(b.id));  // /__aio/blobs/<sha256>, Range-capable
  },
});
`,
};

/** Every snippet the brief prints — the gate lays these out as one project. */
// aio-ok: read by the brief's truth gate (tests/am-agent-truth.test.ts), which type-checks and runs every snippet
export const BRIEF_SNIPPETS: readonly BriefSnippet[] = [
  APP_TS,
  CELL_TS,
  NOTES_SERVER_TS,
  APP_TSX,
  TEST_TSX,
  FILES_SERVER_TS,
  FILES_TSX,
  EDGE_TS,
];

// ── API names, per entry (gate: each exists on THAT entry) ─────────────────

/** The public names the brief teaches, grouped by the specifier to import
 *  them from. Rendered in `--task=api`; the gate type-imports every one. */
export const BRIEF_API: readonly { entry: string; names: readonly string[] }[] =
  [
    {
      entry: "aio",
      names: [
        "aio",
        "cell",
        "schedule",
        "self",
        "own",
        "blocking",
        "notify",
        "until",
        "race",
        "sleep",
        "call",
        "errorCode",
        "serverFns",
        "serverFn",
        "serverUser",
        "serverRequest",
        "serverAuth",
        "route",
        "table",
        "pk",
        "text",
        "integer",
        "real",
        "ref",
        "createSelector",
        "authClient",
        "definePlugin",
        "isCellWorker",
        "serverImport",
        "log",
        "bytes",
        "dur",
        "count",
        "generateTotpSecret",
        "totpUri",
        "verifyTotp",
        "VERSION",
        "JSX",
        "AioApp",
        "CellsConfig",
        "MethodDraftMeta",
        "MethodDraftCalls",
        "CellEffect",
        "StateOf",
        "AioUser",
        "Access",
      ],
    },
    {
      entry: "aio/air",
      names: [
        "signal",
        "computed",
        "effect",
        "batch",
        "untrack",
        "watch",
        "on",
        "trackedMemo",
        "useLocal",
        "useSignal",
        "useRef",
        "useId",
        "createContext",
        "useContext",
        "useResource",
        "resource",
        "onChange",
        "useHead",
        "useDimensions",
        "useRaf",
        "useInterval",
        "useOptimistic",
        "useVirtualList",
        "useConnected",
        "useAio",
        "useProjection",
        "onMount",
        "onCleanup",
        "afterRender",
        "onWindowEvent",
        "onGlobalKey",
        "Show",
        "lazy",
        "Defer",
        "ErrorBoundary",
        "Suspense",
        "Portal",
        "h",
        "Fragment",
        "Route",
        "Outlet",
        "Link",
        "NavLink",
        "Redirect",
        "navigate",
        "useNavigate",
        "useRoute",
        "page",
        "useForm",
        "useFieldArray",
        "SignIn",
        "signOut",
        "useUser",
        "Transition",
        "TransitionGroup",
        "useSpring",
        "renderToString",
        "hydrate",
        "mount",
        "island",
        "reactIsland",
      ],
    },
    {
      entry: "aio/ui",
      names: [
        "Button",
        "Input",
        "Textarea",
        "Select",
        "Checkbox",
        "RadioGroup",
        "Switch",
        "Field",
        "Card",
        "Stack",
        "Row",
        "Tabs",
        "Breadcrumb",
        "Table",
        "Pagination",
        "Markdown",
        "Avatar",
        "Alert",
        "Progress",
        "Spinner",
        "Skeleton",
        "EmptyState",
        "Tooltip",
        "toast",
        "ToastHost",
        "Modal",
        "Confirm",
        "ConfirmButton",
        "Menu",
        "Browser",
        "UiStyles",
        "css",
        "cx",
      ],
    },
    {
      entry: "aio/testing",
      names: [
        "testCell",
        "testUI",
        "bootCells",
        "testServer",
        "testMultiClient",
        "testApps",
        "testBrowser",
        "freePort",
        "openCassette",
        "smoke",
        "totpCode",
        "TestUI",
        "TestContext",
      ],
    },
    {
      entry: "aio/server",
      names: [
        "createDB",
        "connectCli",
        "openBlobStore",
        "reactiveDB",
        "appDirs",
        "openExternal",
        "pickFile",
        "pickDirectory",
        "spawn",
      ],
    },
    { entry: "aio/sync", names: ["MergeStrategy", "SyncConfig"] },
    { entry: "aio/extras", names: ["instances", "resolveAppId", "checkCells"] },
    {
      entry: "aio/cli",
      names: ["args", "table", "watch", "fail", "style", "EXIT"],
    },
  ];

// ── structured facts (rendered below; the gate checks each against source) ─

/** What each `am create --template=` gives. Typed by the scaffolder's own
 *  union, so a template added there is a compile error here until described. */
export const BRIEF_TEMPLATES: Readonly<Record<Template, string>> = {
  counter: "(default) one cell + a counter UI",
  todo: "a list + a client-scoped view cell + an input form",
  cli: "one binary: `serve` + commands on aio/cli; no UI; target cli",
  canvas: "a 2D loop whose decisions are pure functions tested without a GPU",
  assets: "an `assets` mount (aio.run AND deno.json) + a media/ directory",
};

/** What each `am create --target=` needs — same exhaustiveness as above. */
export const BRIEF_TARGETS: Readonly<Record<Target, string>> = {
  browser: "(default) no toolchain",
  electron: "auto-installs Electron",
  android: "Android SDK + Java 17 + gradle",
  cli: "headless binary",
  server: "headless server + systemd unit",
};

/** Every `cell()` option. `keys` are real `MethodsCellConfig` keys — the gate
 *  type-checks them AND fails when a key exists that no row covers. */
export const BRIEF_CELL_OPTIONS: readonly {
  keys: readonly string[];
  text: string;
}[] = [
  {
    keys: ["state"],
    text: "initial = declared shape; JSON data only (no Date/Map/Set/class/fn)",
  },
  {
    keys: ["methods"],
    text:
      "sync (s, …args) → Immer draft · async (s, …args) → live proxy (below)",
  },
  {
    keys: ["selectors"],
    text:
      '{ total: (s) => n, byId: (s, id) => row, x: { deps: ["other"], fn: (s, [o]) => … } }\n' +
      "→ notes.total(), notes.byId(3); reactive when read in a component",
  },
  {
    keys: ["persist"],
    text:
      '"all" (default) | "none" | { include: [top-level] } | { exclude: ["a", "a.b"] }',
  },
  {
    keys: ["visible"],
    text:
      'READ side: "all" (default) | "none" | { include | exclude, forUser: (s, u) => view,\n' +
      "publicFields: [...] } — hidden fields never reach clients; reading one there THROWS",
  },
  {
    keys: ["access"],
    text:
      'CALL side: true (any authed user) | "role" | (user, method, ...args) => bool\n' +
      'absent = open; server-origin calls bypass; denied → errorCode(e) === "ACCESS_DENIED"',
  },
  {
    keys: ["args"],
    text:
      '{ m: [schema | (v) => true | "reason", null] } positional; Standard Schema (zod…)\n' +
      "coerces; guards am dispatch, forms, agents",
  },
  {
    keys: ["validate"],
    text: '(s) => true | "reason" after every reduce; refusal → ACTION_REFUSED',
  },
  {
    keys: ["scope"],
    text:
      '"client": per-tab, browser-only, never synced/persisted, sync methods only',
  },
  {
    keys: ["cancelOn"],
    text:
      '{ m: "self" | [other.method, "cell:type"] } → s.$signal aborts the running call',
  },
  {
    keys: ["concurrency"],
    text:
      '{ m: "newest" | "first" (2nd caller adopts result) | "queue" } — async only',
  },
  {
    keys: ["ttl"],
    text: "{ m: ms } identical successful async call answered from cache",
  },
  {
    keys: ["long"],
    text:
      '["m"] no call ceiling (effectTimeoutMs 30s: caller rejects, method runs on)',
  },
  {
    keys: ["transaction"],
    text:
      'true | { serialize, conflict: "abort" | "warn" } async reads a pinned snapshot,\n' +
      "commits atomically; s.$commit() publishes mid-method, s.$live reads current",
  },
  {
    keys: ["listensTo"],
    text:
      "{ onPaid: payment.charge | [a.m, b.m] } — a SYNC method runs on a foreign action",
  },
  {
    keys: ["sync"],
    text:
      'true | { merge: { f: "lww"|"counter"|"lww-per-key"|"set-add"|"set-remove"|"text" },\n' +
      'identity: { arr: "id" }, offline: { retention: "4h" } } → DATA',
  },
  {
    keys: ["worker"],
    text:
      "true: methods on their own Deno thread (not with sync/scope/listensTo/selectors)",
  },
  {
    keys: ["version", "onMigrate"],
    text:
      "N + onMigrate: (s, fromVersion) => s on any shape change (am migrations shows drift)",
  },
  {
    keys: ["onRestore", "onPersist"],
    text:
      "(s) => void | s every boot · onPersist: (s) => stored shape (reshape = both hooks)",
  },
  {
    keys: ["onInit", "onDestroy"],
    text:
      "(app, init) => … (app.dispatch/getState/getFullState) · onDestroy: (app) => …",
  },
  {
    keys: ["diagnostics"],
    text:
      "false: keep this cell's actions out of logs/actions.jsonl + am timeline",
  },
];

/** Every `aio.run()` key, grouped. Leading identifier = a real `CellsConfig`
 *  key (the rest of an entry is annotation); the gate checks both directions. */
export const BRIEF_RUN_KEYS: readonly {
  group: string;
  keys: readonly string[];
}[] = [
  {
    group: "core",
    keys: [
      "cells (default: every imported cell)",
      "appId",
      "port (free by default; --port > AIO_PORT > port)",
      "host",
      "expose",
      "tls",
      'client ("electron"|"browser"|"cli"|"server-only")',
      "singleton",
      "takeover",
      "keepServer",
      "serverUrl",
      'transport ("uds"|"ws"|"auto")',
      "localFirst",
      "cellDefaults { visible, persist }",
      "isolate",
      "strictCells",
      "plugins",
      'watch (false | ["src/ui"])',
      "baseDir",
      "libraryMode",
      "appFlags",
    ],
  },
  {
    group: "auth",
    keys: [
      "key",
      "users",
      "resolveUser",
      "sessions",
      "auth",
      "allowedOrigins",
      "strictOrigin",
      "trustProxyHeader",
      "security",
      "wsLimits",
      "maxConnections",
      "childWindows",
    ],
  },
  { group: "ui", keys: ["ui (below)"] },
  {
    group: "serving",
    keys: [
      "routes",
      "assets",
      "serveDirs (dev-only module roots)",
      "schedules",
    ],
  },
  {
    group: "data",
    keys: [
      "persist",
      "persistKey",
      "persistDebounceMs",
      "persistMode",
      "appDir",
      "dbPath",
      "dbPragmas",
      "db",
      "checkIntegrityOnBoot",
      "journal",
      "redactActions",
      "onRestore",
      "onCheckpointRestore",
    ],
  },
  {
    group: "limits",
    keys: [
      "budgets { cellState, broadcastRate, payload }",
      "perfBudget (times)",
      "perfCheck",
      "renderBudget",
      "effectTimeoutMs",
      "syncIntervalMs",
      "fullStateThreshold",
      "freezeState",
      "dispatchStorm",
      "guardDispatches",
      "refusalsReject",
      "memory",
      "circuitBreaker",
    ],
  },
  {
    group: "hooks",
    keys: [
      "onStart (app) — cells bound",
      "onStopping (quiesce producers; may dispatch)",
      "onStop (awaited; must not dispatch)",
      "onError",
      "beforeReduce (action, state, user) => action | null",
      "onAction",
      "onEffect",
      "onConnect",
      "onDisconnect",
      "fatalOnStart",
    ],
  },
  { group: "ship", keys: ["updates", "feedback", "logging", "diagnostics"] },
];

/** Every `ui: { … }` key — real `UiConfig` keys, both directions gated. */
export const BRIEF_UI_KEYS: readonly string[] = [
  "title",
  "width",
  "height",
  `entry ("${UI_ENTRY}")`,
  "theme",
  "chrome",
  "head",
  "lang",
  "dir",
  "viewport",
  "layout",
  "tray",
  "showStatus",
];

/** `items` joined with " · ", wrapped to `width`, continuation lines indented
 *  to `indent`. Pure. */
function wrap(first: string, items: readonly string[], indent: number): string {
  const lines: string[] = [];
  let cur = first;
  for (const [i, item] of items.entries()) {
    const piece = (i === 0 ? "" : " · ") + item;
    if (cur.length + piece.length > 100 && cur.trim() !== "") {
      lines.push(cur.trimEnd() + (i === 0 ? "" : " ·"));
      cur = " ".repeat(indent) + item;
    } else cur += piece;
  }
  lines.push(cur);
  return lines.join("\n");
}

function renderCellOptions(): string {
  return BRIEF_CELL_OPTIONS.map((o) => {
    const label = o.keys[0]!;
    const [head, ...rest] = o.text.split("\n");
    const pad = label.length < 13 ? label.padEnd(13) : label + " ";
    return [`  ${pad}${head}`, ...rest.map((r) => " ".repeat(15) + r)].join(
      "\n",
    );
  }).join("\n");
}

function renderRunKeys(): string {
  return BRIEF_RUN_KEYS.map((g) =>
    g.group === "ui"
      ? wrap(`  ui        ui: { `, [
        ...BRIEF_UI_KEYS.slice(0, -1),
        BRIEF_UI_KEYS.at(-1) + " }",
      ], 12)
      : wrap(`  ${g.group.padEnd(10)}`, g.keys, 12)
  ).join("\n");
}

// ── the page ────────────────────────────────────────────────────────────────

/** First on purpose: a model that reads only the top still gets these. */
const RULES =
  `RULES — four that protect the human (break one = damage outside your task)
1 NEVER kill by process match. NO: pkill -f app.ts · killall deno · kill $(pgrep -f deno) — matches
  EVERY aio app on the machine. YES: am stop · am stop --app=<id> · am stop --all (this project
  only) · am kill --stale (orphans) · am instances first. am stop fails? report it; never escalate.
2 NEVER take over the screen. No window/tab unless pixels are needed: am start --client=server-only;
  read UI with am surface (no window). am start already contains windows (nested X display) and
  suppresses tabs when no human is on the terminal — don't undo it, don't launch around am.
  Human wants it back: am start --display=current.
3 NEVER script around am. python/jq/curl/bash loops against an app = a worse copy of a verb.
  Assert: am expect. Watch: am state <path> --watch. Every command takes --json (auto when piped).
4 LEARN BEFORE EDITING. aio is not React/Express/Next: a cell is not a store, a method is not a
  handler. Guessed code type-checks, boots, and is wrong. Read this page; ask am, not the source.`;

const MODEL = `MODEL — one cell drives everything
cell(name, { state, methods }) = server state + SQLite persistence (~/.<appId>/data/state.db)
  + WS broadcast of deltas + optional CRDT sync + the reactive UI. Elm-shaped: (state, action) →
  { state, effects }. Full-stack TypeScript on Deno ≥2.9; one codebase → browser, Electron,
  Android, CLI, server binaries.
call flow: UI calls notes.add("x") → WS → server runs the method on an Immer draft → commit
  (frozen) → persist (100ms debounce) → delta to every client → components that READ notes
  re-render → effects run. The call IS the dispatch; await resolves on apply (browser: on ack).
two files of decisions: src/cell.ts (state + methods) and src/App.tsx (reads cells, calls methods).
  Defaults for the rest: icon + accent hue from the appId, window chrome, a free port, data dir.
NO: fetch/REST between your UI and your server · stores/reducers/action files · useEffect to load
  · useState for shared data · setTimeout to chain actions · mutating state outside a method.
YES: methods are the ONLY writes · components read cells directly · effects via s.$do · server
  I/O in async methods or *.server.ts · routes/serverFns only for true edges (webhooks, uploads).
am state = SERVER truth (raw). am surface = what the CLIENT renders. Different questions.`;

const NEW =
  `BUILD A NEW APP — step by step (the path that works; each step verified)
0 check     deno --version (≥2.9) · am version · no am? curl -fsSL
            https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
1 create    am create <name> [--template=T] [--target=X] [--css=tailwind]   → ./<name> (cd first;
            no --dir). Pins the newest release (deno.json "aioVersion", dep/aio symlink, git init).
            --aio-version=<tag|main> pick a version · --mirror[=<path>] live aio checkout (framework
            dev) · --jsr JSR imports · --force non-empty dir
${
    wrap(
      "  templates ",
      Object.entries(BRIEF_TEMPLATES).map(([k, v]) => `${k} ${v}`),
      12,
    )
  }
${
    wrap(
      "  targets   ",
      Object.entries(BRIEF_TARGETS).map(([k, v]) => `${k} ${v}`),
      12,
    )
  }
            (--target only picks the DEFAULT for dev/compile; every target stays one flag away)
2 layout    deno.json   title, version "0.1" (major.minor only), client, build{targets,platforms,out},
                        imports (every aio/* entry), tasks, aioVersion
            src/app.ts  entry = wiring: import "./cell.ts"; await aio.run({ ui: { theme: "auto" } })
                        its DIRECTORY is the app root (App.tsx, style.css, icon.png resolve there)
            src/cell.ts the cell; once there are 2+: src/cell/<name>.ts (singular folder)
            src/App.tsx root component (default export) · src/client.ts thin CLI client
            tests/cell.test.ts testCell starter · AGENTS.md → am agent · CLAUDE.md → @AGENTS.md · dep/aio
3 tasks     deno task test | check (deno check + am check) | lint (deno lint + aiol) | fmt | doctor
            (config + pin sanity) | dev (FOREGROUND) | compile (default target) | build (all
            build.targets) | publish | ship | am
4 verify    cd <name> && deno task test && deno task check && deno task lint
5 run       am start --client=server-only   (daemon; waits for health; survives your shell)
            am status (0 up · 1 down · 2 transitional) · am instances (port, dataDir, stopWith)
            NO: deno task dev from a tool shell — it dies with the shell.
6 state     edit src/cell.ts (CELL section). Another cell: am add cell <n> → src/cell/<n>.ts, then
            IMPORT it (app.ts or a component). Server-only module: am add server <n> →
            src/server/<n>.server.ts + import wired into app.ts (serverFns come from "aio").
7 ui        edit src/App.tsx, split into src/ui/*.tsx; kit from aio/ui; give every control a name
            (aria-label / t="x") — testUI and am trigger address it by that name.
8 observe   save → dev reloads (cell/entry change = server restart, persisted state kept)
            am logs --level=warn · am errors · am state notes · am dispatch notes:add milk n1 1
            am expect notes.items[0].text eq milk · am timeline --lines=10 · am surface
9 test      tests/<area>.test.ts(x): testCell for EVERY method, testUI for every user flow → TEST
10 gates    deno task check && deno task lint && deno task test && deno task fmt
11 ship      deno task compile → dist/<name>-0.1.<commits>[-dirty.<hash>] + dist/manifest.json → SHIP
12 stop      am stop
DONE = every method dispatch-tested · each user flow in testUI · check+lint+test green · am logs
  --level=warn and am errors clean · secrets behind visible · state small (rows→db, bytes→blobs)
  · deno task compile builds · the artifact boots (run it, am status) · am stop.
${show(APP_TS)}`;

const CELL =
  `CELL — cell(name, { …options }); name = wire + storage identity (rename = fresh state)
${show(CELL_TS)}
${show(NOTES_SERVER_TS)}
options (unknown key throws with the nearest spelling)
${renderCellOptions()}
methods
  sync   one atomic commit · throw → nothing written, await rejects · return → await value (JSON over
         the wire) · NO await/I/O/timers/Date.now/random (under sync/localFirst it replays in browser)
  async  every await COMMITS what was written (partial state visible) · writes before a throw are
         KEPT · re-read s after await (a ref held across an overwrite throws "stale reference") ·
         writes from callbacks that outlive the method are refused · Deno.* allowed
  draft  s.$do(schedule.*|own.*|notify({ title })) effects — never return them · s.$call.m(…) sibling
         on the same draft/commit · s.$signal AbortSignal · typed: s: State & MethodDraftMeta for
         $do; for $call s: State & Partial<MethodDraftCalls<Calls>> then s.$call!.m(…)
  types  state is a \`type\` alias, NOT an \`interface\` (no index signature → TS2322 + unknown fields)
  handle notes.m(…) → Promise (throws if called before aio.run) · notes.m.type "notes:m" ·
         notes.m.action(…) descriptor for schedules · self("m") same, inside its own cell ·
         notes.$pending("m") reactive in-flight count (spinners; not state)
  helpers until(() => pred, { timeoutMs }) · race({ ok: p, timeout: 30_000 }) → { winner, value } ·
         sleep(ms) · call({ timeoutMs, retries }, () => other.m()) · blocking(id, fn, arg) runs a
         self-contained fn on a worker thread (blocking.cancel(id)) · errorCode(e)
schedule (via s.$do; same id REPLACES; ids /^[\\w\\-:.]+$/; testable with bootCells + advance)
  schedule.after(id, ms, action) · .every(id, ms, action, { skipIfRunning }) · .at(id, isoTime, action)
  · .cron(id, "0 8 * * 1-5", action) · .backoff(id, attempt, action, { base, max }) · .poll(id,
  attempt, action, { every, factor, max }) · .next(id, action) · .cancel(id)
  static: aio.run({ schedules: [{ id, every | after | at | cron, action: cell.m.action() }] })
  own.set("cell:res", () => disposer) / own.dispose("cell:res") — watchers, sockets, subprocesses
patterns
  network I/O   fetch in an async method or outside, commit through a SYNC reducer (cell.setX(v))
  boot work     aio.run({ onStart: () => cell.scan() }) · onInit(app) app.dispatch · schedules
  status guard  if (s.status !== "idle") return;   (a "dead" method is often its guard)
  heavy CPU     blocking() or worker: true · streams/progress/cursors → docs/state/real-time.md
  mutate, don't replace: s.list.push(x) ships one patch; s.list = [...s.list, x] ships the list`;

const UI = `UI — AIR: signals + JSX (jsxImportSource "aio"), NOT React
${show(APP_TSX)}
render model  a component re-runs when a cell/signal it READ during render changes (per cell).
  Reads subscribe ONLY in the body / computed / effect — NOT in handlers, onMount, timers, after
  await. State right + DOM stale = a deferred read.
local state   const [v, setV] = useLocal(init) (or useSignal). NO: signal() in a body (resets every
  render). YES: useLocal/useSignal, or signal() at module scope; sig.update(fn) (sig.set(fn) is no
  updater); .peek() reads untracked.
JSX           class="a b" (string) · className={{ on: cond }} or class={cx("a", on && "b")} ·
  onChange on input/textarea/select fires per keystroke · handled <form onSubmit> auto-prevents
  default (data-native-submit opts out) · style={{ fontSize: 14 }} · key on lists · ref callback or
  useRef · aria-x={false} removes the attribute · t="name" = handle for testUI + am surface (stripped)
hooks (aio/air) useLocal useSignal useRef useId createContext/useContext resource/useResource
  onChange watch computed effect batch untrack trackedMemo useHead({ title }) useDimensions useRaf
  useInterval useOptimistic useVirtualList useConnected useUser onMount onCleanup afterRender
  onWindowEvent onGlobalKey("ctrl+k", fn) — hooks in call order, never behind an if
components    <Show when={x} fallback={…}>{(v) => …}</Show> · lazy(() => import("./X.tsx")) ·
  <Defer trigger="viewport" load={…}> · <Transition> · ErrorBoundary/Suspense/Portal are symbols:
  NO: <ErrorBoundary> (TS2604) YES: h(ErrorBoundary, { fallback: (e: Error) => <p>{e.message}</p> }, <Kid/>)
router        <Route path="/u/:id" element={<U />} /> — EVERY match renders (no Switch); nest + <Outlet />,
  <Route index …> · const { params, matched, search } = useRoute("/u/:id") · <Link to> / <NavLink to>
  (active class) · navigate("/x", { replace: true }) / navigate(-1) · <Redirect to="/login" />
  NO: <Route path="*"> for 404 (shows everywhere) YES: a component that checks matched
forms         useForm({ email: { initial: "", rules: [(v) => v ? null : "required"] } }) →
  form.fields.email.value/.error, {...form.bind("email")} on native inputs, form.validate(), form.values()
kit (aio/ui)  Button Input Textarea Select Checkbox RadioGroup Switch Field Card Stack Row Tabs
  Breadcrumb Table Pagination Markdown Avatar Alert Progress Spinner Skeleton EmptyState Tooltip
  toast(+<ToastHost />) Modal Confirm ConfirmButton Menu Browser · handlers get the VALUE:
  <Input onInput={(v) => …}> · <Field label="Email"> names its control (ui.EmailInput) · css\`\` cx
style         ui.theme: "tokens" (default: --aio-* vars only) | "auto" (full look until src/style.css
  exists) | "full" (look + your CSS) | "none" · all aio CSS in @layer aio → your CSS always wins ·
  classes .card .row .stack .grid .badge .muted; buttons .primary .ghost .danger · app mounts into
  #root · am theme adopt → own copy · --css=tailwind · ui.chrome (Electron): "standard"|"themed"|"none"
where it runs component body + handlers = CLIENT (no Deno.*, hidden fields throw) · async method,
  *.server.ts, worker cell = SERVER · sync method = server (+ browser replay under sync/localFirst)
  · *.server.ts only via await import() or import type (a static import is refused at boot/build)
  · am where <file> answers with the import chain · am check proves the client bundle builds
names (testUI + am surface/trigger)  t="x" > data-testid > LABEL+ROLE: label = aria-label > own
  direct text > wrapping <label> > placeholder > name; role Button/Input/Checkbox/Link/Item/Row/Form…
  NO: <button><span>Save</span></button> (nested text not read → "Button") YES: aria-label or t= ·
  duplicates → Save2 · copy edits rename → pin stable handles with t=
pixels (screenshots, geometry, Electron frame) → am agent --task=windows`;

const DATA = `DATA — persistence tiers, privacy, auth, sync, server edge
${show(EDGE_TS)}
${show(FILES_SERVER_TS)}
${show(FILES_TSX)}
tiers  state   ≤ ~1MB per cell (warn >1MB, error >16MB; tune budgets: { cellState: "1MB" })
       rows    db: { "cell.field": table({ id: pk(), name: text(), n: integer({ default: 0 }) }) } (aio.run)
               binds a state array ↔ SQL table, diff-synced by pk (a key naming a field binds it; one
               naming none = SQL-only table); row values: string/number/null only (Date/object/bool
               throw). Query: app.db!.query<T>(sql, params) → { rows } · execute · transaction(async tx)
       bytes   app.blobs!.put(u8 | stream, { name }) → { id } · .stream(id) · .url(id) · .delete(id)
       jobs    heavy work in *.server.ts / blocking(); state holds only progress + result summary
persist everything persists by default; 100ms debounce → journal: true replays that window
       after a crash · shape change → version + onMigrate · appId comes from deno.json
       appId/title/dir — pin "appId" before data matters · files: ~/.<appId>/data/{state.db,
       auth.db, journal, files/blobs}, logs/, cache/ · AIO_APPS_DIR=<root> relocates all apps
privacy visible gates READS, access gates CALLS, redactActions hides payloads. Boot refuses: a
       visible secret-looking field (password, apiKey, privateKey, accessToken…; prod warns) ·
       sync + any visible filter · access without visible on an exposed/multi-user app.
auth   loopback = open · --expose (0.0.0.0 + TLS) with no auth → generated key + pairing PIN (am
       pair) · key: "fixed" | true | false · users: { "<token>": { id, role } } · resolveUser:
       (token, state) => user | null · auth: true → login/signup/sessions/TOTP/OIDC at /__aio/auth/*
       with <SignIn /> useUser() signOut() (aio/air), authClient (aio), am auth users|create|role…
       server code: serverUser() serverRequest() serverAuth() → --task=auth
sync   sync: true → CRDT ops: sync methods run optimistically in the browser, the server converges;
       ops survive reload offline. NO: crypto.randomUUID()/Date.now()/Math.random() inside a sync
       method ("not deterministic") YES: pass them as arguments. No persist/visible filters on a
       sync cell; set-add/set-remove items need an id. aio.run({ localFirst: true }) = every cell
       syncs (opt out: sync: false) → --task=sync
edge   routes: { "/x/:id": route((ctx) => ctx.json(…)) } (raw HTTP: webhooks, uploads) · assets:
       { "/media": "./media" } in aio.run AND deno.json (to embed) · serverFns/serverFn (above) ·
       notify({ title }) via s.$do · updates: "<channel url>" · feedback: true · plugins:
       [definePlugin({ … })] · connectCli(url) (aio/server) for a remote CLI client
workers worker: true on a cell (own thread; args/returns structured-cloneable; no peer reads) ·
       isCellWorker() guards boot work in the entry · blocking(id, fn, arg) for one-off CPU`;

const TEST = `TEST — in-process, dev-strict, no selectors
${show(TEST_TSX)}
testCell(cell, "name", async (t) => …)  raw server state, no DOM, no clock
  t.send.m(…) (sync write visible at once; await → return value) · t.expect.state(pred, msg?) ·
  await t.expect.rejects(() => t.send.m(), /reason/) · t.expect.effects(["cell:m"]) ·
  t.getEffects() · t.init({ …seed }) · t.as(user, fn) · t.fuzz({ n }) · await t.settle()
  NO: schedule/own effects fire here ("no clock") YES: assert them emitted, or bootCells + advance
testUI(App, "name", async (ui) => …) · await using ui = await testUI(App, { seed, user })
  actions (queued, no await): click dblclick type (appends) setValue (replaces) press "Enter"
  keyDown keyUp hover focus blur select "value" check uncheck clear scroll dragTo
  observe (await): ui.expectCell(cell, pred) · ui.waitFor(pred) · ui.settle() · ui.advance(ms)
  read after observing: .text .value .checked .disabled · ui.find("Row", key) · ui.present(name) /
  ui.absent(name) · ui.serverState() (unfiltered) · ui.surface() · a miss lists the real names
  what a user cannot do fails loud: disabled/hidden/readonly controls, .check() on a button, …
more   bootCells([cells], { stub }) → h.advance(ms), h.settle() (real scheduler, virtual clock) ·
       testServer({ cells, routes }) real HTTP/WS on freePort() · testMultiClient(cfg, n) real wire
       calls (JSON args/returns, access) · openCassette(path) record/replay external calls ·
       testBrowser(url) headless Chromium · serverImport("./x.server.ts", import.meta.url) + stub
from an app  am testgen → tests/ui.gen.ts (typed names) · am record tests/x.test.ts turns what the
       RUNNING app dispatched (its timeline) into a bootCells test; a stopped app: its crash journal
       · am expect for shell e2e
rules  harness = strictest env (frozen state, access enforced, unobserved rejections fail, temp data
       dirs) · cells + module signals reset per test · dispatch-test EVERY method (SSR or a curl of
       initial state proves nothing) · wire behaviour (Date→string, Map→{}) needs testMultiClient ·
       tests live in tests/ · bug → failing test first → fix → green`;

const TASKS =
  `AM — every verb (--json on all; auto when piped; errors exit non-zero)
process  am start [component] --client=server-only|browser|electron --port=N --cdp --no-wait
           --wait=N --display=isolated|current --env-file=.env   supervised daemon, waits for health
         am stop [--all] · am restart · am kill [--stale] · am status · am instances [--long] ·
         am watch · am dev (= deno task dev, foreground) · am open [--print]
state    am state [path] [--watch]   path: a.b[0] · a[*].x · a.{x,y} · raw server state (--ui = client view)
         am expect <path> eq|ne|gt|gte|lt|lte|contains|exists|absent [value] [--wait=N]   exit 1 on fail
         am dispatch notes:add milk n1 1 · am dispatch notes:add --args='["milk","n1",1]' (JSON-exact)
           · am dispatch conn:configure host=h port=8000 (one object arg) · --as-server (past access)
         am actions [--lines=N] · am timetravel undo|redo|goto <id>|pause|resume
         am timeline [--lines=N] [--from=J]   dispatches + payloads + state diffs
         am replay N..M [--dry] [--from=J] · am record tests/x.test.ts [--from=J]   (live timeline)
         am snapshot [save F | load F [--force]] · am persist (flush; ok = on disk) · am migrations
data     am data (paths) · am backup [dest] [--force] · am restore <dir> · am sql "select …" ·
         am tables · am schedules
ui       am surface [idx|server] [--component=X] [--path=App/Main] [--depth=N] [--full] [--rects]
           no live client → headless server render; a miss lists real paths
         am trigger [idx] "App:AddButton" click|dblclick|type|setValue|press|keyDown|keyUp|hover|
           focus|blur|select|check|uncheck|clear|scroll|dragTo [text]   reply includes fresh surface
         am preview src/ui/Card.tsx --export=Card --props='{"title":"x"}'   path as your shell completes it
         am clients · am client <idx> (component tree) · am eval '<js>' [--window=N]
         am shot [--out=F] [--full] [--selector=css] [--update=B] [--check=B]   (shot/eval: am start --cdp)
inspect  am logs [substr] [--level=warn] [--tag=cell:notes] [--since=15m] [--lines=N] [--follow]
         am errors [--lines=N] · am health · am metrics · am heap · am top · am config
         am cost [--keys] [--cell=X] [--window=5m] · am doctor (running app vs aio on disk)
         am check (client bundle builds?) · am where <file> · am migrate [--from=X] (retired spellings)
         am testgen [entry] [--out=F]
project  am create <name> · am add cell <n> · am add server <n> · am build [targets…] [--list] ·
         am compile [target] · am publish [--channel=C] [--notes=…] · am pin [<v>|latest|main] ·
         am fix (repair a clone) · am link · am theme adopt [--force] · am upgrade · am feedback
         [app] [--create] · am report · am agent [--task=<slug>] [--list]
net/auth am auth users|create <id> --role=admin|passwd|unlock|totp <id> off|role|verify|revoke|rm ·
         am pair · am profile [--out=F] · am trust · am discover [--timeout=ms]
global   --app=<id> --port=N --home=<dir> --instance=<name> (private copy: own lock/data/logs)
         --quiet --timeout=ms --wait[=N] · \`--\` ends am's flags · am help <verb> = full detail`;

const DEBUG = `DEBUG — playbook, then the pitfalls that cost the most
1 read the error: aio names the cause and the fix ("did you forget it in aio.run({ cells })?")
2 am errors (build error first) · am logs --level=warn (browser/renderer errors land here too)
3 am check (bundle) · am where <file> (context) · deno task doctor (config, pin)
4 am timeline --lines=20 (what ran, payloads, diffs) · am state / am expect (server truth)
5 am surface (what the UI shows) · am trigger → reply carries the new surface
6 am doctor (running app older than the code? → am restart) · am health · am heap · am cost
7 repro: am timeline → am record tests/x.test.ts (or a hand-written red testCell/testUI) → fix → green
NO: widen a type, delete an assertion, try/catch-swallow, sleep-and-retry, pkill. FAIL LOUD.
symptom                               → cause                               → fix
feature dead, tests green             → cell never imported / not in cells  → import it; heed warning
click does nothing                    → guard line or unawaited rejection    → am timeline; am logs
blank page / import refused           → static import of *.server.ts/Deno/@std in client graph
                                                                             → await import(); am check
TypeError: read only / only a getter  → state mutated outside a method      → call a method; useLocal
UI stale, state right                 → read in handler/onMount/after await → read in the body
value resets every click              → signal() created in a component body → useLocal/useSignal
async method writes wrong data        → ref held across await/overwrite     → re-read s after await
"stopped waiting after 30000ms"       → call ceiling                        → long: ["m"] / sync reducer
"not deterministic"                   → random/clock in a sync(ed) method   → pass as arguments
boot refused: SECURITY                → secret field visible; sync+visible  → visible.exclude / split
boot exits with a key table           → unknown aio.run/cell key (typo)     → the listed spelling
fresh/empty state after rename        → appId or cell name changed          → pin appId; onMigrate
field back to default after restart   → shape change w/o version; row field without a column
                                                                             → version+onMigrate; column
testUI/am: no "XButton"               → nested text / copy change / dup     → aria-label or t="x"
testCell: "no clock"                  → schedule effect in testCell         → bootCells + h.advance
green in-process, wrong in browser    → JSON over the wire (Date→string)    → JSON-safe; testMultiClient
am: "does not know which app"         → wrong cwd / not running             → cd app; --app; am instances
old numbers from am state             → orphan still serving                → am kill --stale
app vanished                          → started with deno task dev          → am start
am record: "no journal"               → app not running, journal off        → am start, reproduce, record
"does not provide an export"          → server value from the wrong entry   → serverFns/serverFn: "aio";
                                                                               createDB/connectCli: aio/server
more rows + error codes: am agent --task=pitfalls · --task=errors`;

const SHIP = `SHIP — build targets, versions, releases
targets (deno.json build.targets; am build --list)
  browser     binary serving the page       electron   AppImage (Linux) / zip (win, mac)
  server      headless binary + systemd unit server-app server + its UI + unit
  cli         headless binary               android    APK (ANDROID_HOME + Java 17 + gradle)
  cli-client / electron-client / android-client / ios-client  thin clients → build.server "host:port"
platforms   "host" (default) linux linux-arm64 windows macos macos-arm64 — server/browser/cli
            cross-compile; electron/android package on their own OS (skipped with a reason)
commands    deno task compile (the default "client" target) · deno task build [--targets=a,b]
            [--platforms=linux,windows] [--release] [--list] · am build electron android
artifacts   dist/<name>-<M.m.build>[-dirty.<hash8>] + dist/manifest.json · <binary> --version
version     deno.json "version": "M.m" ONLY; build = git commit count; uncommitted → -dirty (commit
            before a release) · AIO_BUILD_VERSION overrides
release     deno task ship keygen (once; key lives outside the repo) → am publish [--channel=C]
            [--notes=…] (build + sign → release/<channel>/<os>-<arch>.json; --dir=D) → host that dir → app:
            aio.run({ updates: "<channel base url>" }) · deno task ship github → CI workflow
prod facts  a binary is prod: no control API (am state/dispatch/surface need dev; am status/health/
            logs work) · same data dir as dev · --expose → LAN + TLS + key/PIN · run the artifact
            from another cwd before calling it done
dev flags   deno task dev --client=electron|browser|cli|server-only --expose --port=N --cdp --open
            --watch=false --prod · unknown flags are refused (Deno flags like --env-file: am start)`;

const PRACTICE = `PRACTICE — how an expert writes aio
- Framework over plumbing: state in cells, UI reads cells, methods are the only writes. A fetch
  handler, store, or sync loop between your own UI and server is fighting aio.
- Small serializable state; derive with selectors; rows → db; bytes → blobs; per-tab UI → useLocal.
- Sync methods pure (no I/O, clock, random); I/O in async methods or *.server.ts; effects via s.$do.
- Declare privacy before exposure: visible (reads), access (calls), redactActions (payloads).
- Fail loud: throw with a reason; read every warning (am logs --level=warn) as a bug report.
- Dev == prod: no isDev behaviour forks; tests are the strictest env; ship only what you ran built.
- Name UI for machines: aria-label / t= on every control, type="button" on buttons.
- Dispatch-test every method, testUI every flow, reproduce every bug as a red test first.
- One appId (pinned), one cell per file, entry dir = app root, tests/ at the root, files < ~200 lines.
- Operate through am's verbs only: am start/stop/status; --client=server-only without pixels;
  --instance=<name> for a private copy beside the human's app.
- Upgrading aio: am pin latest → am migrate → read docs/upgrade/ for that version.`;

const MORE = `DOCS — only for marginal details (inside an app: dep/aio/docs/)
  docs/content.md              every page, indexed BY QUESTION — search it before the source
  docs/basics/                 quickstart · concepts · where-code-runs · pitfalls · api-reference
  docs/state/                  methods · scheduling · composition · transactional-methods ·
                               cell-visibility · cell-workers · real-time (read before hot loops)
  docs/persistence/            big-data · sqlite · crdt · offline · where-files-live
  docs/ui/                     air-signals · air-routing · air-forms · kit · theme · reactivity-tracking
  docs/auth/auth.md · docs/testing/ui-testing.md · docs/testing/cell-testing.md
  docs/build/                  targets · imports · dev-mode · environment · versioning
  docs/deploy/updates.md · docs/debugging/errors.md · docs/debugging/troubleshooting.md
  docs/clients/app-manager.md  every verb, in full · docs/clients/cli-toolkit.md (aio/cli)
  examples/                    contacts (db CRUD) · disk (subprocess, long work) · cli-tool · updates
  am help <verb> · am agent --list · am agent --task=<slug>`;

// ── deep sections (--task only) ─────────────────────────────────────────────

const LOOP = `THE LOOP — observe → act → observe, one call per step
  am start --client=server-only       daemon; NOT deno task dev (dies with your shell)
  am surface --json                   what is on screen, by NAME (no client → server render)
  am dispatch notes:add milk n1 1     drive the state machine (positional args; --args='[…]' exact)
  am expect notes.items[0].text eq milk   assert; never pipe am state into a parser
  am timeline --lines=10              what happened, with state diffs
  am state notes.items --watch        a line per CHANGE (not per poll)
- am trigger's reply already contains the fresh surface: a second read is waste.
- A surface/trigger miss lists the available paths — a wrong name tells you the right ones.
- Paths: Component:Element (App:AddButton), nested App/Panel:SaveButton, keyed Row[key], window for
  onGlobalKey (am trigger window press "ctrl+k"). No index → the newest UI client.
- type APPENDS, setValue REPLACES (same as testUI). There is no submit action: press "Enter" or click.
- am dispatch with missing args is refused (would write undefined); say --args='[]' if intended.
- dispatch ok = APPLIED + broadcast; on disk after the persist window (am persist to force).
- Two apps? each call resolves ONE app: cwd deno.json, or --app=<id>; am instances shows
  each one's stopWith line.`;

const WINDOWS = `WINDOWS — pixels without taking over the screen
Most UI work needs none: am surface --json · am surface --rects (x/y/w/h per element, needs a live
client) · am trigger · am preview src/ui/Card.tsx --export=Card --props='{…}'.
Pixels (screenshots, geometry, a real Electron frame):
  am start --cdp                  devtools port on 127.0.0.1; am instances shows cdpPort
  am shot [--out=F.png] [--full] [--selector='.card']   PNG of the live window
  am shot --update=base.png / --check=base.png [--threshold=N] [--max-diff=R]   visual regression
  am eval 'document.title' [--window=N]   JSON back; promises awaited
Where the window goes (am start --display=…, env AIO_AM_DISPLAY):
  auto (default)  no human on the terminal → nested X display :77 (Xephyr), tabs suppressed
  isolated        always contain · current: the human's desktop · :N a display you manage
No Xephyr → the app still starts on the real desktop and am's output says so (apt install xserver-xephyr).
Never close/reopen that display per run — each appearance grabs focus. Headless CI with Electron:
--client=browser|server-only, or xvfb-run -a, AIO_ELECTRON_ARGS=--disable-gpu.`;

const RUN = `RUN — aio.run options, runtime flags, deno.json, env
aio.run keys (unknown key = boot exits with the key table)
${renderRunKeys()}
app handle  const app = await aio.run(…) → app.db · app.blobs · app.sessions · app.auth · app.port
runtime flags (deno task dev … / binary …; unknown = refused with did-you-mean)
  --port=N --host=ADDR --expose --no-tls --tls-cert=F --tls-key=F --client=X --transport=X --prod
  --watch=false|--no-watch --cdp[=N] --open --takeover --no-persist --db-path=F --isolate=a,b
  --title=X --verbose --version · Electron only: --keep-server --width=N --height=N --server-url=U
  NO: --headless/--service (build words) YES: --client=server-only
deno.json   appId · title · version ("M.m") · client · entry (default src/app.ts) · assets · share
            (["../shared"] → /shared/…) · build { targets, platforms, out, server, css, v8Flags,
            channel } · compile.include (extra data files)
env         AIO_PORT · AIO_APPS_DIR (all apps' data root) · AIO_CDP · AIO_AM_DISPLAY · AIO_NO_OPEN ·
            AIO_NO_DEV_RESTART · AIO_BUILD_VERSION · AIO_ELECTRON_ARGS · NO_COLOR/FORCE_COLOR ·
            DENO_CERT (trust a self-signed --expose cert) · docs/build/environment.md for all`;

const AUTH = `AUTH — who may connect, who may call, who sees what
modes   loopback (default bind 127.0.0.1) = open · exposed (--expose / expose: true / non-loopback
        host) with nothing configured → generated key in data/app.key + 6-digit pairing PIN (3 min;
        am pair for a fresh one) · key: false = open on purpose (warns)
single  key: true (persisted) | "fixed" — sent as ?token=, Authorization: Bearer, or cookie
tokens  users: { "<token>": { id: "ann", role: "admin" } } · resolveUser: (token, state) => user |
        null | Promise (wins over users) · sessions: true | { ttlMs }
accounts auth: true | { signup, ttlMs, cookie, totp, oidc: { issuer, clientId, clientSecret, role },
        requireVerified, sendMail } → /__aio/auth/{signup,login,logout,me,totp,verify,reset,password,
        oidc/start}; lockout 5 tries/15 min
client  <SignIn /> · useUser() (undefined = loading, null = anonymous) · signOut() (aio/air) ·
        authClient.login/signup/logout/me/changePassword/totpSetup (aio)
server  serverUser() → { id, role, … } | undefined · serverRequest() → { ip, headers, cookies, url,
        method } · serverAuth().create/list/setRole/remove (throws without per-user auth) ·
        app.sessions.revokeUser(id)
cells   access (calls) + visible.forUser(s, user) (reads) — declare both on multi-user apps ·
        serverFns(ns, fns, { access }) · errorCode(e) === "ACCESS_DENIED"
2FA     generateTotpSecret() · totpUri(…) · verifyTotp(secret, code) · tests: totpCode (aio/testing)
ops     am auth users · create <id> --role=admin · passwd · unlock · totp <id> off · role <id> <r> ·
        verify · revoke · rm · am trust (install the machine root once) · am profile (.aioapp)`;

const SYNC = `SYNC — CRDT cells, local-first, offline
sync: true | { merge, identity, offline: { retention: "4h" }, onConflict, onSync, onRejected }
merge   "lww" (default) · "counter" (numeric deltas add) · "lww-per-key" (record fields) · "set-add" /
        "set-remove" (arrays by identity, default id "id") · "text" (diff3; lww past 4000 tokens)
flow    sync method runs locally (optimistic) → op queued (localStorage, survives reload) → server
        re-runs it through normal dispatch (guards/access/validate decide) → ack/snapshot rebases
        the client; the server's answer wins
rules   deterministic reducers: ids/timestamps/random values are ARGUMENTS (a mismatch logs "not
        deterministic" and resyncs) · no persist/visible filters (refused: ops reach every peer) ·
        no worker: true · async methods don't replay (their result arrives from the server) ·
        effects in a replay are swallowed; any other side effect runs twice · give sync cells a
        version · sync cells are not in am timeline/replay (op-log instead)
localFirst aio.run({ localFirst: true }) adopts every server cell (sync: false opts out; filtered and
        client-scoped cells are skipped and boot says so)
offline plain (non-sync) calls queue in memory (lost on reload) · serverFn calls never queue ·
        useConnected() / isConnectionDegraded() for UI · status online|offline|syncing|blocked
hot data streams, progress bars, cursors, ticks → docs/state/real-time.md before designing`;

const API =
  `API — what to import from where (every name verified against the entry)
${
    BRIEF_API.map((g) => {
      const lines: string[] = [];
      let cur = `  ${g.entry.padEnd(12)}`;
      for (const n of g.names) {
        if (cur.length + n.length + 1 > 100) {
          lines.push(cur.trimEnd());
          cur = " ".repeat(14);
        }
        cur += n + " ";
      }
      lines.push(cur.trimEnd());
      return lines.join("\n");
    }).join("\n")
  }
also      aio/log (log as a leaf) · aio/db (DB types only) · aio/updates (updates cell) ·
          aio/feedback · aio/build · aio/air/compat (useState/useEffect for React migration only)
rule      server-only VALUES (createDB, connectCli, openBlobStore…) never from a module the UI imports;
          types are fine anywhere (erased)`;

const PITFALLS = `PITFALLS — the long list (symptom → cause → fix)
- Deleting a cell import "to tidy" → cell unregistered, feature silently dead → keep the import.
- Renaming deno.json title/dir → new appId → fresh state (old data still under ~/.<oldId>) → pin appId.
- include with a dotted path → throws; deep paths only in exclude.
- Returning an effect (return schedule.after(…)) → removed; use s.$do(…).
- Naming the cell inside its own methods → TS7022 → self("m").
- interface State { … } as cell state → TS2322 'Index signature is missing' → type State = { … }.
- A timer (setTimeout) that calls cell.m() → escapes log/time-travel/cancel → schedule.next via s.$do.
- Module-scope setInterval → never disposed → own.set("cell:poll", () => { …; return clear }).
- const items = s.items; await …; items.push() → stale reference error → re-read s.items.
- Callback after an async method returned writes s → refused → call a method from the callback.
- await a 200ms computation → still blocks the isolate → blocking() / worker: true.
- s.list = [...s.list, x] on big lists → re-ships the whole list → s.list.push(x).
- Map/Set/Date/class in state → JSON changes it (Map → {}) → plain objects, ISO strings.
- Uint8Array in state → bloat, broadcast → app.blobs.
- Access without visible on an exposed app → boot refused → visible: "all" | exclude | forUser.
- Bound db row missing pk or with Date/bool → throws → ISO string, 0/1, add pk().
- New NOT NULL column without default on a non-empty table → boot throws → nullable or default.
- Kill -9 inside the 100ms persist window → last writes lost → journal: true (+ PRAGMA synchronous=FULL).
- Two apps with one appId → one lock/one db → distinct appId per entry.
- Entry moved to src/client/app.ts → app root moves → ../core imports 404 → keep entry at the top.
- assets only in aio.run → 404 in the binary → also deno.json "assets".
- build.v8Flags vs compile.v8Flags → compile aborts → build.v8Flags.
- Unknown runtime flag (--headless) → refused → --client=server-only.
- A Deno flag (--env-file) after deno task dev → refused (lands after the entry) → am start --env-file=.env
- style.css appears under theme "auto" → aio look vanishes → theme "full" or am theme adopt.
- CSS on #app → nothing matches → #root.
- globalThis.addEventListener → misses Electron child windows/testUI → onWindowEvent/onGlobalKey.
- Hooks behind if → wrong slot → call unconditionally.
- testUI read .text right after actions → stale snapshot → await ui.settle() first.
- expect.rejects without a matcher → passes on a TypeError typo → always pass /reason/.
- ui.absent("x") with t="x" on a component too → pass the kind: ui.absent("x", "element").
- curl localhost:<port> on local Electron → UDS, no TCP port → am state/trigger work over the socket.
- Publishing a -dirty build → refused → commit, or --allow-dirty.
- Exposed app asks for a token → exposure without auth generates a key → share the PIN, or key: false.`;

const ERRORS = `ERRORS — branch on errorCode(e), never on message text
REDUCE_ERROR sync method threw · EFFECT_ERROR effect executor threw · EFFECT_TIMEOUT async call past
effectTimeoutMs (method keeps running) · EFFECT_ASYNC_ERROR async method rejected · HOOK_ERROR
beforeReduce/onAction/onEffect threw · INIT_ERROR onInit threw · DESTROY_ERROR onDestroy threw ·
QUEUE_OVERFLOW dispatch queue > 10k · DISPATCH_LOOP dispatch cycle · DISPATCH_CLOSED after close ·
DISPATCH_DRAINING during shutdown (stop producers in onStopping) · DISPATCH_ABORTED drain threw ·
MEMORY_PRESSURE heap > 75% · MEMORY_CRITICAL heap > 90% · BUDGET_REDUCE / BUDGET_EFFECT over perf
budget · PERSIST_ERROR write failed (am persist says so; am stop exits 1) · PERSIST_SCHEMA stored
schema incompatible · TX_CONFLICT transactional read-set stale · ACCESS_DENIED access rule refused ·
ACTION_REFUSED reached the server, applied nothing (validate/guard)
Forensics: every error carries a correlation id → grep it in ~/.<appId>/logs/{error,debug}.log;
perf.log for budget breaches; docs/debugging/errors.md for the full catalogue.`;

/** The brief, in order. `am agent` prints the `page` sections; `--task=<slug>`
 *  one section; `--task=all` everything. */
export const BRIEF_SECTIONS: readonly BriefSection[] = [
  {
    slug: "rules",
    title: "The four rules that protect the user",
    body: RULES,
    page: true,
  },
  {
    slug: "model",
    title: "What aio is: one cell drives everything",
    body: MODEL,
    page: true,
  },
  {
    slug: "new",
    title: "Build a new app, am create → done",
    body: NEW,
    page: true,
  },
  {
    slug: "cell",
    title: "cell() options, methods, effects, schedules",
    body: CELL,
    page: true,
  },
  {
    slug: "ui",
    title: "AIR UI: rendering, hooks, router, kit, style",
    body: UI,
    page: true,
  },
  {
    slug: "data",
    title: "Persistence tiers, privacy, auth, sync, edge",
    body: DATA,
    page: true,
  },
  {
    slug: "test",
    title: "testCell, testUI, bootCells and friends",
    body: TEST,
    page: true,
  },
  {
    slug: "tasks",
    title: "Every verb of am, grouped, with its flags",
    body: TASKS,
    page: true,
  },
  {
    slug: "debug",
    title: "Debugging playbook + top pitfalls",
    body: DEBUG,
    page: true,
  },
  {
    slug: "ship",
    title: "Build targets, versions, releases",
    body: SHIP,
    page: true,
  },
  {
    slug: "practice",
    title: "How an expert writes aio",
    body: PRACTICE,
    page: true,
  },
  {
    slug: "docs",
    title: "Where marginal details live",
    body: MORE,
    page: true,
  },
  {
    slug: "loop",
    title: "(deep) The observe → act → observe loop",
    body: LOOP,
    page: false,
  },
  {
    slug: "windows",
    title: "(deep) Screenshots, cdp, displays",
    body: WINDOWS,
    page: false,
  },
  {
    slug: "run",
    title: "(deep) aio.run keys, runtime flags, env",
    body: RUN,
    page: false,
  },
  {
    slug: "auth",
    title: "(deep) Keys, users, accounts, sessions",
    body: AUTH,
    page: false,
  },
  {
    slug: "sync",
    title: "(deep) CRDT sync, localFirst, offline",
    body: SYNC,
    page: false,
  },
  {
    slug: "api",
    title: "(deep) Every export, by entry",
    body: API,
    page: false,
  },
  {
    slug: "pitfalls",
    title: "(deep) The long pitfall list",
    body: PITFALLS,
    page: false,
  },
  {
    slug: "errors",
    title: "(deep) AioErrorCode catalogue",
    body: ERRORS,
    page: false,
  },
];

/** Slugs `--task=` accepts (plus `all`). */
export const BRIEF_TASKS: readonly string[] = BRIEF_SECTIONS.map((s) => s.slug);

/** The sections a `--task` value selects: the page by default, one section by
 *  slug, every section for `all`. Pure. */
export function pickSections(task?: string): readonly BriefSection[] {
  if (task === undefined) return BRIEF_SECTIONS.filter((s) => s.page);
  if (task === "all") return BRIEF_SECTIONS;
  return BRIEF_SECTIONS.filter((s) => s.slug === task);
}

/** The page, one section, or everything. Pure — `version` is passed in so this
 *  file can stay a leaf (importing VERSION pulls the entire runtime). */
export function agentBrief(opts: {
  version: string;
  task?: string;
}): string {
  const picked = pickSections(opts.task);
  const deep = BRIEF_SECTIONS.filter((s) => !s.page).map((s) => s.slug);
  const head = `aio ${opts.version} — AGENT BRIEF: all of aio on one page, ` +
    `verified against this CLI + API\n` +
    `page:   ${
      BRIEF_SECTIONS.filter((s) => s.page).map((s) => s.slug).join(" ")
    }\n` +
    `deeper: ${
      deep.join(" ")
    }  (am agent --task=<slug> | --task=all | --list)\n`;
  return head + "\n" + picked.map((s) => s.body).join("\n\n") + "\n";
}

/** The `CLAUDE.md` that `am create` writes beside `AGENTS.md`.
 *
 *  Claude Code loads `CLAUDE.md` and not `AGENTS.md`, so an app scaffolded
 *  with only the latter was an app whose agent never met the pointer to
 *  `am agent` — measured by an agent that built one end to end. One line, and
 *  a pointer rather than a copy: `@AGENTS.md` is Claude Code's import syntax,
 *  so the file it loads IS the one every other agent loads. */
export const CLAUDE_MD_SCAFFOLD =
  "Read @AGENTS.md first — then `am agent`, the aio brief, before editing.\n";

/** The `AGENTS.md` that `am create` writes at a new app's ROOT.
 *
 *  Short on purpose: its job is to be loaded without being asked and to name
 *  the ONE command that carries the rest. A long file here drifts from the
 *  brief; a pointer cannot. */
export function agentsMdScaffold(appName: string): string {
  return `# Working on ${appName} with an AI agent

This app is built on [aio](https://github.com/riagentic/aio) — one
\`cell({ state, methods })\` drives server state, persistence, sync and the UI.
It is not React, Express or Next; guessing from those produces code that
type-checks and is wrong.

## Read this first

    am agent

One command, one page: the model, the full API, every \`am\` verb, how to add
state/UI/tests, debug and ship. \`am agent --task=<slug>\` for one section
(\`--list\` for all; \`--task=new\` is the build flow).

## Four rules

- **Never end an app by process match.** \`pkill -f app.ts\` matches EVERY aio
  app on the machine. Use \`am stop\` (\`am stop --all\` for this project);
  \`am instances\` shows what is running.
- **Never take over the screen.** Use \`am start --client=server-only\` and read
  the UI with \`am surface\` — it needs no window.
- **Never script around \`am\`.** Python, jq or curl against this app is a worse
  copy of a verb. Every command takes \`--json\`.
- **Learn before editing.** \`am agent\` first.

## The loop

    am start --client=server-only  # daemonised; deno task dev dies with your shell
    am surface --json              # what is on screen, by NAME
    am dispatch <cell:method> args # drive the state machine
    am expect <path> eq <value>    # assert — do not pipe state to a parser
    am timeline --lines=20         # what happened, with state diffs
    deno task test && deno task check && deno task lint
`;
}
