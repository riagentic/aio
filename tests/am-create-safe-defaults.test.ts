// `am create` writes the SAFE value of every switch whose default cannot move.
//
// A paired client that hands its saved key to whoever answers at the paired
// address, a desktop app that opens a DevTools port because another app's
// `AIO_CDP` is still in the shell, a call with no argument list run with
// `undefined`: each is closed by an opt-in key, and each key's default has to
// stay what it was — an app written against an older aio upgrades with
// `am pin` + `am fix` and no change in behaviour. A NEW app has no behaviour
// to keep, so the scaffold writes the safe value, as it does for `ui.theme`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { TEMPLATES } from "../src/am/am-help-text.ts";
import { enc } from "../src/protocol/envelope.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import {
  freePort,
  killAnd,
  makeApp,
  spawn,
  waitForHttp,
} from "./e2e-app-harness.ts";

type Ack = { ok: boolean; code?: string; type: string };
/** One action over the WebSocket door, and its ack. */
async function wsAck(
  port: number,
  d: { type: string; payload?: unknown },
): Promise<Ack> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws never opened"));
    });
    const ack = new Promise<Ack>((res) => {
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.t === "ack") res({ ...m.d, type: d.type });
      };
    });
    ws.send(enc("action", { ...d, cid: crypto.randomUUID() }));
    return await ack;
  } finally {
    const closed = new Promise((r) => ws.onclose = r);
    ws.close();
    await closed;
  }
}

/** The entry with its comment lines taken out — a key in a comment is not set. */
const codeOf = (src: string) =>
  src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
/** Is `key` explained by a comment line of the entry? */
const commented = (src: string, key: string) =>
  src.split("\n").some((l) => l.trim().startsWith("//") && l.includes(key));

Deno.test("am create: every template with a window writes ignoreDebugEnv, strictPin and refuseShortCalls — each with its reason", () => {
  assert(TEMPLATES.length > 1, "no templates to check");
  for (const tpl of TEMPLATES) {
    if (tpl === "cli") continue;
    for (const target of ["browser", "electron"] as const) {
      const files = scaffold("demo", tpl, true, target);
      const entry = files["src/app.ts"]!;
      const where = `${tpl}/${target}`;
      assertStringIncludes(
        codeOf(entry),
        "electron: { ignoreDebugEnv: true, strictPin: true }",
        where,
      );
      assertStringIncludes(
        codeOf(entry),
        "wire: { refuseShortCalls: true }",
        where,
      );
      for (
        const key of ["ignoreDebugEnv:", "strictPin:", "refuseShortCalls:"]
      ) {
        assert(commented(entry, key), `${where}: ${key} has no comment`);
      }
      // The packaged client's half of the strict pin is a build fact.
      assertEquals(
        JSON.parse(files["deno.json"]!).build.strictPin,
        true,
        where,
      );
      // A new app's desktop package downloads its Electron once into the
      // shared store; aio's own default stays "offline" (a rebuilt app keeps
      // the package it had).
      assertEquals(
        JSON.parse(files["deno.json"]!).build.electronRuntime,
        "online",
        where,
      );
      // An Android build follows the phone's light/dark setting. aio's own
      // default stays the dark theme of 1.0.19 (a rebuilt app looks as it
      // did); a new app has no look to keep.
      assertEquals(
        JSON.parse(files["deno.json"]!).android,
        { colorScheme: "system" },
        where,
      );
    }
  }
});

Deno.test("am create --template=cli: no window, so the wire key only", () => {
  const files = scaffold("tool", "cli", true, "cli");
  const entry = files["src/app.ts"]!;
  assertStringIncludes(codeOf(entry), "wire: { refuseShortCalls: true }");
  assert(commented(entry, "argument list"), "the key has no comment");
  assert(!codeOf(entry).includes("strictPin"));
  assert(!codeOf(entry).includes("ignoreDebugEnv"));
  assertEquals("strictPin" in JSON.parse(files["deno.json"]!).build, false);
  assertEquals("android" in JSON.parse(files["deno.json"]!), false);
  assertEquals(
    "electronRuntime" in JSON.parse(files["deno.json"]!).build,
    false,
  );
});

// The keys are LIVE in a booted scaffold, and aio's own clients are not what
// they refuse.
Deno.test("am create: a scaffolded app boots with its safe values on, says nothing about them, and still takes its own client's calls", async () => {
  const dir = await makeApp("todo", "create-safe-");
  const port = freePort();
  const { proc, log } = spawn(
    "deno",
    ["run", "-A", "src/app.ts", "--client=server-only", `--port=${port}`],
    dir,
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}/__aio/health`, 90_000)
      .catch((e) => {
        throw new Error(`${e}\n--- server log ---\n${log()}`);
      });
    // A key aio does not know, or one of the wrong type, is said at boot.
    for (const key of ["ignoreDebugEnv", "strictPin", "refuseShortCalls"]) {
      assert(!log().includes(key), `boot mentioned ${key}:\n${log()}`);
    }
    // The shape every aio client sends — the browser's cell stub builds
    // `{ type, payload: { args } }` (src/browser/protocol-cell.ts).
    const own = await wsAck(port, {
      type: "todo:add",
      payload: { args: ["ship it"] },
    });
    assertEquals(own.ok, true, JSON.stringify(own));
    // A hand-written call that states no argument list: refused, nothing ran.
    const bare = await wsAck(port, { type: own.type });
    assertEquals(bare.ok, false, JSON.stringify(bare));
    assertEquals(bare.code, "ACTION_REFUSED");
  } finally {
    await killAnd(proc, dir);
  }
});

// `am` reads the entry statically. A scaffolded desktop app must be read the
// way it boots: it ignores an ambient AIO_PORT, so `am` must not aim there.
Deno.test("am create: am reads the generated entry the way the runtime boots it", async () => {
  const AM_UTILS = new URL("../src/am/am-utils.ts", import.meta.url).href;
  const REPO_CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
  const declared = async (target: "electron" | "browser") => {
    const proj = await tempDir("aio-create-safe-");
    try {
      const files = scaffold("demo", "counter", true, target);
      await Deno.mkdir(join(proj, "src"));
      await Deno.writeTextFile(
        join(proj, "src", "app.ts"),
        files["src/app.ts"]!,
      );
      // Identity and the declared client only — the probe runs on the repo's
      // import map.
      await Deno.writeTextFile(
        join(proj, "deno.json"),
        JSON.stringify({ title: "demo", client: target }),
      );
      await Deno.writeTextFile(
        join(proj, "probe.ts"),
        `import { declaredPort } from "${spec(AM_UTILS)}";\n` +
          `console.log(String(declaredPort()));\n`,
      );
      const r = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-check", "--config", REPO_CONFIG, "probe.ts"],
        cwd: proj,
        env: { ...Deno.env.toObject(), AIO_PORT: "9100" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
      return new TextDecoder().decode(r.stdout).trim().split("\n").at(-1);
    } finally {
      await dropTempDir(proj);
    }
  };
  assertEquals(await declared("electron"), "undefined");
  assertEquals(await declared("browser"), "9100", "only a desktop run ignores");
});
