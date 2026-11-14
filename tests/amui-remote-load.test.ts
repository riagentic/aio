// amui run from its published JSR export (`deno run -A jsr:@riagentic/aio/amui`,
// what docs/clients/amui.md and `am ui`'s fallback tell users to run) has an
// https: import.meta.url. scan.server.ts's selfDir() called fromFileUrl() on
// it OUTSIDE selfPaths()'s try — discovery threw and amui listed nothing; the
// self check of start/stop/restart and createApp threw the same way.
// Stand-in for jsr.io: the checkout served read-only over http on loopback.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { amCommand } from "../amui/src/server/proc.server.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

Deno.test("amui discovery works when amui is loaded from a remote (https) URL", async () => {
  const port = freePort();
  const ac = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    async (req) => {
      const p = decodeURIComponent(new URL(req.url).pathname);
      if (p.includes("..")) return new Response("no", { status: 400 });
      try {
        const body = await Deno.readFile(REPO + p.slice(1));
        const ct = p.endsWith(".tsx")
          ? "text/tsx"
          : p.endsWith(".ts")
          ? "application/typescript"
          : "application/octet-stream";
        return new Response(body, { headers: { "content-type": ct } });
      } catch {
        return new Response("nf", { status: 404 });
      }
    },
  );
  const sandbox = await tempDir("amui-remote-");
  try {
    // In a CHILD with --no-lock: an in-process import of the stand-in origin
    // wrote its URLs into the repository's deno.lock on every suite run.
    const code = `
      const scan = await import("http://127.0.0.1:${port}/amui/src/server/scan.server.ts");
      const found = await scan.discoverProjects();
      console.log(JSON.stringify({
        selfDir: scan.selfDir(),
        projects: Array.isArray(found.projects),
        selfPaths: (await scan.selfPaths()) instanceof Set,
      }));`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-lock", "--config", REPO + "deno.json", code],
      env: { ...Deno.env.toObject(), HOME: sandbox, AMUI_ROOTS: sandbox },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text =
      new TextDecoder().decode(out.stdout).trim().split("\n").at(-1) ?? "";
    assert(out.success, new TextDecoder().decode(out.stderr));
    const r = JSON.parse(text);
    assertEquals(r.selfDir, null, "no local dir behind an https module");
    assert(r.projects);
    assert(r.selfPaths);
  } finally {
    ac.abort();
    await server.finished;
    await dropTempDir(sandbox);
    // The remote modules this process cached for the stand-in origin — ours,
    // keyed by its one-off port, of no future use.
    const info = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const { denoDir } = JSON.parse(new TextDecoder().decode(info.stdout));
    await Deno.remove(`${denoDir}/remote/http/127.0.0.1_port_${port}`, {
      recursive: true,
    }).catch(() => {});
  }
});

Deno.test("amui createApp locates `am` from a JSR load, and refuses loudly from anywhere else", () => {
  const jsr = amCommand(
    "https://jsr.io/@riagentic/aio/1.0.27-beta/amui/src/server/proc.server.ts",
  );
  assert("args" in jsr);
  assertEquals(jsr.args("x"), [
    "jsr:@riagentic/aio@1.0.27-beta/am",
    "create",
    "x",
  ]);
  const other = amCommand(
    "https://example.test/amui/src/server/proc.server.ts",
  );
  assert(
    "error" in other && /am create/.test(other.error),
    JSON.stringify(other),
  );
  const local = amCommand(
    new URL("../amui/src/server/proc.server.ts", import.meta.url).href,
  );
  assert("args" in local);
  assertEquals(local.args("x").slice(1, 3), ["create", "x"]);
  assert(local.args("x")[0]!.endsWith("src/am.ts"));
});
