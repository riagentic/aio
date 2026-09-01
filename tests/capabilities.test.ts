// least-privilege capability manifest (the structural half of
// `aio ship`): scan what the app actually uses and emit the minimal --allow-*
// set instead of -A.
import { assert, assertEquals } from "@std/assert";
import {
  _SCANNED_FS_APIS,
  AIO_BASELINE,
  type Capabilities,
  scanCapabilities,
} from "../src/build/capabilities.ts";
import { manifestReport, permissionFlags } from "../src/testing/internal.ts";

Deno.test("scanCapabilities: detects each category from real API usage", () => {
  const caps = scanCapabilities([
    { content: `const r = await fetch("https://api.x");` }, // net
    { content: `await Deno.readTextFile("./x");` }, // read
    { content: `await Deno.writeTextFile("./y", "z");` }, // write
    { content: `const lib = Deno.dlopen(path, {});` }, // ffi (USB/HID)
    { content: `const k = Deno.env.get("K");` }, // env
    { content: `new Deno.Command("ls");` }, // run
    { content: `Deno.hostname();` }, // sys
  ]);
  assertEquals(caps, {
    net: true,
    read: true,
    write: true,
    ffi: true,
    env: true,
    run: true,
    sys: true,
  });
});

Deno.test("scanCapabilities: a pure app still needs what AIO needs", () => {
  // This test used to assert `[]`, and it was pinning a bug. Scanning an app's
  // own sources answers "what does MY code need" — but the binary also
  // contains aio, which binds a socket, opens SQLite, writes logs and a lock,
  // and reads config from the environment. A scaffolded counter app touches
  // none of those APIs itself, so the manifest said
  // `least-privilege run flags: (none)`.
  //
  // MEASURED: `deno run src/app.ts` on a freshly scaffolded app with no flags
  // dies inside `immer` reading NODE_ENV, before aio prints a line, in a
  // dependency the user never wrote. Advice that produces an app which cannot
  // start is worse than no advice — and `runFlags` travels in the SIGNED
  // release manifest.
  const caps = scanCapabilities([
    { content: `export const add = (a: number, b: number) => a + b;` },
  ]);
  assertEquals(permissionFlags(caps), [
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
  ]);
  // …and never the escalations, which aio genuinely does without.
  assertEquals([caps.ffi, caps.run, caps.sys], [false, false, false]);
});

Deno.test("capabilities: the baseline is a FLOOR, and never -A", () => {
  // The floor must stay a floor: every baseline flag present whatever the app
  // does, and the three real escalations still earned rather than granted.
  for (const cap of ["net", "read", "write", "env"] as const) {
    assertEquals(AIO_BASELINE[cap], true, `${cap} is what aio itself needs`);
  }
  for (const cap of ["ffi", "run", "sys"] as const) {
    assertEquals(
      AIO_BASELINE[cap],
      false,
      `${cap} is an escalation an app must show it needs`,
    );
  }
  assert(
    !permissionFlags({ ...AIO_BASELINE }).includes("-A"),
    "the whole point is that it is never -A",
  );
});

Deno.test("scanCapabilities: a mention in a COMMENT does not grant a permission", () => {
  const caps = scanCapabilities([
    {
      content:
        `// this used to call Deno.dlopen and fetch(); now it doesn't\nexport const x = 1;`,
    },
  ]);
  assertEquals(caps.ffi, false);
  // `net` is baseline (aio binds a socket), so the comment grants nothing that
  // was not already true — what this pins is that a MENTION adds nothing: ffi
  // and run are not in the floor and stay off.
  assertEquals(caps.run, false);
});

Deno.test("permissionFlags: emits only the needed allow-flags, never -A", () => {
  const caps: Capabilities = {
    net: true,
    read: true,
    write: false,
    ffi: true,
    env: false,
    run: false,
    sys: false,
  };
  const flags = permissionFlags(caps);
  assertEquals(flags, ["--allow-net", "--allow-read", "--allow-ffi"]);
  assert(!flags.includes("-A"));
});

Deno.test("manifestReport: lists flags + the reason each was included", () => {
  const report = manifestReport(scanCapabilities([
    { content: `Deno.dlopen(p, {}); fetch("x");` },
  ]));
  assert(report.includes("--allow-ffi"));
  assert(report.includes("USB/HID"));
  assert(report.includes("--allow-net"));
  assert(report.includes("replaces -A"));
});

// ── the *Sync spellings, and the list that keeps them honest ─────────
//
// `\b` does not sit between `e` and `S`, so `readFile` never matched inside
// `readFileSync`: an app whose I/O is the sync spellings scanned to
// read:false/write:false and its signed manifest advertised `runFlags: []`.
// Following that advice launched a binary that died on PermissionDenied at its
// first file read — the manifest is the security artifact, so a too-narrow
// scan is a broken product, not a conservative one.
Deno.test("scanCapabilities: the *Sync spellings count — every scanned FS API, both ways", () => {
  for (const api of _SCANNED_FS_APIS) {
    for (const name of [api, `${api}Sync`]) {
      const caps = scanCapabilities([{ content: `Deno.${name}("./x");` }]);
      assert(
        caps.read || caps.write,
        `Deno.${name} must require a file permission — it scanned to none`,
      );
    }
  }
});

