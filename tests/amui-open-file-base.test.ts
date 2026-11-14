// `openFile(base, rel)` accepted ANY `base` from a dispatch, so readFile's
// "outside project" check was relative to whatever the caller named:
// `openFile($HOME, ".<appId>/app.key")` read a secret into synced cell state
// (and from there into the DOM and every connected client). Only a root amui
// itself offers — a listed project directory, or the selected app's runtime /
// repo root — is opened now.
import { assert, assertEquals } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

testCell(
  manager,
  "amui openFile refuses a base that is not a listed project directory",
  async (t) => {
    const sandbox = await tempDir("amui-openbase-");
    const home = `${sandbox}/home`;
    const proj = `${sandbox}/roots/proj`;
    await Deno.mkdir(`${home}/.someapp`, { recursive: true });
    await Deno.mkdir(proj, { recursive: true });
    await Deno.writeTextFile(`${home}/.someapp/app.key`, "SECRET-KEY-BYTES");
    await Deno.writeTextFile(
      `${proj}/deno.json`,
      JSON.stringify({ title: "proj", imports: { aio: "../mod.ts" } }),
    );
    await Deno.writeTextFile(`${proj}/README.txt`, "hello from proj");
    const keys = ["AMUI_ROOTS", "HOME"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("AMUI_ROOTS", `${sandbox}/roots`);
    Deno.env.set("HOME", home);
    _resetInstanceVerify();
    try {
      await t.send.discover();
      await t.send.openFile(home, ".someapp/app.key");
      let s = t.getState();
      assertEquals(s.fileContent, null, "a secret was read into state");
      assert(/not a listed project/.test(s.fileNotice ?? ""), s.fileNotice!);
      // A listed project still opens.
      const row = s.projects.find((p) => p.name === "proj");
      assert(row, "fixture not discovered");
      await t.send.openFile(row.path, "README.txt");
      s = t.getState();
      assertEquals(s.fileContent, "hello from proj", s.fileNotice ?? "");
    } finally {
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      });
      _resetInstanceVerify();
      await dropTempDir(sandbox);
    }
  },
);
