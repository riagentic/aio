// Module-boundary gate: enforces the src/ folder dependency matrix.
// A folder may import only from itself and the folders listed here.
// Root entry files (src/*.ts) are the public surface: they may import any
// folder, and folders may import them (barrels carry load-bearing side
// effects, e.g. state-core's enablePatches).
// Run: deno task boundaries

const ALLOWED: Record<string, string[]> = {
  // periphery entry (aio/extras) — re-exports across the whole surface
  extras: [
    "server",
    "state",
    "db",
    "diagnostics",
    "vitals",
    "protocol",
    "sync",
    "electron",
    "air",
    "build",
    "adapters",
  ],
  // isomorphic core — must stay dependency-light
  state: ["diagnostics", "protocol", "sync"], // sync: type-only cell config
  protocol: ["state", "diagnostics", "vitals", "sync"], // sync: cell sync-config normalization
  diagnostics: ["state", "protocol", "vitals"],
  // UI (browser + SSR) — never server
  air: ["state", "protocol", "diagnostics", "browser", "vitals", "testing"],
  browser: [
    "state",
    "protocol",
    "diagnostics",
    "air",
    "vitals",
    "sync",
    "db",
    "adapters",
  ],
  ui: ["air"], // component kit renders through air only
  vitals: ["state", "protocol", "diagnostics"],
  sync: ["state", "protocol", "diagnostics", "db"], // db: shared storage types
  db: ["state", "diagnostics", "server"],
  // server may use everything except browser-only client code
  server: [
    "state",
    "protocol",
    "diagnostics",
    "air",
    "sync",
    "db",
    "vitals",
    "electron",
    "build",
    "adapters",
    "testing",
  ],
  electron: ["server", "state", "protocol", "diagnostics"],
  // protocol: the build stamps the wire-protocol identity (version stamp) into
  // the browser bundle, so a client artifact can name the aio build it came
  // from and a stale bundle is detectable.
  build: ["server", "state", "diagnostics", "electron", "protocol"],
  am: ["server", "state", "protocol", "diagnostics", "db"],
  // testing may boot a real server — `testServer()`/`testBrowser()` (aio/testing)
  // run in Deno test processes, never in a browser bundle, so the server import
  // is safe here (it is the whole point of a server test helper).
  testing: ["state", "air", "protocol", "diagnostics", "browser", "server"],
  adapters: ["air", "state", "browser", "diagnostics"],
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

let errors = 0;
for await (const entry of walk("src")) {
  const from = folderOf(entry);
  if (from === null) continue; // root entry files are unrestricted
  const allowed = ALLOWED[from];
  if (!allowed) {
    console.error(`✗ ${entry}: folder "${from}" missing from ALLOWED matrix`);
    errors++;
    continue;
  }
  const code = stripComments(await Deno.readTextFile(entry));
  for (const m of code.matchAll(SPEC)) {
    const target = normalize(dirname(entry) + "/" + m[1]!);
    if (!target.startsWith("src/")) continue;
    try {
      await Deno.stat(target);
    } catch {
      continue; // template/example string, not a real module — typecheck owns those
    }
    const to = folderOf(target);
    if (to === null) continue; // root entry barrel — allowed
    if (to !== from && !allowed.includes(to)) {
      console.error(`✗ ${entry} → ${target} (${from} may not import ${to})`);
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