Deno.test("scanCapabilities: an app written entirely in *Sync APIs is not permission-free", () => {
  const caps = scanCapabilities([{
    content: `const cfg = Deno.readTextFileSync("./config.json");
Deno.mkdirSync("./out");
Deno.writeTextFileSync("./out/report.json", cfg);`,
  }]);
  assertEquals(caps.read, true);
  assertEquals(caps.write, true);
  // Read/write are baseline too now, so this asserts what it always meant: the
  // *Sync spellings are SEEN. The regression it guards (a manifest that
  // advertised `runFlags: []`) is dead twice over.
  assertEquals(permissionFlags(caps), [
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-env",
  ]);
});

// One decider: the exported list and the regexes that do the matching must name
// the same APIs. A name added to a regex but not the list (or the reverse) is
// how the two drift apart, and drift here is invisible until a shipped binary
// dies on a permission it was told it did not need.
Deno.test("capabilities: the scanned-API list and the read/write regexes agree", () => {
  const source = Deno.readTextFileSync(
    new URL("../src/build/capabilities.ts", import.meta.url),
  );
  const inRegex = new Set<string>();
  // The signals read `\bDeno\.(?:a|b|c)…` — pull the alternation apart.
  for (const m of source.matchAll(/Deno\\\.\(\?:([A-Za-z|]+)\)/g)) {
    for (const name of m[1]!.split("|")) inRegex.add(name);
  }
  // Only the FS categories are listed — net/sys names live in their own signals.
  const listed = new Set(_SCANNED_FS_APIS);
  for (const name of listed) {
    assert(
      inRegex.has(name),
      `_SCANNED_FS_APIS names ${name}, but no signal regex matches it`,
    );
  }
  const fsOnly = [...inRegex].filter((n) =>
    !["connect", "listen", "serve", "connectTls", "listenTls"].includes(n) &&
    ![
      "hostname",
      "osRelease",
      "systemMemoryInfo",
      "networkInterfaces",
      "loadavg",
      "osUptime",
      "uid",
      "gid",
    ].includes(n)
  );
  for (const name of fsOnly) {
    assert(
      listed.has(name),
      `a signal regex matches Deno.${name}, but _SCANNED_FS_APIS omits it — ` +
        `add it so the Sync-spelling guard above covers it too`,
    );
  }
});

// The gate that would have caught this: RUN an app with the flags we advertise.
//
// Three instances of one bug reached users before this existed — `updates:`
// forced into the net signal, the `*Sync` spellings, and a scaffolded app told
// it needed "(none)" — because every test asked what the SCANNER returned and
// none asked whether the answer works. `runFlags` is in the signed release
// manifest, so the advice travels.
Deno.test({
  name: "capabilities: an app RUNS with the flags the manifest advertises",
  sanitizeResources: false, // aio-ok: the child is killed below; Deno sees its pipes
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-caps-run-" });
    try {
      const root = new URL("..", import.meta.url).pathname;
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({
          name: "capsapp",
          version: "0.1.0",
          imports: { aio: `${root}mod.ts` },
        }),
      );
      // The app a scaffold produces: its own source touches no permissioned
      // API at all, which is exactly the case that scanned to nothing.
      await Deno.writeTextFile(
        `${dir}/app.ts`,
        `import { aio, cell } from "aio";\n` +
          `const c = cell("caps", { state: { n: 0 }, methods: { bump(s: { n: number }) { s.n++; } } });\n` +
          `await aio.run({ cells: [c], client: "server-only", libraryMode: true, appDir: ${
            JSON.stringify(dir + "/data")
          } });\n`,
      );
      const flags = permissionFlags(
        scanCapabilities([{
          content: await Deno.readTextFile(`${dir}/app.ts`),
        }]),
      );
      assert(
        flags.length > 0,
        "advice of '(none)' is what this test exists for",
      );
      const proc = new Deno.Command(Deno.execPath(), {
        args: ["run", ...flags, `${dir}/app.ts`, "--port=0"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      // Let it boot, then end it and read everything it said. A permission it
      // was told it did not need shows up as NotCapable — from anywhere in the
      // graph, including a dependency the app author never wrote (the real one
      // was `immer` reading NODE_ENV, before aio printed a line).
      const killer = setTimeout(() => {
        try {
          proc.kill();
        } catch { /* already gone */ }
      }, 8_000);
      const { stdout, stderr } = await proc.output();
      clearTimeout(killer);
      const out = new TextDecoder().decode(stderr) +
        new TextDecoder().decode(stdout);
      assert(
        !/NotCapable|Requires .* access/.test(out),
        `the advertised flags must actually run the app; got:\n${
          out.slice(0, 700)
        }`,
      );
      assert(
        /running \(/.test(out),
        `…and it must reach "running", not merely avoid a permission error; ` +
          `got:\n${out.slice(0, 700)}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
