// alpha52 "one vocabulary" — the consolidation contract, pinned:
//   • deno.json `client` is the key for the default shell; `target` still
//     works (deprecated) and boots with a one-time hint naming the rename.
//   • `am fix` rewrites `target` → `client` and `--migrate-tasks` converts a
//     pre-alpha52 task matrix — deleting only PRISTINE old-scaffold tasks,
//     never a user-customized one.
//   • `am add cell` generates code in the scaffold's current style, and it
//     compiles.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { legacyStandardTasks, standardTasks } from "../src/am/am-cmd-create.ts";
import {
  cmdFix,
  legacyTaskTables,
  migrateTasks,
} from "../src/am/am-cmd-fix.ts";
import { VERSION } from "../src/server/aio-cli.ts";

const AIO_ROOT = new URL("..", import.meta.url).pathname;

// ── migrateTasks (pure) ─────────────────────────────────────────────────────

Deno.test("migrateTasks: a pristine old scaffold collapses to the new set exactly", () => {
  const old = legacyStandardTasks(true, "browser");
  const expected = standardTasks(true, "browser");
  delete expected["install:electron"]; // browser app — electron-only task
  const m = migrateTasks(old, expected, legacyTaskTables());
  assertEquals(
    Object.keys(m.tasks).sort(),
    Object.keys(expected).sort(),
    "nothing but the new matrix survives a pristine migration",
  );
  // The retired matrix went via DELETE (recognized as scaffold output)…
  assert(m.deleted.includes("dev:browser"));
  assert(m.deleted.includes("compile:remote:service"));
  assert(m.deleted.includes("dev:remote:cli"));
  // …`compile` changed producer (per-target flags → fleet) and was rewritten…
  assert(m.rewritten.includes("compile"));
  assertEquals(m.tasks["compile"], expected["compile"]);
  // …the genuinely new tasks were added, and nothing needs manual review.
  assert(m.added.includes("check") && m.added.includes("fmt"));
  assertEquals(m.kept, []);
  assertEquals(m.renamed, []);
});

Deno.test("migrateTasks: customized tasks are NEVER deleted — kept (service→server renamed) and reported", () => {
  const old = legacyStandardTasks(true, "browser");
  // Three customizations: an old-matrix task with an edited command, a
  // service-named one, and the user's own task.
  old["compile:electron"] = "deno run -A my/own/build.ts --electron --signed";
  old["dev:service"] = "deno run -A src/app.ts --client=server-only --port=9";
  old["seed"] = "deno run -A scripts/seed.ts";
  const expected = standardTasks(true, "browser");
  delete expected["install:electron"];
  const m = migrateTasks(old, expected, legacyTaskTables());
  // The customized old-matrix task survives under its own name, flagged.
  assertEquals(
    m.tasks["compile:electron"],
    "deno run -A my/own/build.ts --electron --signed",
  );
  assert(m.kept.includes("compile:electron"));
  // The customized service task survives with the value intact, under the
  // one-vocabulary name.
  assertEquals(
    m.tasks["dev:server"],
    "deno run -A src/app.ts --client=server-only --port=9",
  );
  assertEquals(m.tasks["dev:service"], undefined);
  assert(m.renamed.some(([o, n]) => o === "dev:service" && n === "dev:server"));
  // The user's own task is untouched AND unreported — none of our business.
  assertEquals(m.tasks["seed"], "deno run -A scripts/seed.ts");
  assert(!m.kept.includes("seed"));
});

Deno.test("migrateTasks: pristine recognition survives an old JSR version pin", () => {
  // An app scaffolded at an older release pinned jsr:@riagentic/aio@<old>.
  // Byte-comparing against today's pin would misread every JSR app as
  // customized; only the pin is wildcarded.
  const oldScaffold = legacyStandardTasks(false, "browser");
  const aged: Record<string, string> = {};
  for (const [k, v] of Object.entries(oldScaffold)) {
    aged[k] = v.replaceAll(`@${VERSION}`, "@1.0.0-alpha30");
  }
  const expected = standardTasks(false, "browser");
  delete expected["install:electron"];
  const m = migrateTasks(aged, expected, legacyTaskTables());
  assert(m.deleted.includes("dev:browser"), "aged pin still reads as pristine");
  assertEquals(m.kept, []);
  // But an actually edited command does NOT read as pristine.
  const edited = { "dev:browser": aged["dev:browser"] + " --port=9000" };
  const m2 = migrateTasks(edited, expected, legacyTaskTables());
  assertEquals(m2.deleted, []);
  assert(m2.kept.includes("dev:browser"));
});

// ── cmdFix: --migrate-tasks + target→client on a real deno.json ─────────────

