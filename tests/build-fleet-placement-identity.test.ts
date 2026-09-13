// What the fleet places in dist/, and what it says about it afterwards.
//
// Three defects in one step — placement — each of which built green:
//
// 1. CLIENTS LABELLED TWICE. Targets were grouped for suffixing by the app's
//    binary name alone, so `["server", "cli-client"]` counted the client as a
//    collision with the server it dials, and placed
//    `spapp-0.1.2-client-cli-client` where docs/build/versioning.md promises
//    `spapp-0.1.2-client` (android: `…-client-android-client.apk`).
// 2. INSTALL STEPS NAMING FILES THAT DO NOT EXIST. The single-target build
//    printed `sudo cp spapp /usr/local/bin/spapp` and wrote the same into the
//    unit — then the fleet renamed both to `spapp-<version>…`. Copied as
//    printed, the unit also installed as `spapp-<version>.service`, and the
//    `systemctl enable --now spapp` after it found nothing.
// 3. TWO APPS, ONE IDENTITY. A per-target `name` renames the binary, not the
//    app: a compiled binary resolves its identity from its embedded deno.json,
//    and every target embeds the same one. The `relay` of a two-app repo ran
//    as `spapp` — "[AIO] Already running: spapp", one shared data directory —
//    and nothing at build time said so.
//
// The builder is stubbed (`--build-spec`): the contract under test is what the
// orchestrator does with the artifacts. The stub's binaries answer `--version`
// the way a compiled aio app does — `<appId> <version> (aio …)`.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { buildAll } from "../src/build-all.ts";

const STUB = `
const root = Deno.cwd();
const arg = (f) => Deno.args.find((a) => a.startsWith(f))?.slice(f.length);
const has = (f) => Deno.args.includes(f);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "myapp";
const bin = slug(arg("--name="));
// Identity the way the runtime resolves it: an explicit appId in the entry,
// else the embedded deno.json's title — the SAME for every target.
const entry = arg("--entry=") ?? "src/app.ts";
const src = await Deno.readTextFile(root + "/" + entry).catch(() => "");
const id = src.match(/appId: "([^"]+)"/)?.[1] ??
  slug(JSON.parse(await Deno.readTextFile(root + "/deno.json")).title);
const exe = async (name) => {
  await Deno.writeTextFile(root + "/" + name,
    "#!/bin/sh\\necho '" + id + " 0.1.0 (aio 1.0.0-beta)'\\n");
  await Deno.chmod(root + "/" + name, 0o755);
};
if (has("--android")) {
  await Deno.writeTextFile(root + "/" + bin + (has("--remote") ? "-client" : "") + ".apk", "apk");
} else if (has("--cli") && has("--remote")) {
  await exe(bin + "-client");
} else {
  await exe(bin);
  if (has("--service")) {
    await Deno.writeTextFile(root + "/" + bin + ".service",
      "# Adjust the path after install (sudo cp " + bin + " /usr/local/bin/" + bin + ").\\n" +
      "ExecStart=/usr/local/bin/" + bin + "\\n");
  }
}
`;

type Run = {
  code: number;
  dist: string[];
  out: string;
  read: (f: string) => Promise<string>;
};

