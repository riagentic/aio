// The least-privilege flag list is advice people FOLLOW. It is scanned for the
// compiled binary, which carries a pre-built bundle; `deno task dev` also
// transpiles, and esbuild transpiles by spawning its native binary. Running
// dev with exactly the printed list therefore died inside esbuild — and the
// server reported it as `Transpile failed … Check syntax` on an untouched
// scaffold. Both halves are pinned here: the advice says which artifact it
// describes, and the transpiler names its own unmet requirement.
import { assert, assertStringIncludes } from "@std/assert";
import { manifestReport, scanCapabilities } from "../src/build/capabilities.ts";
import { _explainTranspileFailure } from "../src/server/server-transpile.ts";

Deno.test("doctor manifest: the flag list says WHICH artifact it describes, and what dev needs on top", () => {
  const report = manifestReport(scanCapabilities([
    { content: `export const x = 1;` }, // a scaffold: no capability signals
  ]));
  assertStringIncludes(report, "compiled binary");
  assert(
    /--allow-run/.test(report),
    `dev's extra requirement must be stated — following this list verbatim ` +
      `is how a fresh scaffold died inside esbuild. Got:\n${report}`,
  );
  assertStringIncludes(report, "deno task dev");
  // An app that already needs --allow-run gets no redundant caveat.
  const spawner = manifestReport(scanCapabilities([
    { content: `new Deno.Command("ls");` },
  ]));
  assert(
    !spawner.includes("PLUS --allow-run"),
    `already granted — no caveat. Got:\n${spawner}`,
  );
});

Deno.test("transpile: a failure with no --allow-run is named, not blamed on syntax", async () => {
  // A subprocess is the only honest way to observe this: the test runner has
  // -A, so the relabel path is unreachable in-process.
  const dir = await Deno.makeTempDir({ prefix: "aio-transpile-perm-" });
  try {
    const repo = new URL("../", import.meta.url).pathname;
    const script = `${dir}/probe.ts`;
    await Deno.writeTextFile(
      script,
      `import { transpile } from "${repo}src/server/server-transpile.ts";
try {
  await transpile("export const x: number = 1;", "/x/a.ts");
  console.log("NO-ERROR");
} catch (e) {
  console.log("ERR:" + (e instanceof Error ? e.message : String(e)));
}
`,
    );
    // Exactly the flags the manifest prints for a scaffolded app — plus the
    // reads/env esbuild's own module needs, and NO --allow-run.
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        // the repo's own import map — the probe imports aio internals
        "--config",
        `${repo}deno.json`,
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        script,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assert(
      !text.includes("NO-ERROR"),
      `esbuild cannot transpile without --allow-run; if it now can, this ` +
        `guard is obsolete. Got:\n${text}`,
    );
    assertStringIncludes(text, "needs --allow-run");
    assertStringIncludes(text, "NOT a syntax error");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("transpile: a real error is passed through untouched when run IS granted", () => {
  // This process has -A, so the explainer must not steal the message.
  const original = new Error("Unexpected end of file");
  assert(_explainTranspileFailure(original) === original);
});
