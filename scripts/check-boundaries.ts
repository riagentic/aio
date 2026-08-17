// Module-boundary gate: enforces the src/ folder dependency matrix.
//
// Three rules, all red gates:
//   1. A folder may import only itself and the folders listed for it below.
//   2. Root entry files (src/*.ts) are CONDUITS, not laundering holes: a
//      folder importing a root file inherits that file's whole (transitive)
//      folder reach, and every folder in that reach must be allowed for the
//      importer. (This is what killed state/cell.ts → cell-test.ts, which
//      quietly gave state/ a path into server/ and testing/.)
//   3. A declared edge nobody uses is an ERROR — the matrix self-ratchets.
//      Widening it is always a deliberate one-line diff with a reason; a
//      permission that outlives its last importer is a door left unlocked.
//
// Root entry files themselves are unrestricted (they ARE the public surface
// and carry load-bearing side effects, e.g. state-core's enablePatches).
// Run: deno task boundaries

const ALLOWED: Record<string, string[]> = {
  // periphery entry (aio/extras) — re-exports deep types across the surface
  extras: [
    "server", // error/vitals/config detail types + parseCli
    "state", // cell plumbing types (ActionSource, CellReduceFn, …)
    "diagnostics", // AioError detail types
    "vitals", // VitalAlert/VitalThresholds
  ],
  // ── isomorphic core — dependency-light ──
  state: [
    "diagnostics", // diagEmit (offline-queue drops), error reporting
    "protocol", // envelope enc(), ack-registry (ackMethodKey, settlesCalls)
    "sync", // type-only: cell sync-config normalization
  ],
  // protocol is a LEAF wire vocabulary since the alpha52 decomposition (the
  // browser-runtime files live in browser/): envelope, version stamp,
  // wire/return values, ack mechanism, broadcast utils, shared transport math.
  protocol: [
    "diagnostics", // return-value transport logs lossy conversions
  ],
  diagnostics: [
    "state", // signals/listeners for the diagnostic bus + time-travel
    "vitals", // diag formatter + threshold types
  ],
  // ── UI (browser + SSR) — never server ──
  air: [
    "state", // signals, cell types, dispatch types
    "protocol", // wire envelope + router/status types
    "diagnostics", // error overlay, logger API
  ],
  browser: [
    "state", // cell binding, signals, offline-queue factory, ack sink
    "protocol", // envelope, version, ack-registry, status/diagnostics sinks
    "diagnostics", // diagnostic bus, degraded relay
    "air", // renderer wiring (time-travel panel, dev hints)
    "vitals", // render meter + transport probe
    "sync", // client CRDT engine
    "adapters", // useLocal implementation
  ],
  ui: ["air"], // component kit renders through air only
  vitals: [
    "state", // signal/listener primitives
    "diagnostics", // bus + formatter
  ],
  sync: [
    "state", // HLC/op integration with cell state
    "protocol", // sync wire frames
    "diagnostics", // sync diagnostics
    "db", // shared storage types
  ],
  db: [
    "server", // worker-thread SQLite host plumbing
    // The framework LOGGER. Every folder that talks to a human needs a levelled
    // channel; the only alternative is `console`, which is the defect this edge
    // exists to remove — output with no level, no category and no file. Widened
    // deliberately, and narrowly: diagnostics/logger is a leaf here, never the
    // rest of diagnostics' machinery.
    "diagnostics",
  ],
  // ── server may use everything except browser-only client code ──
  server: [
    "state",
    "protocol",
    "diagnostics",
    "air", // SSR
    "sync",
    "db",
    "vitals",
    "electron", // electron target boot
    "build", // dev-mode transpile/build integration
  ],
  electron: [
    "server", // shares the server runtime in the main process
    "protocol", // UDS transport framing (transport-shared)
    "diagnostics", // the framework logger — see the note on `db`
  ],
  build: [
    "server", // build drives the server's compile/manifest helpers
    "electron", // electron artifact generation
    // protocol: the build stamps the wire-protocol identity (version stamp)
    // into the browser bundle, so a client artifact can name the aio build it
    // came from and a stale bundle is detectable.
    "protocol",
  ],
  am: [
    "server", // talks to running apps via the server's client/trojan APIs
    "state", // action/cell types for dispatch & timeline
    "diagnostics", // ONE redaction sentinel (redact.ts) for journal/replay
  ],
  // testing may boot a real server — `testServer()`/`testBrowser()`
  // (aio/testing) run in Deno test processes, never in a browser bundle, so
  // the server import is safe here (it is the whole point of a server test
  // helper).
  testing: [
    "state",
    "air",
    "protocol",
    "diagnostics",
    "browser",
    "server",
    // via the src/standalone-air.ts conduit only: testUI boots the standalone
    // runtime, which re-exports useLocal from adapters/.
    "adapters",
  ],
  adapters: [
    "air", // hook/render integration
    "state", // signals + the state-core conduit
  ],
};

