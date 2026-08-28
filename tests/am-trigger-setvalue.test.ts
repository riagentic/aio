// `am trigger … type <text>` APPENDS to the field (a field report expected it to
// replace, since driving a form is the usual intent).
//
// The in-process TWIN decides this one. `testUI`'s `ui.X.type()` appends too —
// it is documented on the handle (src/testing/ui-test.ts:84-90) and pinned by
// tests/ui-test.test.ts ("type() APPENDS… setValue() REPLACES"). So `am`'s
// `type` was RIGHT, and flipping it would have made one word mean two different
// things depending on which driver you reached for — the divergence this
// codebase refuses. What was missing is the OTHER word: testUI has `setValue`
// (clear, then type) and `am trigger` had no spelling for it at all, so the only
// replace was two commands, which is what made `type` look wrong.
//
// `setValue` is composed from the wire actions `clear` + `type`, which run the
// exact primitives testUI's setValue runs (triggerClear + triggerChar, shared
// via src/air/ui-trigger.ts and dispatched by src/air/ui-remote.ts:143-153).
import { assert, assertEquals } from "@std/assert";
import { cmdTrigger } from "../src/am/am-cmd-inspect.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { resolveAmAppId } from "../src/am/am-utils.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-trigger-setvalue-app";

type Seen = { path: string; body: Record<string, unknown> };

/** A stand-in for the app's trojan endpoint that RECORDS what am sends — the
 *  question here is exactly "which wire actions, in which order". */
async function withStub(
  fn: (
    trigger: (args: string[]) => Promise<void>,
    seen: Seen[],
    logs: string[],
  ) => Promise<void>,
): Promise<void> {
  const envKey = "AIO_APPS_DIR";
  const prevEnv = Deno.env.get(envKey);
  const appsDir = await Deno.makeTempDir({ prefix: "am-trigger-" });
  Deno.env.set(envKey, appsDir); // no stale lock file may redirect the port
  _resetInstanceVerify();
  const port = freePort();
  const seen: Seen[] = [];
  const ac = new AbortController();
  const server = Deno.serve({
    port,
    signal: ac.signal,
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/__aio/health") {
      return Response.json({ appId: resolveAmAppId(APP) });
    }
    const body = await req.json() as Record<string, unknown>;
    seen.push({ path: url.pathname, body });
    return Response.json({
      ok: true,
      path: body.path,
      action: body.action,
      surface: [],
    });
  });
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    await fn(
      (args) => cmdTrigger(args, { app: APP, port, json: true } as GlobalFlags),
      seen,
      logs,
    );
  } finally {
    console.log = realLog;
    ac.abort();
    await server.finished;
    _resetInstanceVerify();
    if (prevEnv === undefined) Deno.env.delete(envKey);
    else Deno.env.set(envKey, prevEnv);
    await Deno.remove(appsDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "am trigger setValue: clears, THEN types — testUI's exact definition",
  async fn() {
    await withStub(async (trigger, seen, logs) => {
      await trigger(["0", "App:HostInput", "setValue", "192.168.1.9"]);
      assertEquals(
        seen.map((s) => s.body.action),
        ["clear", "type"],
        "replace = clear then type, in that order",
      );
      assertEquals(seen[0]!.body, { path: "App:HostInput", action: "clear" });
      assertEquals(seen[1]!.body, {
        path: "App:HostInput",
        action: "type",
        text: "192.168.1.9",
      });
      assertEquals(seen[0]!.path, "/__aio/trojan/trigger/0");
      // The reply names the action the CALLER asked for, not the wire action it
      // decomposed into — "type" would read as the command doing something else.
      const reply = JSON.parse(logs.at(-1)!) as { action: string; ok: boolean };
      assertEquals(reply.action, "setValue");
      assertEquals(reply.ok, true);
    });
  },
});

Deno.test({
  name: "am trigger type: still ONE append, byte-for-byte as before",
  async fn() {
    await withStub(async (trigger, seen) => {
      await trigger(["0", "App:HostInput", "type", "abc"]);
      assertEquals(
        seen.length,
        1,
        "no hidden clear — type appends, like testUI",
      );
      assertEquals(seen[0]!.body, {
        path: "App:HostInput",
        action: "type",
        text: "abc",
      });
      // …and the other actions are untouched by the setValue composition.
      await trigger(["0", "App:HostInput", "clear"]);
      assertEquals(seen[1]!.body, { path: "App:HostInput", action: "clear" });
      await trigger(["0", "App:Stage", "keyDown", "ArrowLeft"]);
      assertEquals(seen[2]!.body, {
        path: "App:Stage",
        action: "keyDown",
        key: "ArrowLeft",
      });
      await trigger(["0", "App:Go", "click"]);
      assertEquals(seen[3]!.body, { path: "App:Go", action: "click" });
    });
  },
});

Deno.test("am trigger: the usage text says which of type/setValue replaces", async () => {
  // The usage is only printed on a miss, and a miss exits — read it from the
  // command's own source rather than forking a process for one string.
  const src = await Deno.readTextFile(
    new URL("../src/am/am-cmd-inspect.ts", import.meta.url),
  );
  const usage = src.slice(src.indexOf("usage: am trigger"));
  assert(usage.includes("setValue <text>"), "setValue is listed as an action");
  assert(
    /type APPENDS[\s\S]{0,80}setValue REPLACES/.test(usage),
    "the usage states which one replaces — the whole point of the report",
  );
});
