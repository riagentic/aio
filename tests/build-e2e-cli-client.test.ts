// The `cli-client` target — a headless binary that connects to a running
// server — was documented as buildable and never proven to CONNECT: no gate
// built one and pointed it at a server. This does, with two real artifacts
// from one scaffold: the `server` binary and the `cli-client` binary, from
// foreign cwds, over a real socket.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildFlags, freePort, makeApp } from "./e2e-app-harness.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";

Deno.test({
  name:
    "artifact: `cli-client` binary connects to a `server` binary and prints its state",
  ignore: !GATE,
  // aio-ok: spawned compiled `server` + `cli-client` binaries (external processes); their stdio pipes outlive the assertion
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  // aio-ok: two compiled binaries are external processes, killed in finally
  // aio-ok: same — their lifecycles are outside Deno's view
  fn: async () => {
    const serverDir = await makeApp("counter", "build-e2e-cli-srv-");
    const clientDir = await makeApp("counter", "build-e2e-cli-cli-");
    let server: Deno.ChildProcess | undefined;
    try {
      const s = await buildFlags(
        serverDir,
        "--compile",
        "--service",
        "--headless",
      );
      assertEquals(s.code, 0, `server build failed:\n${s.out}\n${s.err}`);
      const c = await buildFlags(clientDir, "--compile", "--cli", "--remote");
      assertEquals(c.code, 0, `cli-client build failed:\n${c.out}\n${c.err}`);

      const bin = (dir: string) =>
        join(
          dir,
          [...Deno.readDirSync(dir)].find((e) =>
            e.isFile && !e.name.includes(".")
          )!.name,
        );
      const serverBin = bin(serverDir);
      const clientBin = bin(clientDir);
      await Deno.chmod(serverBin, 0o755);
      await Deno.chmod(clientBin, 0o755);

      const port = freePort();
      const foreign = await Deno.makeTempDir({ prefix: "foreign-cwd-" });
      server = new Deno.Command(serverBin, {
        args: ["--client=server-only", `--port=${port}`],
        cwd: foreign,
        env: { ...Deno.env.toObject(), AIO_APPS_DIR: foreign },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const deadline = Date.now() + 45_000;
      let up = false;
      while (Date.now() < deadline && !up) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/__aio/health`);
          await r.body?.cancel();
          up = r.ok;
        } catch { /* not yet */ }
        if (!up) await new Promise((r) => setTimeout(r, 200));
      }
      assert(up, "the server binary never answered /__aio/health");

      // The scaffold's client prints the state it receives, then keeps
      // watching; a bounded run is enough to prove the round trip.
      const client = new Deno.Command(clientBin, {
        args: [`ws://127.0.0.1:${port}/ws`],
        cwd: foreign,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      // Read its output ONCE; a bounded run is enough to prove the round trip.
      const outP = client.output();
      const timer = setTimeout(() => {
        try {
          client.kill("SIGKILL");
        } catch { /* gone */ }
      }, 8_000);
      const o = await outP;
      clearTimeout(timer);
      const out = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertStringIncludes(
        out,
        "state:",
        `the client printed no state:\n${out}`,
      );
      assertStringIncludes(
        out,
        "count",
        `the client's state has no counter slice:\n${out}`,
      );
    } finally {
      try {
        server?.kill("SIGKILL");
      } catch { /* gone */ }
      if (server) {
        await server.status;
        await server.stdout.cancel().catch(() => {});
        await server.stderr.cancel().catch(() => {});
      }
      await Deno.remove(serverDir, { recursive: true }).catch(() => {});
      await Deno.remove(clientDir, { recursive: true }).catch(() => {});
    }
  },
});