// import contexts only: `from "..."`, `import "..."`, `import("...")`
const SPEC = /(?:from\s*|import\s*\(?\s*)["'](\.\.?\/[^"']+?\.tsx?)["']/g;

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function folderOf(path: string): string | null {
  const m = path.match(/^src\/([^/]+)\//);
  return m ? m[1]! : null;
}

async function importsOf(file: string): Promise<string[]> {
  const code = stripComments(await Deno.readTextFile(file));
  const out: string[] = [];
  for (const m of code.matchAll(SPEC)) {
    const target = normalize(dirname(file) + "/" + m[1]!);
    if (!target.startsWith("src/")) continue;
    try {
      await Deno.stat(target);
    } catch {
      continue; // template/example string, not a real module — typecheck owns those
    }
    out.push(target);
  }
  return out;
}

// ── Pass 1: collect every file's real imports ────────────────────────
const fileImports = new Map<string, string[]>();
for await (const entry of walk("src")) {
  fileImports.set(entry, await importsOf(entry));
}

// ── Root-file conduit reach: root file → transitive folder set ───────
// A root file may import other root files (air.ts → browser-air.ts), so the
// reach is the transitive closure over root-to-root edges.
const rootReach = new Map<string, Set<string>>();
function reachOf(root: string, seen = new Set<string>()): Set<string> {
  const cached = rootReach.get(root);
  if (cached) return cached;
  const reach = new Set<string>();
  if (seen.has(root)) return reach; // cycle guard
  seen.add(root);
  for (const target of fileImports.get(root) ?? []) {
    const to = folderOf(target);
    if (to !== null) reach.add(to);
    else for (const f of reachOf(target, seen)) reach.add(f);
  }
  rootReach.set(root, reach);
  return reach;
}

// ── Pass 2: enforce ──────────────────────────────────────────────────
let errors = 0;
// Every (from, to) edge actually exercised — directly or through a root
// conduit — so rule 3 can flag declared-but-dead permissions.
const usedEdges = new Set<string>();

for (const [entry, imports] of fileImports) {
  const from = folderOf(entry);
  if (from === null) continue; // root entry files are unrestricted
  const allowed = ALLOWED[from];
  if (!allowed) {
    console.error(`✗ ${entry}: folder "${from}" missing from ALLOWED matrix`);
    errors++;
    continue;
  }
  for (const target of imports) {
    const to = folderOf(target);
    if (to === null) {
      // Root conduit: the importer inherits the root file's whole reach.
      for (const reached of reachOf(target)) {
        if (reached === from) continue;
        if (!allowed.includes(reached)) {
          console.error(
            `✗ ${entry} → ${target} reaches folder "${reached}" ` +
              `(root-file conduit; ${from} may not import ${reached})`,
          );
          errors++;
        } else {
          usedEdges.add(`${from}→${reached}`);
        }
      }
      continue;
    }
    if (to === from) continue;
    if (!allowed.includes(to)) {
      console.error(`✗ ${entry} → ${target} (${from} may not import ${to})`);
      errors++;
    } else {
      usedEdges.add(`${from}→${to}`);
    }
  }
}

// ── Rule 3: declared edges with no importer are errors (self-ratchet) ─
for (const [from, tos] of Object.entries(ALLOWED)) {
  for (const to of tos) {
    if (!usedEdges.has(`${from}→${to}`)) {
      console.error(
        `✗ ALLOWED["${from}"] permits "${to}" but nothing imports it — ` +
          `remove the dead edge (the matrix self-ratchets; re-add it with a ` +
          `comment when a real import needs it)`,
      );
      errors++;
    }
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) yield p;
  }
}

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

if (errors) {
  console.error(`\n${errors} boundary violation(s).`);
  Deno.exit(1);
}
console.log("✓ src/ module boundaries respected");