async function fleet(
  denoJson: Record<string, unknown>,
  files: Record<string, string>,
  body: (r: Run) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-fleet-place-" });
  const stub = join(dir, "stub-build.ts");
  await Deno.writeTextFile(stub, STUB);
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson));
  for (const [f, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, f, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, f), text);
  }
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  const origArgs = Deno.args;
  const origCwd = Deno.cwd();
  Object.defineProperty(Deno, "args", {
    value: [`--build-spec=${stub}`],
    configurable: true,
  });
  Deno.chdir(dir);
  console.log = console.warn = console.error = push;
  try {
    const code = await buildAll();
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    const dist: string[] = [];
    for await (const e of Deno.readDir(join(dir, "dist"))) dist.push(e.name);
    await body({
      code,
      dist: dist.sort(),
      // deno-lint-ignore no-control-regex
      out: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""),
      read: (f) => Deno.readTextFile(join(dir, "dist", f)),
    });
  } finally {
    Object.assign(console, orig);
    Deno.chdir(origCwd);
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("fleet: a client's artifact is not labelled twice", async () => {
  await fleet(
    {
      title: "spapp",
      build: { targets: ["server", "cli-client", "android-client"] },
    },
    { "src/app.ts": "export {};\n" },
    async ({ code, dist, out }) => {
      assertEquals(code, 0, out);
      assert(
        !dist.some((f) => /-client-(cli|android)-client/.test(f)),
        `${dist}`,
      );
      assert(dist.some((f) => /^spapp-.+-client$/.test(f)), `${dist}`);
      assert(dist.some((f) => /^spapp-.+-client\.apk$/.test(f)), `${dist}`);
    },
  );
});

Deno.test("fleet: targets that DO write the same file are still labelled", async () => {
  await fleet(
    { title: "spapp", build: { targets: ["browser", "server"] } },
    { "src/app.ts": "export {};\n" },
    async ({ code, dist, out }) => {
      assertEquals(code, 0, out);
      const bins = dist.filter((f) =>
        f.startsWith("spapp-") && !f.endsWith(".service")
      );
      assertEquals(bins.length, 2, `${dist}`);
      assertEquals(
        bins.filter((f) => f.endsWith("-server")).length,
        1,
        `${dist}`,
      );
    },
  );
});

Deno.test("fleet: the service install steps and the unit name the PLACED files", async () => {
  await fleet(
    { title: "spapp", build: { targets: ["server"] } },
    { "src/app.ts": "export {};\n" },
    async ({ code, dist, out, read }) => {
      assertEquals(code, 0, out);
      const unit = dist.find((f) => f.endsWith(".service"))!;
      const bin = dist.find((f) => f !== unit && f !== "manifest.json")!;
      assertMatch(bin, /^spapp-/);
      assert(
        (await read(unit)).includes(`(sudo cp ${bin} /usr/local/bin/spapp)`),
        await read(unit),
      );
      assert(out.includes(`sudo cp dist/${bin} /usr/local/bin/spapp`), out);
      assert(
        out.includes(`sudo cp dist/${unit} /etc/systemd/system/spapp.service`),
        out,
      );
      assert(out.includes("sudo systemctl enable --now spapp"), out);
    },
  );
});

Deno.test("fleet: two differently named apps that resolve ONE appId are named, loudly", async () => {
  await fleet(
    {
      title: "spapp",
      build: {
        targets: {
          server: { name: "relay", entry: "src/relay/app.ts" },
          browser: {},
        },
      },
    },
    { "src/app.ts": "export {};\n", "src/relay/app.ts": "export {};\n" },
    async ({ code, out }) => {
      assertEquals(code, 0, out);
      assertMatch(
        out,
        /relay \(server\) and spapp \(browser\)|spapp \(browser\) and relay \(server\)/,
      );
      assert(out.includes(`appId "spapp"`), out);
      assert(out.includes("aio.run({ appId"), out);
    },
  );
});

Deno.test("fleet: an entry with its own appId is its own app — no warning", async () => {
  await fleet(
    {
      title: "spapp",
      build: {
        targets: {
          server: { name: "relay", entry: "src/relay/app.ts" },
          browser: {},
        },
      },
    },
    {
      "src/app.ts": "export {};\n",
      "src/relay/app.ts": 'aio.run({ appId: "relay" });\n',
    },
    async ({ code, out }) => {
      assertEquals(code, 0, out);
      assert(!out.includes("different apps that all run as appId"), out);
    },
  );
});

Deno.test("--print-app-tmpdir: a --name renames the binary, not the directory the app runs in", async () => {
  // The launcher asks this instead of re-deriving identity in shell. It
  // answered with the BINARY name, while the binary resolves its embedded
  // deno.json first — so `--name=relay` in a project titled `spapp` pointed
  // the launcher at `~/.relay` for an app that lives in `~/.spapp`.
  const dir = await Deno.makeTempDir({ prefix: "aio-print-tmpdir-" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), '{"title":"spapp"}');
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "export {};\n");
    const aioRoot = new URL("..", import.meta.url).pathname;
    const ask = async (extra: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `--config=${join(aioRoot, "deno.json")}`,
          join(aioRoot, "src", "build.ts"),
          "--print-app-tmpdir",
          ...extra,
        ],
        cwd: dir,
        env: { AIO_APPS_DIR: join(dir, "apps") },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return new TextDecoder().decode(r.stdout).trim();
    };
    const plain = await ask([]);
    assert(plain.length > 0, "no answer");
    assertEquals(await ask(["--name=relay"]), plain);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
