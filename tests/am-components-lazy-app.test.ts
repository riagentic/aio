// A multi-component project must not refuse the commands that act on NO app
// or on the WHOLE project.
//
// `am` bound the target app's data home BEFORE dispatching any command —
// `adoptRunningHome(resolveAmAppId(flags.app))` in src/am.ts — and in a
// project whose `build.targets` declares 2+ components `resolveAmAppId()`
// with no `--app` refuses and exits. So EVERY command was refused (remote-desktop
// report §2): `am help`, `am --version`, and the project-wide `am stop` /
// `am status` / `am start` that the refusal message itself recommends as the
// way out. The id is now resolved only where ONE app is meant; a single-app
// verb with no `--app` is still refused, with the named fix.
//
// Sandbox: HOME, AIO_APPS_DIR, AIO_INSTALL_ROOT, DENO_INSTALL_ROOT,
// XDG_RUNTIME_DIR in one temp dir, the environment cleared,
// GIT_CEILING_DIRECTORIES at the temp root.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const ENTRY = (appId: string) =>
  `import { aio } from "aio";\nawait aio.run({ appId: "${appId}", cells: [] });\n`;

async function denoDirOf(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir as string;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function withProject(
  fn: (am: (...a: string[]) => Promise<Run>) => Promise<void>,
) {
  const base = await tempDir("aio-am-lazy-app-");
  try {
    const proj = join(base, "proj");
    const home = join(base, "home");
    for (
      const d of [
        join(proj, "src"),
        home,
        join(base, "apps"),
        join(base, "run"),
      ]
    ) {
      await Deno.mkdir(d, { recursive: true, mode: 0o700 });
    }
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({
        name: "lazy-app",
        title: "lazy-app",
        build: {
          targets: {
            server: { entry: "src/server.ts", target: "server" },
            agent: { entry: "src/agent.ts", target: "server" },
          },
        },
      }),
    );
    await Deno.writeTextFile(join(proj, "src/server.ts"), ENTRY("lz-server"));
    await Deno.writeTextFile(join(proj, "src/agent.ts"), ENTRY("lz-agent"));
    const denoDir = await denoDirOf();
    const env: Record<string, string> = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      DENO_DIR: denoDir,
      HOME: home,
      AIO_APPS_DIR: join(base, "apps"),
      AIO_INSTALL_ROOT: join(home, "app"),
      DENO_INSTALL_ROOT: join(home, ".deno"),
      XDG_RUNTIME_DIR: join(base, "run"),
      GIT_CEILING_DIRECTORIES: base,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    };
    await fn(async (...a) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, AM, ...a],
        cwd: proj,
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return { code: o.code, out: d.decode(o.stdout), err: d.decode(o.stderr) };
    });
  } finally {
    await dropTempDir(base);
  }
}

const REFUSAL = "several components";

Deno.test("am components: help, --version and project-wide verbs are not refused for want of --app", async () => {
  await withProject(async (am) => {
    for (
      const argv of [
        ["help"],
        ["help", "stop"],
        ["stop", "--help"],
        // help binds no home, so a --profile beside it is not "which app?"
        ["stop", "--help", "--profile=dev"],
      ]
    ) {
      const r = await am(...argv);
      const said = r.out + r.err;
      assertEquals(r.code, 0, `am ${argv.join(" ")} → ${r.code}: ${said}`);
      assert(!said.includes(REFUSAL), `am ${argv.join(" ")} refused: ${said}`);
      assertStringIncludes(said, "stop");
    }
    const v = await am("--version");
    assertEquals(v.code, 0, `am --version → ${v.code}: ${v.out}${v.err}`);
    assert(/\d+\.\d+\.\d+/.test(v.out + v.err), v.out + v.err);

    // Project-wide status: both components listed, exit 1 (= all stopped,
    // the documented contract), never the refusal.
    const s = await am("status", "--json");
    assert(!(s.out + s.err).includes(REFUSAL), s.out + s.err);
    assertEquals(s.code, 1, s.out + s.err);
    const doc = JSON.parse(s.out) as {
      components: { component: string; status: string }[];
    };
    assertEquals(
      doc.components.map((c) => `${c.component}:${c.status}`).sort(),
      ["agent:stopped", "server:stopped"],
    );

    // Project-wide stop with nothing running: not the refusal.
    for (const argv of [["stop"], ["stop", "--all"]]) {
      const st = await am(...argv, "--json");
      assert(!(st.out + st.err).includes(REFUSAL), st.out + st.err);
      assertEquals(st.code, 0, st.out + st.err);
      assertEquals(JSON.parse(st.out).status, "none-running", st.out);
    }
  });
});

