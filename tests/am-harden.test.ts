// The opt-in security switches, for an app that EXISTS.
//
// `electron.strictPin` / `build.strictPin` and `electron.ignoreDebugEnv` close
// real doors, and stay off by default: an app that ships today must behave
// the same after `am pin` + `am fix`. So for an existing app:
//   • `am doctor` names each door that applies and is still open — a hint,
//     exit 0, nothing written;
//   • `am fix` does not touch them;
//   • `am fix --harden` writes the deno.json key, and spells out the
//     `aio.run()` ones (app source is the author's) — saying exactly what.
// A NEW app has them already (`am create`), so it gets no hint.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  androidColorSchemeHint,
  hardenFindings,
  OWN_ACTIVITY,
  shippedHelpHints,
} from "../src/am/am-harden.ts";
import {
  firstUseKeyWarning,
  updatesKeyOnFirstUse,
} from "../src/build/capabilities.ts";
import {
  hardenFindingsFor,
  shippedHelpHintsFor,
} from "../src/am/am-cmd-doctor.ts";
import { declaredTargets } from "../src/am/am-cmd-fix.ts";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { TEMPLATES } from "../src/am/am-help-text.ts";

const keys = (cfg: Record<string, unknown>, entry: string | null) =>
  hardenFindings(cfg, declaredTargets(cfg), entry).map((f) => f.key);

Deno.test("hardenFindings: only the switches the app's shape makes relevant, and only while undecided", () => {
  const run = "await aio.run({ cells });\n";
  // A browser or server app: none of these doors exist.
  assertEquals(keys({ client: "browser" }, run), []);
  assertEquals(keys({ build: { targets: ["server", "cli"] } }, run), []);
  // A desktop app reads the ambient debug variables.
  assertEquals(keys({ client: "electron" }, run), ["electron.ignoreDebugEnv"]);
  assertEquals(
    keys({ build: { targets: { desk: { kind: "electron" } } } }, run),
    ["electron.ignoreDebugEnv"],
    "the object form, by kind",
  );
  // A packaged remote client holds a saved key.
  assertEquals(
    keys({ build: { targets: ["server", "electron-client"] } }, run),
    ["build.strictPin"],
  );
  // A launched remote client does too.
  assertEquals(
    keys({ tasks: { remote: "deno run -A src/app.ts --server-url" } }, run),
    ["electron.strictPin"],
  );
  assertEquals(
    keys({}, `await aio.run({ serverUrl: "https://10.0.0.2:8000" });`),
    ["electron.strictPin"],
  );
  // DECIDED, either way, is the app's answer — `false` included.
  const all = {
    client: "electron",
    build: { targets: ["electron", "electron-client"], strictPin: false },
    tasks: { remote: "deno run -A src/app.ts --server-url" },
  };
  assertEquals(
    keys(
      all,
      "await aio.run({ electron: { ignoreDebugEnv: false, strictPin: true } });",
    ),
    [],
  );
  // A key in a comment decides nothing; one inside a string is not a comment.
  assertEquals(
    keys(
      { client: "electron" },
      `// electron: { ignoreDebugEnv: true }\n/* ignoreDebugEnv */\n` +
        `const u = "http://x"; await aio.run({});`,
    ),
    ["electron.ignoreDebugEnv"],
  );
  // No readable entry: nothing is claimed about aio.run().
  assertEquals(keys(all, null), []);
  assertEquals(
    keys({ build: { targets: ["electron-client"] } }, null),
    ["build.strictPin"],
  );
});

Deno.test("hardenFindings: each hint is one sentence that names the door and the key, and says what it costs", () => {
  const cfg = {
    client: "electron",
    build: { targets: ["electron", "electron-client"] },
    tasks: { remote: "deno run -A src/app.ts --server-url" },
  };
  const found = hardenFindings(cfg, declaredTargets(cfg), "aio.run({});");
  assertEquals(found.length, 3);
  for (const f of found) {
    assertStringIncludes(f.hint, f.key.split(".")[1]!, f.key);
    assertStringIncludes(f.hint, f.write.replace(/^"build": /, ""), f.key);
  }
  const pin = found.find((f) => f.key === "build.strictPin")!;
  assertStringIncludes(pin.hint, "sends it the saved key");
  assertStringIncludes(pin.hint, "pair again");
  const env = found.find((f) => f.key === "electron.ignoreDebugEnv")!;
  assertStringIncludes(env.hint, "AIO_CDP");
  assertStringIncludes(env.hint, "--cdp");
});