Deno.test("cmdFix --migrate-tasks: converts an old scaffold, keeps the customized task, renames target→client", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-migrate-" });
  try {
    const old = legacyStandardTasks(false, "browser");
    // Drop the electron tasks: their presence makes cmdFix (correctly) try a
    // real `deno install npm:electron`, which this test must not depend on.
    for (const k of Object.keys(old)) if (k.includes("electron")) delete old[k];
    old["compile:service"] = "deno run -A my-build.ts --custom"; // customized
    old["seed"] = "echo seed"; // the user's own
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
        target: "browser",
        build: { targets: ["browser"], platforms: ["host"], out: "dist" },
        tasks: old,
      }),
    );
    // The kept dev:client task makes the app electron-adjacent; satisfy the
    // "electron runtime installed" check so the test never hits the network.
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    Deno.chdir(dir);
    await cmdFix(["--migrate-tasks"], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      client?: string;
      target?: string;
      tasks: Record<string, string>;
    };
    // The key rename happened alongside the migration.
    assertEquals(cfg.client, "browser");
    assertEquals(cfg.target, undefined);
    // Pristine matrix gone; the diet present; the customization preserved
    // under the one-vocabulary name; the user's task untouched.
    assertEquals(cfg.tasks["dev:browser"], undefined);
    assertEquals(cfg.tasks["compile:remote:electron"], undefined);
    assert(cfg.tasks["check"] && cfg.tasks["fmt"] && cfg.tasks["build"]);
    assertStringIncludes(cfg.tasks["compile"]!, "--targets=browser");
    assertEquals(
      cfg.tasks["compile:server"],
      "deno run -A my-build.ts --custom",
    );
    assertEquals(cfg.tasks["compile:service"], undefined);
    assertEquals(cfg.tasks["seed"], "echo seed");

    // Idempotent: a second migration changes nothing.
    const before = await Deno.readTextFile(join(dir, "deno.json"));
    await cmdFix(["--migrate-tasks"], {});
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), before);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix: plain fix leaves old tasks alone and points at --migrate-tasks", async () => {
  const orig = Deno.cwd();
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const dir = await Deno.makeTempDir({ prefix: "am-oldvocab-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
        client: "browser",
        tasks: { "dev:service": "deno run -A src/app.ts --client=server-only" },
      }),
    );
    Deno.chdir(dir);
    await cmdFix([], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      tasks: Record<string, string>;
    };
    // Add-only: the old task survives a plain fix…
    assertEquals(
      cfg.tasks["dev:service"],
      "deno run -A src/app.ts --client=server-only",
    );
    // …and the report names the migration.
    assert(
      logs.some((l) => l.includes("--migrate-tasks")),
      `plain fix must suggest --migrate-tasks, got:\n${logs.join("\n")}`,
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── deno.json `client` / deprecated `target` at boot ────────────────────────

/** Run a probe that prints what _denoJsonTargetClient resolved, from a temp
 *  project whose deno.json carries `keys`. Returns { client, stderr }. */
async function probeClientKey(
  keys: Record<string, unknown>,
): Promise<{ client: string | null; output: string }> {
  const proj = await Deno.makeTempDir({ prefix: "aio-client-key-" });
  try {
    await Deno.mkdir(join(proj, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({ ...keys, imports: { aio: join(AIO_ROOT, "mod.ts") } }),
    );
    await Deno.writeTextFile(
      join(proj, "src", "probe.ts"),
      `import { _denoJsonTargetClient } from "${
        join(AIO_ROOT, "src/server/aio.ts")
      }";
console.log(JSON.stringify({ client: _denoJsonTargetClient() ?? null }));
`,
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(proj, "src", "probe.ts")],
      cwd: proj,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout);
    const stderr = new TextDecoder().decode(r.stderr);
    const line = out.split("\n").find((l) => l.startsWith("{"));
    if (!line) throw new Error(`probe printed nothing.\nstderr:\n${stderr}`);
    // The hint flows through the framework logger (stdout) — search both.
    return { client: JSON.parse(line).client, output: out + stderr };
  } finally {
    await Deno.remove(proj, { recursive: true }).catch(() => {});
  }
}

Deno.test("deno.json: `client` resolves the default shell, silently", async () => {
  const r = await probeClientKey({ client: "server" });
  assertEquals(r.client, "server-only");
  assert(
    !r.output.includes('"target" is now "client"'),
    "the new spelling must not hint",
  );
});

Deno.test("deno.json: deprecated `target` still resolves, with the rename hint", async () => {
  const r = await probeClientKey({ target: "cli" });
  assertEquals(r.client, "cli", "the old spelling must keep working");
  assertStringIncludes(
    r.output,
    '"target" is now "client"',
    "the deprecated spelling must fire the one-time hint",
  );
});

Deno.test("deno.json: `client` wins when both spellings are present — and SAYS so", async () => {
  const r = await probeClientKey({ client: "browser", target: "electron" });
  assertEquals(r.client, "browser");
  // Two spellings resolving silently is the two-decider trap — the warning
  // must name the winner.
  assertStringIncludes(r.output, '"client" wins');
});

// ── am add cell: the generated cell compiles ────────────────────────────────

Deno.test("am add cell: generates src/cell/<name>.ts in scaffold style, and it type-checks", async () => {
  const { cmdAdd } = await import("../src/am/am-cmd-meta.ts");
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-add-check-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: join(AIO_ROOT, "mod.ts") },
        // The scaffold's lib set — `am add` runs inside a scaffolded app.
        compilerOptions: {
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
      }),
    );
    Deno.chdir(dir);
    await cmdAdd(["cell", "stats"], { json: false } as never);
    const src = await Deno.readTextFile(join(dir, "src/cell/stats.ts"));
    // Current style: direct cell() with state+methods — no useAio/useCell.
    assertStringIncludes(src, 'cell("stats"');
    assert(!src.includes("useAio") && !src.includes("useCell"));
    const chk = await new Deno.Command("deno", {
      args: ["check", "src/cell/stats.ts"],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(
      chk.code,
      0,
      `generated cell does not compile:\n${
        new TextDecoder().decode(chk.stderr)
      }`,
    );
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── the migration must PRESERVE the fleet the retired tasks encoded ─────────
// Field report (Electron wallet, no `build` key): its four compile:* tasks
// were the only record of its targets. Deleting them without writing
// `build.targets` left `deno task build` with "no targets to build" and
// `compile` building a hardcoded browser — the app's own shape unreachable.

Deno.test("targetsFromLegacyTasks: one decider from task names to fleet targets", async () => {
  const { targetsFromLegacyTasks } = await import("../src/am/am-cmd-fix.ts");
  assertEquals(targetsFromLegacyTasks(["compile:electron"]), ["electron"]);
  assertEquals(targetsFromLegacyTasks(["compile:service"]), ["server"]);
  assertEquals(
    targetsFromLegacyTasks([
      "compile:browser",
      "compile:electron",
      "compile:cli",
      "compile:service",
      "dev", // not a legacy matrix name — encodes nothing
      "seed",
    ]),
    ["browser", "electron", "cli", "server"],
  );
  // The two-artifact remote task encodes BOTH sides it built.
  assertEquals(targetsFromLegacyTasks(["compile:remote:electron"]), [
    "server",
    "electron-client",
  ]);
});

Deno.test("cmdFix --migrate-tasks: derives build.targets from the tasks it deletes (the wallet case)", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-derive-" });
  try {
    const legacy = legacyStandardTasks(false, "electron");
    // The wallet shape: NO build key, no client/target key — the four pristine
    // compile tasks are the only record of what the app ships.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
        tasks: {
          dev: legacy["dev"],
          "compile:browser": legacy["compile:browser"],
          "compile:electron": legacy["compile:electron"],
          "compile:cli": legacy["compile:cli"],
          "compile:service": legacy["compile:service"],
        },
      }),
    );
    // Electron ships with this app — satisfy the runtime check so the test
    // never reaches for the network.
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    Deno.chdir(dir);
    await cmdFix(["--migrate-tasks"], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      build?: { targets?: string[] };
      tasks: Record<string, string>;
    };
    // The fleet the deleted tasks encoded is now DECLARED…
    const fleet = cfg.build?.targets ?? [];
    for (const t of ["browser", "electron", "cli", "server"]) {
      assert(fleet.includes(t), `derived build.targets must carry ${t}`);
    }
    // …and it RESOLVES: every derived name is a real fleet target, so
    // `deno task build` has targets to build (the exact failure shipped).
    const { normalizeTargets, TARGETS: FLEET } = await import(
      "../src/build-all.ts"
    );
    const resolved = normalizeTargets(cfg.build!.targets);
    assert(resolved.length > 0, "deno task build would say 'no targets'");
    for (const r of resolved) {
      assert(r.name in FLEET, `${r.name} is not a buildable fleet target`);
    }
    // `compile` points at the PRIMARY target — build.targets[0] — never a
    // hardcoded browser… (here the head is browser by task order, so assert
    // the coupling itself:)
    assertStringIncludes(cfg.tasks["compile"]!, `--targets=${fleet[0]}`);
    // …and the retired tasks are gone.
    assertEquals(cfg.tasks["compile:electron"], undefined);
    assertEquals(cfg.tasks["compile:service"], undefined);
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix --migrate-tasks: an electron-only app migrates to an electron-building compile", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-derive-el-" });
  try {
    const legacy = legacyStandardTasks(false, "electron");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
        tasks: { "compile:electron": legacy["compile:electron"] },
      }),
    );
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    Deno.chdir(dir);
    await cmdFix(["--migrate-tasks"], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      build?: { targets?: string[] };
      tasks: Record<string, string>;
    };
    assertEquals(cfg.build?.targets, ["electron"]);
    assertStringIncludes(
      cfg.tasks["compile"]!,
      "--targets=electron",
      "compile must build what the app IS, not a hardcoded browser",
    );
    assertStringIncludes(cfg.tasks["dev"]!, "--client=electron");
    assert(cfg.tasks["install:electron"], "electron's install task follows");
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix --migrate-tasks: an existing build.targets is authoritative — never derived over", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-derive-keep-" });
  try {
    const legacy = legacyStandardTasks(false, "browser");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
        client: "cli",
        build: { targets: ["cli"], out: "dist" },
        tasks: { "compile:electron": legacy["compile:electron"] },
      }),
    );
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    Deno.chdir(dir);
    await cmdFix(["--migrate-tasks"], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      build?: { targets?: string[]; out?: string };
      tasks: Record<string, string>;
    };
    assertEquals(cfg.build?.targets, ["cli"], "the author's fleet stands");
    assertEquals(cfg.build?.out, "dist");
    assertStringIncludes(cfg.tasks["compile"]!, "--targets=cli");
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cmdFix --migrate-tasks: install:electron is dropped when the fleet has no electron", async () => {
  const orig = Deno.cwd();
  const realLog = console.log;
  console.log = () => {};
  const dir = await Deno.makeTempDir({ prefix: "am-drop-el-" });
  try {
    const legacy = legacyStandardTasks(false, "browser");
    // A pure browser app that carries the old scaffold's electron RESIDUE:
    // the electron import mapping every old scaffold wrote, plus the
    // install:electron convenience. Neither makes it an electron app — and
    // install:electron counting as electron evidence was self-keeping.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          aio: `jsr:@riagentic/aio@${VERSION}`,
          electron: "npm:electron",
        },
        tasks: {
          dev: legacy["dev"],
          "compile:browser": legacy["compile:browser"],
          "install:electron": legacy["install:electron"],
        },
      }),
    );
    // Satisfy the runtime check (imports name electron) — never the network.
    await Deno.mkdir(join(dir, "node_modules", "electron"), {
      recursive: true,
    });
    Deno.chdir(dir);
    await cmdFix(["--migrate-tasks"], {});
    const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))) as {
      build?: { targets?: string[] };
      tasks: Record<string, string>;
    };
    assertEquals(cfg.build?.targets, ["browser"]);
    assertEquals(
      cfg.tasks["install:electron"],
      undefined,
      "matrix residue on a browser-only fleet must go with the matrix",
    );
    // A CUSTOMIZED install:electron is the user's — it must survive.
    const dir2 = await Deno.makeTempDir({ prefix: "am-drop-el2-" });
    try {
      await Deno.writeTextFile(
        join(dir2, "deno.json"),
        JSON.stringify({
          imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
          client: "browser",
          build: { targets: ["browser"] },
          tasks: { "install:electron": "deno install my-pinned-electron" },
        }),
      );
      Deno.chdir(dir2);
      await cmdFix(["--migrate-tasks"], {});
      const cfg2 = JSON.parse(
        await Deno.readTextFile(join(dir2, "deno.json")),
      ) as { tasks: Record<string, string> };
      assertEquals(
        cfg2.tasks["install:electron"],
        "deno install my-pinned-electron",
      );
    } finally {
      await Deno.remove(dir2, { recursive: true }).catch(() => {});
    }
  } finally {
    console.log = realLog;
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("aiol safe-fix: the target→client rename keeps the key's position", async () => {
  const { fixRenameTargetToClient } = await import("../aiol/fixes.ts");
  const dir = await Deno.makeTempDir({ prefix: "aiol-pos-" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify(
        { title: "x", target: "electron", version: "0.1.0", tasks: {} },
        null,
        2,
      ) + "\n",
    );
    assertEquals(await fixRenameTargetToClient(dir), true);
    const keys = Object.keys(
      JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))),
    );
    assertEquals(
      keys,
      ["title", "client", "version", "tasks"],
      "the renamed key must not sink to the end of the file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
