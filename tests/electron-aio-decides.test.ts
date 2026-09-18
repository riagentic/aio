// aio decides an app's Electron — not the app. aio is tested with ONE Electron
// (DEFAULT_ELECTRON_VERSION) and a build ships exactly that one; the app's
// `imports.electron` line and its node_modules runtime are copies that `am
// pin`, `am fix` and the dev launcher keep in line. Before this, an app
// scaffolded by an older aio kept that aio's Electron under every later
// framework — a combination no release had ever run.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_ELECTRON_VERSION } from "../src/electron/electron-runtime-fetch.ts";
import { findElectronBin } from "../src/electron/electron-spawn.ts";
import type { Log } from "../src/electron/electron-shared.ts";
import {
  electronLine,
  electronSpec,
  testedElectronFor,
  testedElectronOf,
} from "../src/am/am-electron.ts";
import { syncFrameworkDeps } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A fake installed runtime of `version` under `root` (unpacked + launcher). */
async function fakeRuntime(root: string, version: string): Promise<void> {
  await Deno.mkdir(join(root, "node_modules", "electron", "dist"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(root, "node_modules", "electron", "package.json"),
    JSON.stringify({ version }),
  );
  await Deno.mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await Deno.writeTextFile(join(root, "node_modules", ".bin", "electron"), "");
}

/** A fake aio tree whose tested Electron is `version`. */
async function fakeAio(root: string, version: string): Promise<void> {
  await Deno.mkdir(join(root, "src", "electron"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "src", "electron", "electron-runtime-fetch.ts"),
    `export const DEFAULT_ELECTRON_VERSION = "${version}";\n`,
  );
}

/** Run `fn` with cwd = a fresh temp dir (the launcher reads relative paths). */
async function inTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = await tempDir("electron-decides-");
  const cwd = Deno.cwd();
  const ep = Deno.env.get("ELECTRON_PATH");
  Deno.env.delete("ELECTRON_PATH");
  Deno.chdir(tmp);
  try {
    await fn(tmp);
  } finally {
    Deno.chdir(cwd);
    if (ep !== undefined) Deno.env.set("ELECTRON_PATH", ep);
    await dropTempDir(tmp);
  }
}

Deno.test("dev launcher: a stale node_modules Electron is replaced by the tested one", async () => {
  await inTmp(async (tmp) => {
    await fakeRuntime(tmp, "42.0.0");
    const errors: string[] = [];
    const log: Log = { info: () => {}, error: (m) => errors.push(m) };
    let installs = 0;
    const bin = await findElectronBin(log, {
      compiled: false,
      denoInstall: async () => {
        installs++;
        await fakeRuntime(tmp, DEFAULT_ELECTRON_VERSION);
        return true;
      },
    });
    assertEquals(bin, "node_modules/.bin/electron");
    assertEquals(installs, 1);
    assert(
      errors.some((e) =>
        e.includes("42.0.0") && e.includes(DEFAULT_ELECTRON_VERSION)
      ),
      `says which Electron it replaced:\n${errors.join("\n")}`,
    );
  });
});

Deno.test("dev launcher: offline, the old runtime still runs — and says so", async () => {
  await inTmp(async (tmp) => {
    await fakeRuntime(tmp, "42.0.0");
    const errors: string[] = [];
    const bin = await findElectronBin(
      { info: () => {}, error: (m) => errors.push(m) },
      { compiled: false, denoInstall: () => Promise.resolve(false) },
    );
    assertEquals(bin, "node_modules/.bin/electron");
    assert(
      errors.some((e) => e.includes("running 42.0.0") && e.includes("am fix")),
      errors.join("\n"),
    );
  });
});