// The update signing key: trusted on first use unless the app ships it. The
// hint claims only what the entry's text settles — anything computed, a git
// source (nothing is signed there), or any decision already made is silence.
Deno.test("hardenFindings: updates with no key in the entry is told `updates.key` — and only a signed-manifest source the text settles", () => {
  const src = `"https://releases.example.com/app"`;
  const cases: [string, boolean][] = [
    [`aio.run({ updates: ${src} });`, true],
    [`aio.run({ updates: { source: ${src}, auto: true } });`, true],
    [`aio.run({ updates: { source: "file:///srv/releases/app" } });`, true],
    [`aio.run({ updates: { source: ${src}, key: PUB } });`, false],
    [`aio.run({ updates: { source: ${src}, keys: [A, B] } });`, false],
    [`aio.run({ updates: { source: ${src}, allowUnsigned: true } });`, false],
    [`aio.run({ updates: { ...shared, source: ${src} } });`, false],
    [`aio.run({ updates: "https://github.com/me/app" });`, false], // git
    [`aio.run({ updates: "git@example.com:me/app.git" });`, false],
    [`aio.run({ updates: { source: ${src}, kind: "git" } });`, false],
    [`aio.run({ updates: "https://github.com/me/app/releases" });`, false], // undecidable
    [`aio.run({ updates: releaseUrl });`, false], // computed
    [`aio.run({ updates: { source: env("URL") } });`, false],
    [`aio.run({ updates: \`\${base}/app\` });`, false],
    [`aio.run({ cells }); // updates: ${src}`, false], // a comment
    [`aio.run({ cells });`, false],
  ];
  for (const [entry, told] of cases) {
    assertEquals(updatesKeyOnFirstUse(entry), told, entry);
    assertEquals(keys({}, entry).includes("updates.key"), told, entry);
  }
  const [f] = hardenFindings({}, [], cases[0]![0]);
  assertEquals(f!.file, "entry", "app source is the author's — advised only");
  assertStringIncludes(f!.hint, f!.write);
  assertStringIncludes(f!.hint, "first use");
  assertStringIncludes(firstUseKeyWarning("src/app.ts"), "src/app.ts");
});

Deno.test("am create: a new app has every switch decided — no harden hint", () => {
  assert(TEMPLATES.length > 1, "no templates to check");
  for (const tpl of TEMPLATES) {
    for (const target of ["browser", "electron", "server"] as const) {
      const files = scaffold("demo", tpl, true, target);
      const cfg = JSON.parse(files["deno.json"]!);
      // The fan-out its own deno.json comment suggests.
      cfg.build.targets = ["server", "electron", "electron-client"];
      if (tpl === "cli") continue; // no window: the fleet above is not its
      assertEquals(keys(cfg, files["src/app.ts"]!), [], `${tpl}/${target}`);
    }
  }
});

