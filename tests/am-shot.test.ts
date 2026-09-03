// `am shot` against a fake CDP endpoint (HTTP /json + WS answering
// Page.captureScreenshot with a 1×1 PNG), and the refusal when the lock
// records no cdpPort — the exact flag to add is in the message.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import { appPageTargets, type CdpTarget } from "../src/am/am-cdp.ts";
import { noCdpMessage, shotOutPath } from "../src/am/am-cmd-shot.ts";

// 1×1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeCdp(port: number, pageUrl: string) {
  const ac = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/json") {
        const targets: CdpTarget[] = [
          {
            id: "dt",
            type: "other",
            url: "devtools://x",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ws/dt`,
          },
          {
            id: "p1",
            type: "page",
            url: pageUrl,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ws/p1`,
          },
        ];
        return Response.json(targets);
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as {
          id: number;
          method: string;
          params: { format?: string };
        };
        if (
          m.method === "Page.captureScreenshot" && m.params.format === "png"
        ) {
          socket.send(JSON.stringify({ id: m.id, result: { data: PNG_B64 } }));
        } else {
          socket.send(
            JSON.stringify({
              id: m.id,
              error: { message: `nope: ${m.method}` },
            }),
          );
        }
      };
      return response;
    },
  );
  return { close: () => ac.abort(), finished: server.finished };
}

/** `JSON.parse(r.out)` on its own reports "Unexpected end of JSON input" and
 *  nothing else — not the exit code, not stderr, not even that the output was
 *  EMPTY. That is exactly what one full-suite run produced for the failed-
 *  install test (which passes in isolation), and the message made the flake
 *  undiagnosable: it named the parser, never the subprocess. */
function amJson(
  r: { code: number; out: string; err: string },
  what: string,
): // deno-lint-ignore no-explicit-any
any {
  if (r.out.trim() === "") {
    throw new Error(
      `${what}: expected JSON on stdout, got NOTHING (exit ${r.code}). ` +
        `stderr: ${r.err.trim().slice(0, 400) || "(empty)"}`,
    );
  }
  try {
    return JSON["parse"](r.out); // indexed: a literal `JSON.parse(r.out)` here
    // would be caught by the very sweep that introduced this helper.
  } catch (e) {
    throw new Error(
      `${what}: stdout is not JSON (exit ${r.code}): ${
        (e as Error).message
      }\n` +
        `stdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`,
    );
  }
}

async function am(args: string[], env: Record<string, string>) {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/am.ts", ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("appPageTargets: the app's aio:// shell or its own origin, pages only", () => {
  const t = (type: string, url: string): CdpTarget => ({
    id: url,
    type,
    url,
    webSocketDebuggerUrl: "ws://x",
  });
  const got = appPageTargets([
    t("page", "devtools://devtools/x"),
    t("page", "aio://app/"),
    t("other", "aio://app/"),
    t("page", "http://localhost:5000/?token=a"),
    t("page", "http://localhost:50001/"),
    t("page", "about:blank"),
  ], 5000);
  assertEquals(got.map((g) => g.url), [
    "aio://app/",
    "http://localhost:5000/?token=a",
  ]);
});

Deno.test("shotOutPath: --out wins, else <appId>-<stamp>.png", () => {
  assertEquals(shotOutPath("x", "a/b.png"), "a/b.png");
  assertEquals(
    shotOutPath("x", undefined, new Date("2026-08-25T10:11:12Z")),
    "x-20260825-101112.png",
  );
});

Deno.test({
  name:
    "am shot: fake CDP → PNG written (bytes>0), --json {file,bytes,url}; no cdpPort → refusal names --cdp",
  fn: async () => {
    const appsDir = await Deno.makeTempDir({ prefix: "am-shot-" });
    const env = { AIO_APPS_DIR: appsDir };
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", appsDir);
    const cdp = freePort();
    const appPort = freePort();
    const appId = "shot-fake";
    const fake = fakeCdp(cdp, `http://localhost:${appPort}/`);
    try {
      // No cdpPort in the lock → the exact remedy, non-zero exit.
      writeLock({
        appId,
        pid: Deno.pid,
        port: appPort,
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
      });
      const refused = await am(["shot", `--app=${appId}`], env);
      assertEquals(refused.code, 1);
      assertStringIncludes(refused.out + refused.err, "--cdp");
      assertStringIncludes(refused.out + refused.err, noCdpMessage(appId));

      // --pose is refused, not faked.
      const pose = await am(["shot", `--app=${appId}`, "--pose={}"], env);
      assertEquals(pose.code, 1);
      assertStringIncludes(pose.out + pose.err, "not supported");

      writeLock({
        appId,
        pid: Deno.pid,
        port: appPort,
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
        cdpPort: cdp,
      });
      const outFile = `${appsDir}/shot.png`;
      const r = await am(
        ["shot", `--app=${appId}`, `--out=${outFile}`, "--json"],
        env,
      );
      assertEquals(r.code, 0, r.err);
      const j = amJson(r, "am shot") as {
        file: string;
        bytes: number;
        url: string;
      };
      assertEquals(j.file, outFile);
      assert(j.bytes > 0);
      assertEquals(j.url, `http://localhost:${appPort}/`);
      const png = await Deno.readFile(outFile);
      assertEquals(png.byteLength, j.bytes);
      assertEquals([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG magic

      // Index past the one window → loud miss listing what exists.
      const miss = await am(["shot", "3", `--app=${appId}`], env);
      assertEquals(miss.code, 1);
      assertStringIncludes(miss.out + miss.err, "window 3 does not exist");
    } finally {
      fake.close();
      await fake.finished;
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      await Deno.remove(appsDir, { recursive: true }).catch(() => {});
    }
  },
});

// ── a client with no window ─────────────────────────────────────────
//
// `am shot` on a `--client=browser` app said "Restart with the flag:
// am restart <app> --cdp … then am shot again", and the operator who did
// exactly that got "recorded cdp 127.0.0.1:PORT but nothing answers there".
// Two steps to the same dead end, when the first answer — this app has no
// window — was knowable from the lock all along.
Deno.test("am shot: a windowless client is refused up front, not sent to --cdp", async () => {
  const appsDir = await Deno.makeTempDir({ prefix: "am-shot-nowin-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", appsDir);
  const appId = "shot-browser";
  try {
    for (const client of ["browser", "server-only", "cli"]) {
      writeLock({
        appId,
        pid: Deno.pid,
        port: freePort(),
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
        client,
        // Even WITH a recorded cdp port: a port nothing listens on is the
        // second dead end, not a second chance.
        cdpPort: freePort(),
      });
      const r = await am(["shot", `--app=${appId}`], { AIO_APPS_DIR: appsDir });
      const text = r.out + r.err;
      assertEquals(r.code, 1);
      assertStringIncludes(text, `--client=${client}`);
      assertStringIncludes(text, "no desktop window");
      assertStringIncludes(text, "am surface");
      assert(
        !/Restart with the flag/.test(text),
        `a restart cannot give this app a window. Got: ${text}`,
      );
    }
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(appsDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("noCdpMessage: an electron app still gets the --cdp remedy; an old lock hedges honestly", () => {
  const el = noCdpMessage("app", "electron");
  assertStringIncludes(el, "Restart with the flag");
  // Pre-alpha76 lock: no client recorded. Never assert a window exists.
  const old = noCdpMessage("app");
  assertStringIncludes(old, "Restart with the flag");
  assertStringIncludes(old, "no window to shoot at all");
});