Deno.test("dev launcher: the tested Electron installed → no install, no noise", async () => {
  await inTmp(async (tmp) => {
    await fakeRuntime(tmp, DEFAULT_ELECTRON_VERSION);
    const errors: string[] = [];
    let installs = 0;
    const bin = await findElectronBin(
      { info: () => {}, error: (m) => errors.push(m) },
      {
        compiled: false,
        denoInstall: () => {
          installs++;
          return Promise.resolve(true);
        },
      },
    );
    assertEquals(bin, "node_modules/.bin/electron");
    assertEquals(installs, 0);
    assertEquals(errors, []);
  });
});

Deno.test("testedElectronOf: read from the PINNED aio's source; null when it does not say", async () => {
  const tmp = await tempDir("electron-decides-");
  try {
    assertEquals(await testedElectronOf(tmp), null);
    await fakeAio(tmp, "45.1.0");
    assertEquals(await testedElectronOf(tmp), "45.1.0");
    // an app: its dep/aio decides, else this am's own
    const app = join(tmp, "app");
    await Deno.mkdir(app);
    assertEquals(await testedElectronFor(app), DEFAULT_ELECTRON_VERSION);
    await fakeAio(join(app, "dep", "aio"), "45.1.0");
    assertEquals(await testedElectronFor(app), "45.1.0");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("this repo's own tested version is readable the way am reads a pinned aio", async () => {
  assertEquals(await testedElectronOf(Deno.cwd()), DEFAULT_ELECTRON_VERSION);
});

Deno.test("am pin's dep sync moves the app's electron line to the pinned aio's version", async () => {
  const tmp = await tempDir("electron-decides-");
  try {
    const fw = join(tmp, "aio");
    await fakeAio(fw, "45.1.0");
    await Deno.writeTextFile(join(fw, "deno.json"), '{"imports":{}}');
    const app = join(tmp, "app");
    await Deno.mkdir(app);
    // JSONC with a comment: the rewrite is a string edit that keeps it
    await Deno.writeTextFile(
      join(app, "deno.json"),
      '{\n  // the app\n  "imports": { "electron": "npm:electron@43.0.0" }\n}\n',
    );
    const changes = await syncFrameworkDeps(app, fw);
    assertEquals(changes, [{
      key: "electron",
      from: "npm:electron@43.0.0",
      to: electronSpec("45.1.0"),
    }]);
    const text = await Deno.readTextFile(join(app, "deno.json"));
    assertStringIncludes(text, "// the app");
    assertStringIncludes(text, '"npm:electron@45.1.0"');
    assertEquals(await syncFrameworkDeps(app, fw), [], "idempotent");

    // An app that never declared electron is not given one.
    const plain = join(tmp, "plain");
    await Deno.mkdir(plain);
    await Deno.writeTextFile(join(plain, "deno.json"), '{"imports":{}}');
    assertEquals(await syncFrameworkDeps(plain, fw), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("electronLine: every outcome names the versions, and the way on", () => {
  const base = { from: "43.0.0", to: "44.4.1" };
  for (
    const [a, want] of [
      [{ ...base, outcome: "installed" as const }, "installed"],
      [{ ...base, outcome: "skipped" as const }, "am fix"],
      [{ ...base, outcome: "failed" as const, error: "offline" }, "offline"],
    ] as const
  ) {
    const line = electronLine(a);
    assertStringIncludes(line, "43.0.0 → 44.4.1");
    assertStringIncludes(line, want);
  }
});

Deno.test("a COMPILED app never takes node_modules' Electron — even inside a dev tree", async () => {
  await inTmp(async (tmp) => {
    await fakeRuntime(tmp, "42.0.0"); // a dev tree around the binary
    const runtime = join(tmp, "runtime");
    await Deno.mkdir(runtime);
    const fetched: string[] = [];
    const bin = await findElectronBin(
      { info: () => {}, error: () => {} },
      {
        compiled: true,
        fetchRuntime: (v) => {
          fetched.push(v);
          return Promise.resolve(runtime);
        },
      },
    );
    assert(bin !== "node_modules/.bin/electron", `took the dev tree's: ${bin}`);
    assertEquals(
      fetched,
      [DEFAULT_ELECTRON_VERSION],
      "its own runtime instead",
    );
  });
});