Deno.test("am components: a single-app verb without --app is refused with the named fix", async () => {
  await withProject(async (am) => {
    const r = await am("state", "--json");
    assertEquals(r.code, 1, r.out + r.err);
    const doc = JSON.parse(r.out) as { error: string };
    assertStringIncludes(doc.error, REFUSAL);
    // EVERY component's spelling, and every project-wide verb.
    assertStringIncludes(doc.error, "--app=server | --app=agent");
    assertStringIncludes(doc.error, "am restart");
    // Naming the component resolves it — the refusal is gone.
    const named = await am("state", "--app=agent", "--json");
    assert(!(named.out + named.err).includes(REFUSAL), named.out + named.err);
    // A --profile targets ONE app: without --app it is refused too.
    const p = await am("status", "--profile=dev", "--json");
    assertEquals(p.code, 1, p.out + p.err);
    assertStringIncludes(p.out + p.err, REFUSAL);
  });
});

// `--profile` / `--home` bound the target home through `resolveAmAppId()`
// BEFORE the lazy check, so `am stop --profile=dev` in a component project was
// refused with a message recommending `am stop | am status` — the very
// commands refused. A profile is ONE app's instance: the refusal names
// `--app=<component>` and no project-wide verb, and a component named
// positionally (`am stop agent --profile=dev`) is that one app.
Deno.test("am components: --profile/--home without a component is refused with --app=<component>, never with the refused verb", async () => {
  await withProject(async (am) => {
    for (
      const argv of [
        ["stop", "--profile=dev"],
        ["status", "--profile=dev"],
        ["start", "--profile=dev"],
        ["restart", "--profile=dev"],
        ["stop", "--home=/nonexistent-aio-home"],
        ["state", "--profile=dev"],
      ]
    ) {
      const r = await am(...argv, "--json");
      const said = r.out + r.err;
      assertEquals(r.code, 1, `am ${argv.join(" ")}: ${said}`);
      const { error } = JSON.parse(r.out) as { error: string };
      assertStringIncludes(error, REFUSAL);
      assertStringIncludes(error, `--app=server ${argv[1]}`);
      assert(
        !/\bam (start|stop|status|restart)\b/.test(error),
        `am ${argv.join(" ")} recommends a refused verb: ${error}`,
      );
    }
    // Named — by --app or positionally — it is one app: not refused.
    for (
      const argv of [
        ["status", "--app=agent", "--profile=dev"],
        ["status", "agent", "--profile=dev"],
      ]
    ) {
      const r = await am(...argv, "--json");
      const said = r.out + r.err;
      assert(!said.includes(REFUSAL), `am ${argv.join(" ")}: ${said}`);
      assertEquals(JSON.parse(r.out).appId, "lz-agent", said);
      assertEquals(JSON.parse(r.out).status, "stopped", said);
    }
  });
});

// A project-wide start ends at the first component that fails (`cmdStart`
// refuses by exiting). It said only that component's error: which parts were
// up and which were never tried went unsaid — a project half up, reported as
// one error. The fixture's entries cannot boot (no "aio" import map), so the
// first component fails.
Deno.test("am components: a failed project start names the component that failed and the ones never tried", async () => {
  await withProject(async (am) => {
    const r = await am("start", "--client=server-only", "--json");
    assertEquals(r.code, 1, r.out + r.err);
    assertStringIncludes(r.err, 'start failed at "server"');
    assertStringIncludes(r.err, "not attempted: agent");
  });
});
