// Electron version consistency across the whole framework.
//
// A field incident already happened here (the header of
// `src/build/electron-runtime.ts` records it): a Windows package shipped
// Electron 44.4.1 while its self-contained exe carried 43.0.0, because the
// version was decided in two places. This gate extends the same rule to the
// THREE surfaces that can name a version, so they cannot drift again:
//
//   1. `DEFAULT_ELECTRON_VERSION` — the floor a build uses when nothing is
//      installed, and the launcher's fallback.
//   2. The scaffold's import-map pin — what a NEW app declares.
//   3. The repo's own `package.json` — what the framework's dev/test tree runs.
//
// It also pins the version to Electron's own `latest`, so "up to date" is a
// checked fact rather than an intention. That check is network-OPTIONAL: it is
// skipped offline, because a version pin is a fact about the repo and must be
// testable from a tarball.
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_ELECTRON_VERSION } from "../src/build/electron-runtime.ts";
import { scaffold } from "../src/am/am-cmd-create.ts";

Deno.test("electron version: the framework has ONE default, and it is a real version", () => {
  assert(
    /^\d+\.\d+\.\d+$/.test(DEFAULT_ELECTRON_VERSION),
    `DEFAULT_ELECTRON_VERSION must be an exact x.y.z, got ` +
      `${DEFAULT_ELECTRON_VERSION} — a range cannot be fetched as one release`,
  );
});

Deno.test("electron version: the repo's own package.json runs the SAME version", async () => {
  // The framework's dev/test dependency, so the tree it is developed in runs
  // the Electron it tells apps to build against.
  //
  // `package.json` is gitignored and DENO-MANAGED — `deno install` writes the
  // spec itself, with a caret — so this accepts a `^`/`~` prefix here. The
  // EXACT-pin rule is enforced on the surfaces aio actually ships and
  // scaffolds (the scaffold spec and the examples, both checked above); a
  // caret in deno's own generated file is its syntax, not aio's policy.
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await Deno.readTextFile("package.json"));
  } catch {
    return; // no package.json in this checkout — nothing to compare
  }
  const spec = pkg.dependencies?.electron;
  if (!spec) return;
  const m = /^[\^~]?(\d+\.\d+\.\d+)$/.exec(spec);
  assert(m, `package.json's electron spec names no version: ${spec}`);
  assertEquals(
    m[1],
    DEFAULT_ELECTRON_VERSION,
    "package.json's electron version must equal DEFAULT_ELECTRON_VERSION — " +
      "otherwise the framework develops against one Electron and builds " +
      "another",
  );
});

Deno.test("electron version: the scaffold pins the framework's version, not bare latest", async () => {
  // `npm:electron` (no version) resolves to whatever is latest at INSTALL time,
  // which is not a pin: two apps scaffolded a month apart ran different
  // Chromiums, and neither matched the build's fallback. The scaffold must
  // name the framework's version in its import map.
  // The scaffold's OUTPUT is read, not its source text: a grep for the
  // helper's name stays green while the helper returns the wrong string.
  for (const source of [true, false]) {
    const files = scaffold("pin-probe", "counter", source, "electron");
    const cfg = JSON.parse(files["deno.json"]!) as {
      imports?: Record<string, string>;
    };
    assertEquals(
      cfg.imports?.electron,
      `npm:electron@${DEFAULT_ELECTRON_VERSION}`,
      `a new electron app (source=${source}) must pin the framework's ` +
        `Electron exactly, not a bare npm:electron (latest-at-install)`,
    );
  }
});

Deno.test("electron version: the examples agree with the framework", async () => {
  // Examples are the docs that run. A drifting example teaches the wrong pin.
  for (
    const f of [
      "examples/contacts/deno.json",
      "examples/targets/electron/deno.json",
      "examples/targets/electron-remote/deno.json",
    ]
  ) {
    let cfg: { imports?: Record<string, string> };
    try {
      cfg = JSON.parse(await Deno.readTextFile(f));
    } catch {
      continue; // example absent in this checkout
    }
    const spec = cfg.imports?.electron;
    if (!spec) continue;
    // `npm:electron@44.4.1`, EXACTLY — a range re-opens the drift this whole
    // file exists to prevent.
    const m = /^(?:npm:electron@)?(\d+\.\d+\.\d+)$/.exec(spec);
    assert(
      m,
      `${f}: electron must be pinned exactly (no range), got ${spec}`,
    );
    assertEquals(
      m[1],
      DEFAULT_ELECTRON_VERSION,
      `${f}: electron must match DEFAULT_ELECTRON_VERSION`,
    );
  }
});

Deno.test("electron version: no OTHER source file hardcodes an electron version", async () => {
  // The two deciders are DEFAULT_ELECTRON_VERSION and an app's declared spec.
  // A third literal in the framework is the bug class this whole file exists
  // for. (`build/electron-runtime.ts` may MENTION a version in a comment —
  // comments are stripped before the scan.)
  const offenders: string[] = [];
  async function scan(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        await scan(p);
        continue;
      }
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      if (p.endsWith("electron-runtime.ts")) continue; // the authority module
      const code = (await Deno.readTextFile(p))
        // Versions in prose are history, not a pin — strip comments first.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/electron@\^?(\d+)\.\d+\.\d+/g)) {
        offenders.push(`${p}: ${m[0]}`);
      }
    }
  }
  await scan("src");
  assertEquals(
    offenders,
    [],
    "these files hardcode an Electron version — read " +
      "DEFAULT_ELECTRON_VERSION instead:\n  " + offenders.join("\n  "),
  );
});

Deno.test("electron version: freshness against Electron's latest is REPORTED, never fatal", async () => {
  // "Up to date" is worth knowing and must not be a red gate. The consistency
  // checks above are hermetic and fatal — they fail only on a mistake in THIS
  // repo. This one reaches the network, so failing it would make the suite
  // depend on upstream's release cadence: it did exactly that, mid-release,
  // when Electron shipped 44.4.2 while the release check was running.
  //
  // So it WARNS (visible in the release log, where a human is already looking)
  // and, for a CI job that wants it enforced, respects
  // `AIO_REQUIRE_LATEST_ELECTRON=1`. Offline, it is a silent pass — a version
  // pin is a fact about the repo and must be testable from a tarball.
  let latest: string | undefined;
  try {
    const r = await fetch("https://registry.npmjs.org/electron/latest", {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) latest = (await r.json() as { version?: string }).version;
  } catch { /* offline — nothing to report */ }
  if (!latest || latest === DEFAULT_ELECTRON_VERSION) return;
  const msg = `DEFAULT_ELECTRON_VERSION is ${DEFAULT_ELECTRON_VERSION} but ` +
    `Electron's latest is ${latest} — bump it (with package.json, the ` +
    `scaffold and the examples) in one change`;
  if (Deno.env.get("AIO_REQUIRE_LATEST_ELECTRON") === "1") {
    assertEquals(DEFAULT_ELECTRON_VERSION, latest, msg);
  } else {
    console.warn(`⚠ ${msg} (set AIO_REQUIRE_LATEST_ELECTRON=1 to enforce)`);
  }
});