Deno.test("am doctor / am fix: an existing app is told, never changed — and `am fix --harden` writes only what it says", async () => {
  const dir = await tempDir("aio-harden-");
  try {
    const cfgPath = join(dir, "deno.json");
    const entryPath = join(dir, "src", "app.ts");
    const cfgText = JSON.stringify(
      {
        title: "old-app",
        client: "electron",
        build: { targets: ["electron", "electron-client"], out: "dist" },
      },
      null,
      2,
    ) + "\n";
    const entryText =
      "declare const aio: { run(c: unknown): Promise<void> };\n" +
      "await aio.run({ cells: [] });\n";
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(cfgPath, cfgText);
    await Deno.writeTextFile(entryPath, entryText);
    const unchanged = async (what: string) => {
      assertEquals(await Deno.readTextFile(cfgPath), cfgText, what);
      assertEquals(await Deno.readTextFile(entryPath), entryText, what);
    };
    assertEquals(
      (await hardenFindingsFor(dir)).map((f) => f.key),
      ["build.strictPin", "electron.ignoreDebugEnv"],
    );

    const am = new URL("../src/am.ts", import.meta.url).href;
    const run = async (...args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", am, ...args],
        cwd: dir,
        env: { AIO_APPS_DIR: join(dir, "home"), NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: o.code, out: new TextDecoder().decode(o.stdout) };
    };
    type Row = { name: string; outcome: string; note: string };
    const rows = (o: string) =>
      (JSON.parse(o).results as Row[]).filter((r) =>
        r.name.startsWith("harden")
      );

    // doctor: both doors named, exit 0, `ok` — a hint is not a finding.
    const doctor = await run("doctor", "--json");
    assertEquals(doctor.code, 0, doctor.out);
    const d = JSON.parse(doctor.out) as { ok: boolean; hints: string[] };
    assertEquals(d.ok, true);
    assert(d.hints.some((h) => h.includes(`"build": { "strictPin": true }`)));
    assert(
      d.hints.some((h) => h.includes("electron: { ignoreDebugEnv: true }")),
    );
    assert(d.hints.some((h) => h.includes("`am fix --harden` writes it")));
    await unchanged("am doctor wrote something");

    // am fix, as every existing app runs it: says nothing, sets nothing.
    const plain = await run("fix", "--no-download", "--json");
    assertEquals(rows(plain.out), [], plain.out);
    const afterPlain = JSON.parse(await Deno.readTextFile(cfgPath));
    assertEquals("strictPin" in afterPlain.build, false, "am fix hardened");
    assertEquals(await Deno.readTextFile(entryPath), entryText);
    const cfgNow = await Deno.readTextFile(cfgPath);

    // --harden --dry-run: reported with the exact text, nothing written.
    const dry = await run(
      "fix",
      "--harden",
      "--dry-run",
      "--no-download",
      "--json",
    );
    const dryRows = rows(dry.out);
    assertEquals(
      dryRows.map((r) => [r.name, r.outcome]),
      [
        ["harden: build.strictPin", "would-fix"],
        ["harden: electron.ignoreDebugEnv", "advise"],
      ],
      dry.out,
    );
    assertStringIncludes(
      dryRows[0]!.note,
      `writes "build": { "strictPin": true } to deno.json`,
    );
    assertStringIncludes(
      dryRows[1]!.note,
      "add electron: { ignoreDebugEnv: true } to aio.run() in src/app.ts",
    );
    assertEquals(await Deno.readTextFile(cfgPath), cfgNow, "a dry run wrote");

    // --harden: the deno.json key, and only it; the entry is the author's.
    const done = await run("fix", "--harden", "--no-download", "--json");
    assertEquals(rows(done.out)[0]!.outcome, "fixed", done.out);
    const after = JSON.parse(await Deno.readTextFile(cfgPath));
    assertEquals(after.build, {
      ...JSON.parse(cfgNow).build,
      strictPin: true,
    });
    assertEquals(await Deno.readTextFile(entryPath), entryText);
    assertEquals(
      (await hardenFindingsFor(dir)).map((f) => f.key),
      ["electron.ignoreDebugEnv"],
    );
  } finally {
    await dropTempDir(dir);
  }
});

