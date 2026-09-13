// A dev SERVER is dev: `__aioDev` is set in the process `deno run` boots.
//
// The browser shell stamped the flag, the worker host copied it and the test
// harness armed it — the dev server never did. So every server-side "dev
// throws / dev warns" gate ran as prod in `deno task dev`: a method storing
// `String(globalThis.__aioDev)` stored "undefined", and the retired spellings
// `cell({ ui })` and `aio.run({ appVersion })` logged and booted "started"
// although the alpha70 upgrade guide says dev refuses them.
//
// Real processes, real argv, nothing armed by hand — the harness sets the flag
// in THIS process, which is exactly why an in-process test could never see it
// missing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function project(appTs: string): Promise<string> {
  const dir = await tempDir("aio-devflag-");
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "devflag",
      version: "0.1",
      imports: {
        "aio": `${ROOT}mod.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "app.ts"), appTs);
  return dir;
}

async function boot(
  dir: string,
  extra: string[],
): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--no-lock",
      "src/app.ts",
      "--client=server-only",
      ...extra,
    ],
    cwd: dir,
    env: { AIO_APPS_DIR: join(dir, "apps"), NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr),
  };
}

// The app prints what a METHOD saw, then exits — the boot is over by then.
const PROBE_APP = `import { aio, cell } from "aio";
export const probe = cell("probe", {
  state: { flag: "" },
  methods: {
    look(s: { flag: string }) {
      s.flag = String((globalThis as Record<string, unknown>).__aioDev);
    },
  },
});
const app = await aio.run({ persist: false });
await (probe as unknown as { look: () => Promise<void> }).look();
console.log("METHOD_SAW=" + (probe as unknown as { flag: string }).flag);
await app.close();
Deno.exit(0);
`;

Deno.test({
  name:
    "dev server: a method sees __aioDev === true under `deno run`, and nothing under --prod",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await project(PROBE_APP);
    try {
      const dev = await boot(dir, []);
      assertEquals(dev.code, 0, dev.out);
      assertStringIncludes(dev.out, "METHOD_SAW=true");
      const prod = await boot(dir, ["--prod"]);
      assertEquals(prod.code, 0, prod.out);
      assertStringIncludes(prod.out, "METHOD_SAW=undefined");
    } finally {
      await dropTempDir(dir);
    }
  },
});

const RETIRED: [string, string, string][] = [
  [
    "cell({ ui })",
    `import { aio, cell } from "aio";
export const c = cell("r", { state: { a: 1, b: 2 }, ui: { exclude: ["b"] }, methods: {} } as never);
const app = await aio.run({ persist: false });
console.log("BOOTED");
await app.close();
Deno.exit(0);
`,
    "cell({ ui }) was removed in alpha70",
  ],
  [
    "aio.run({ appVersion })",
    `import { aio, cell } from "aio";
export const c = cell("r", { state: { a: 1 }, methods: {} });
const app = await aio.run({ persist: false, appVersion: "1.0" } as never);
console.log("BOOTED");
await app.close();
Deno.exit(0);
`,
    "aio.run({ appVersion }) was removed in alpha70",
  ],
];

for (const [spelling, src, line] of RETIRED) {
  Deno.test({
    name:
      `dev server: retired ${spelling} REFUSES under \`deno run\`; --prod logs it and boots`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const dir = await project(src);
      try {
        const dev = await boot(dir, []);
        assert(dev.code !== 0, `dev booted over ${spelling}:\n${dev.out}`);
        assertStringIncludes(dev.out, line);
        assert(!dev.out.includes("BOOTED"), dev.out);
        // Prod: the documented half of the split — logged, honoured, running.
        const prod = await boot(dir, ["--prod"]);
        assertEquals(prod.code, 0, prod.out);
        assertStringIncludes(prod.out, line);
        assertStringIncludes(prod.out, "BOOTED");
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}
