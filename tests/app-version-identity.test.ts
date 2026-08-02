// an app's VERSION is its own, in dev and in a binary.
//
// `appVersion` falls back to the app's deno.json `version`, which the docs and
// the scaffold both present as the zero-config path. That fallback read
// `<cwd>/deno.json`, so:
//   • run from anywhere but the project root → no version at all ("0.0.0");
//   • run from ANOTHER project's directory → it reported THAT project's
//     version as its own — the identity-adoption bug `resolveAppId` already
//     guards against one field over.
// The linter then had to demand an explicit `appVersion` in every app, which
// is what made a freshly scaffolded app fail `deno task lint`.
//
// Resolution is now relative to the entry module, and `deno compile` embeds
// deno.json, so the same lookup answers in both worlds.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const ENTRY =
  `const v = (globalThis as { __aio?: { appVersion?: string } }).__aio;
console.log(JSON.stringify({ version: v?.appVersion ?? null }));
`;

/** Boot a tiny app that prints the appVersion aio resolved for it. */
async function versionSeenBy(
  opts: { cwd: string; projectDir: string },
): Promise<string | undefined> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(opts.projectDir, "src", "app.ts")],
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  const line = out.split("\n").find((l) => l.startsWith('{"version"'));
  if (!line) {
    throw new Error(
      `probe app printed no version.\nstdout:\n${out}\nstderr:\n${
        new TextDecoder().decode(r.stderr)
      }`,
    );
  }
  return JSON.parse(line).version ?? undefined;
}

Deno.test("appVersion: resolved from the app's own deno.json, not the cwd's", async () => {
  const proj = await Deno.makeTempDir({ prefix: "aio-ver-app-" });
  const other = await Deno.makeTempDir({ prefix: "aio-ver-other-" });
  try {
    const aioRoot = new URL("..", import.meta.url).pathname;
    // A fresh identity per run — two apps sharing an appId contend for the
    // single-instance lock, which has nothing to do with what is under test.
    const appId = `ver-probe-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.mkdir(join(proj, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(proj, "deno.json"),
      JSON.stringify({
        title: appId,
        version: "4.5.6",
        imports: { aio: join(aioRoot, "mod.ts") },
      }),
    );
    await Deno.writeTextFile(
      join(proj, "src", "app.ts"),
      `import { aio, cell } from "aio";
cell("probe", { state: { n: 0 }, methods: { bump(s) { s.n++; } } });
await aio.run({ appId: "${appId}", persist: false, singleton: false, client: "server-only", port: ${freePort()} });
${ENTRY}
Deno.exit(0);
`,
    );
    // A DIFFERENT project, with a different version, as the launch directory.
    await Deno.writeTextFile(
      join(other, "deno.json"),
      JSON.stringify({ title: "someone-else", version: "9.9.9" }),
    );

    const fromRoot = await versionSeenBy({ cwd: proj, projectDir: proj });
    assertEquals(fromRoot, "4.5.6", "its own version, run from its own root");

    const fromElsewhere = await versionSeenBy({ cwd: other, projectDir: proj });
    assertEquals(
      fromElsewhere,
      "4.5.6",
      "still its own version — never the launch directory's",
    );
    assert(
      fromElsewhere !== "9.9.9",
      "must not adopt another project's identity",
    );
  } finally {
    await Deno.remove(proj, { recursive: true });
    await Deno.remove(other, { recursive: true });
  }
});