// `build.android.strict`: an app that overlays its own MainActivity.kt is
// only WARNED when the overlay drops what the template's activity does. The
// key that fails the build instead is opt-in — named by `am doctor`, written
// by `am fix --harden`, and never claimed for an app with no such file.
Deno.test("am doctor / am fix --harden: an app with its own MainActivity.kt and no build.android.strict is told the key, and --harden writes it beside what build.android already holds", async () => {
  const cfg = { title: "own-activity", build: { targets: ["android"] } };
  assertEquals(
    hardenFindings(cfg, ["android"], null, true).map((f) => f.key),
    ["build.android.strict"],
  );
  // Decided either way, or no overlay: nothing.
  for (const strict of [true, false]) {
    const build = { ...cfg.build, android: { strict } };
    assertEquals(hardenFindings({ ...cfg, build }, [], null, true), []);
  }
  assertEquals(hardenFindings(cfg, ["android"], null), []);

  const dir = await tempDir("aio-harden-android-");
  try {
    const cfgPath = join(dir, "deno.json");
    const build = { targets: ["android"], android: { other: 1 } };
    await Deno.writeTextFile(
      cfgPath,
      JSON.stringify({ ...cfg, build, android: { colorScheme: "dark" } }),
    );
    assertEquals(await hardenFindingsFor(dir), []);
    await Deno.mkdir(join(dir, OWN_ACTIVITY, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, OWN_ACTIVITY), "package aio.app\n");
    const [finding, ...rest] = await hardenFindingsFor(dir);
    assertEquals([finding!.key, finding!.file, rest.length], [
      "build.android.strict",
      "deno.json",
      0,
    ]);
    assertStringIncludes(finding!.hint, "only WARNS");
    assertStringIncludes(finding!.hint, finding!.write);

    const am = new URL("../src/am.ts", import.meta.url).href;
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", am, "fix", "--harden", "--no-download", "--json"],
      cwd: dir,
      env: { AIO_APPS_DIR: join(dir, "home"), NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(o.stdout);
    const row = (JSON.parse(out).results as { name: string; outcome: string }[])
      .find((r) => r.name === "harden: build.android.strict");
    assertEquals(row?.outcome, "fixed", out);
    assertEquals(JSON.parse(await Deno.readTextFile(cfgPath)).build, {
      targets: ["android"],
      android: { other: 1, strict: true },
    });
    assertEquals(await hardenFindingsFor(dir), []);
  } finally {
    await dropTempDir(dir);
  }
});

// The same shape for a LOOK: an Android build with no `android.colorScheme`
// keeps the dark theme every APK had through 1.0.19, and the app is told the
// key that follows the phone — a hint, and `am fix --harden` never writes it.
Deno.test("am doctor: an app with an android target and no android.colorScheme is told the key — and only that app", async () => {
  const hint = (cfg: Record<string, unknown>) =>
    androidColorSchemeHint(cfg, declaredTargets(cfg));
  for (
    const cfg of [
      { build: { targets: ["browser", "android"] } },
      { build: { targets: ["android-client"] } },
      { client: "android" },
      { build: { targets: ["android"] }, android: { camera: true } },
    ]
  ) {
    const h = hint(cfg);
    assert(h, JSON.stringify(cfg));
    assertStringIncludes(h, `"android": { "colorScheme": "system" }`);
    assertStringIncludes(h, "1.0.19");
  }
  // No android target; or the app has decided — either way.
  assertEquals(hint({ build: { targets: ["browser", "electron"] } }), null);
  for (const colorScheme of ["system", "dark", "light"]) {
    assertEquals(
      hint({ build: { targets: ["android"] }, android: { colorScheme } }),
      null,
    );
  }

  // Through `am doctor` itself: said, exit 0, `ok`, nothing written — and
  // `am fix --harden` leaves the look alone.
  const dir = await tempDir("aio-doctor-scheme-");
  try {
    const cfgPath = join(dir, "deno.json");
    const cfgText = JSON.stringify(
      { title: "old-app", client: "browser", build: { targets: ["android"] } },
      null,
      2,
    ) + "\n";
    await Deno.writeTextFile(cfgPath, cfgText);
    const am = new URL("../src/am.ts", import.meta.url).href;
    const run = async (...args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", am, ...args],
        cwd: dir,
        env: { AIO_APPS_DIR: join(dir, "home"), NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: o.code, out: new TextDecoder().decode(o.stdout) };
    };
    const doctor = await run("doctor", "--json");
    assertEquals(doctor.code, 0, doctor.out);
    const d = JSON.parse(doctor.out) as { ok: boolean; hints: string[] };
    assertEquals(d.ok, true);
    assertEquals(
      d.hints.filter((h) => h.includes("android.colorScheme")).length,
      1,
      doctor.out,
    );
    await run("fix", "--harden", "--no-download", "--json");
    assertEquals(
      "android" in JSON.parse(await Deno.readTextFile(cfgPath)),
      false,
      "am fix --harden changed how the app looks",
    );
  } finally {
    await dropTempDir(dir);
  }
});

// A fix that ships as an opt-in reaches an app only when somebody tells it:
// a field report listed five of its own asks as "still open" two releases
// after they were built. `am doctor` names the three an app's own files show
// it is not using — hints, like every line above.
Deno.test("shippedHelpHints: an app is told about the help it does not use — and stops being told once it decides", () => {
  const targets = ["electron"];
  const none = shippedHelpHints({ build: { targets } }, targets, [
    { path: "src/app.ts", code: "await aio.run({ cells });" },
  ]);
  assertEquals(none, [], "nothing in this app asks for any of it");

  // A package that carries files a build can leave out, never started.
  const carried = { build: { targets, guestPreloads: ["dapp/preload.cjs"] } };
  const [smoke] = shippedHelpHints(carried, targets, []);
  assertStringIncludes(smoke!, `"smoke": true`);
  assertEquals(
    shippedHelpHints(
      { compile: { include: ["data/x.json"] }, build: { targets } },
      targets,
      [],
    ).length,
    1,
  );
  for (const decided of [true, false, "strict"]) {
    assertEquals(
      shippedHelpHints(
        { build: { ...carried.build, smoke: decided } },
        targets,
        [],
      ),
      [],
      `smoke: ${decided} is a decision`,
    );
  }
  // No build target: nothing is built, nothing to start.
  assertEquals(shippedHelpHints(carried, [], []), []);

  // A worker cell that would stay dead, and a hand-written VACUUM INTO.
  const src = (code: string, path = "src/hw.ts") => [{ path, code }];
  const [dead] = shippedHelpHints(
    {},
    [],
    src(`cell("hw", { worker: true, state: {} })`),
  );
  assertStringIncludes(dead!, "workerRespawn: true");
  assertStringIncludes(dead!, "src/hw.ts");
  for (
    const decided of [
      `cell("hw", { worker: true, workerRespawn: true })`,
      `cell("hw", { worker: true, workerRespawn: false })`,
      `// worker: true — one day\ncell("hw", { state: {} })`,
      `cell("hw", { worker: false })`,
    ]
  ) assertEquals(shippedHelpHints({}, [], src(decided)), [], decided);
  const [raw] = shippedHelpHints(
    {},
    [],
    src("await db.exec(`vacuum  into '${p}'`)", "src/backup.ts"),
  );
  assertStringIncludes(raw!, "db.snapshot(target)");
  assertStringIncludes(raw!, "src/backup.ts");
  assertEquals(
    shippedHelpHints({}, [], src("// never VACUUM INTO by hand\n")),
    [],
  );
  // Many files are named three at a time.
  const many = shippedHelpHints(
    {},
    [],
    ["a", "b", "c", "d", "e"].map((n) => ({
      path: `src/${n}.ts`,
      code: "x({ worker: true })",
    })),
  )[0]!;
  assertStringIncludes(many, "src/c.ts and 2 more");
});

Deno.test("shippedHelpHints: a new app is told nothing, and `am doctor` reads an existing app's own src/", async () => {
  assert(TEMPLATES.length > 0, "there are templates to scaffold");
  for (const tpl of TEMPLATES) {
    for (const target of ["browser", "electron", "server"] as const) {
      const files = scaffold("demo", tpl, true, target);
      const cfg = JSON.parse(files["deno.json"]!);
      const sources = Object.entries(files)
        .filter(([p]) => p.startsWith("src/"))
        .map(([path, code]) => ({ path, code }));
      assertEquals(
        shippedHelpHints(cfg, declaredTargets(cfg), sources),
        [],
        `${tpl}/${target}`,
      );
    }
  }
  const dir = await tempDir("aio-shipped-help-");
  try {
    await Deno.mkdir(join(dir, "src", "hw"), { recursive: true });
    await Deno.mkdir(join(dir, "src", "node_modules", "x"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ entry: "src/app.ts" }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "aio.run({});\n");
    await Deno.writeTextFile(
      join(dir, "src", "hw", "cell.ts"),
      `cell("hw", { worker: true });\n`,
    );
    // A dependency's code is not the app's.
    await Deno.writeTextFile(
      join(dir, "src", "node_modules", "x", "i.ts"),
      `cell("dep", { worker: true });\nVACUUM INTO`,
    );
    const hints = await shippedHelpHintsFor(dir);
    assertEquals(hints.length, 1);
    assertStringIncludes(hints[0]!, "(src/hw/cell.ts)");
  } finally {
    await dropTempDir(dir);
  }
});
