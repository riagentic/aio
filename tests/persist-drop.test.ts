// `am persist --drop=<cell>` / `POST /__aio/trojan/persist/drop`: a stored
// cell this build no longer declares (dev debris that warned at every boot)
// is removed from the store — through the running app, which refuses a
// declared cell. Both persist layouts.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { readStoredState } from "../src/server/stored-state.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const mkPick = () =>
  cell("pick", {
    state: { last: "" },
    methods: {
      set(s: { last: string }, v: string) {
        s.last = v;
      },
    },
  });
const mkKeep = () =>
  cell("keep", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }, by: number) {
        s.n += by;
      },
    },
  });

async function boot(
  dir: string,
  cells: unknown[],
  persistMode: "single" | "multi",
  port = freePort(),
) {
  _resetAioRuntime();
  const app = await aio.run({
    cells,
    appId: "persist-drop",
    dbPath: join(dir, "state.db"),
    persistMode,
    port,
    libraryMode: true,
    client: "server-only",
    baseDir: dir,
  } as Any);
  return { app, url: `http://127.0.0.1:${port}/__aio/trojan` };
}

const drop = (url: string, cell: string) =>
  fetch(`${url}/persist/drop`, {
    method: "POST",
    headers: { "X-AIO": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ cell }),
  });

for (const mode of ["single", "multi"] as const) {
  Deno.test(`persist/drop (${mode}): an undeclared stored cell goes; a declared one is refused`, async () => {
    const dir = await tempDir("persist-drop-");
    try {
      {
        const pick = mkPick(), keep = mkKeep();
        const { app } = await boot(dir, [pick, keep], mode);
        try {
          await (pick as Any).set("debris");
          await (keep as Any).add(7);
        } finally {
          await app.close();
        }
      }
      assertEquals(
        await readStoredState(join(dir, "state.db"), "persist-drop"),
        {
          pick: { last: "debris" },
          keep: { n: 7 },
        },
      );
      const { app, url } = await boot(dir, [mkKeep()], mode);
      try {
        const declared = await drop(url, "keep");
        assertEquals(declared.status, 409);
        const why = await declared.text();
        assertStringIncludes(why, "Droppable now: pick");
        const unknown = await drop(url, "nothere");
        assertEquals(unknown.status, 409);
        await unknown.body?.cancel();
        const ok = await drop(url, "pick");
        assertEquals(ok.status, 200);
        assertEquals(await ok.json(), { ok: true, dropped: "pick" });
        // On disk while the app still runs — and the declared cell untouched.
        assertEquals(
          await readStoredState(join(dir, "state.db"), "persist-drop"),
          { keep: { n: 7 } },
        );
        const m = await (await fetch(`${url}/migrations`)).json();
        assert(
          !m.drift.some((d: { cell: string }) => d.cell === "pick"),
          "am migrations no longer reports it stored",
        );
        const again = await drop(url, "pick");
        assertEquals(again.status, 409);
        assertStringIncludes(await again.text(), "This app holds none");
      } finally {
        await app.close();
      }
      // A later boot that declares it again starts it fresh.
      const pick = mkPick();
      const { app: app3 } = await boot(dir, [pick, mkKeep()], mode);
      try {
        const s = app3.getState() as Any;
        assertEquals(s.pick, { last: "" });
        assertEquals(s.keep, { n: 7 });
      } finally {
        await app3.close();
        _resetAioRuntime();
      }
    } finally {
      await dropTempDir(dir);
    }
  });
}

Deno.test("am persist --drop: needs a cell, and a stopped app is refused with the way forward", async () => {
  const base = await tempDir("persist-drop-cli-");
  try {
    const run = async (argv: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          fromFileUrl(new URL("../src/am.ts", import.meta.url)),
          ...argv,
        ],
        cwd: base,
        env: {
          HOME: base,
          AIO_HOME: base,
          AIO_APPS_DIR: join(base, "apps"),
          AIO_INSTALL_ROOT: join(base, "install"),
          AIO_VERSIONS_DIR: join(base, "versions"),
          AIO_FEEDBACK_DIR: join(base, "feedback"),
          XDG_RUNTIME_DIR: join(base, "run"),
          AIO_AM_NO_DELEGATE: "1",
          PATH: Deno.env.get("PATH") ?? "",
          NO_COLOR: "1",
          DENO_DIR,
        },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        code: o.code,
        text: dec.decode(o.stdout) + dec.decode(o.stderr),
      };
    };
    const bare = await run(["persist", "--drop", "--app=ghost"]);
    assertEquals(bare.code, 1);
    assertStringIncludes(bare.text, "--drop needs =<cell>");
    const stopped = await run(["persist", "--drop=pick", "--app=ghost"]);
    assertEquals(stopped.code, 1);
    assertStringIncludes(stopped.text, "is not running");
    assertStringIncludes(stopped.text, "am persist --drop=pick");
  } finally {
    await dropTempDir(base);
  }
});
