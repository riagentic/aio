// pickSave — the native "Save as…" dialog, on both paths (jot §3).
//
// The window path (Electron's showSaveDialog) is pinned on the wire in
// electron-main-relay.test.ts; here: the spawned tools (a fake zenity on PATH,
// and every provider's pure spec), the request the window is sent, and the
// one-path answer contract they share with pickFile.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { DELIMITER, join } from "@std/path";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import {
  _splitSavePath,
  dialogRequest,
  interpretDialogReply,
  pickSave,
  pickSpec,
} from "../src/server/pick-path.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const linux = Deno.build.os === "linux";

async function withFakeZenity(
  body: string,
  fn: (argsFile: string) => Promise<void>,
): Promise<void> {
  const dir = await tempDir("aio-pick-save-");
  const argsFile = join(dir, "args.txt");
  await writeProgram(
    join(dir, "zenity" + EXE),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n${body}\n`,
  );
  const oldPath = Deno.env.get("PATH") ?? "";
  const oldDisplay = Deno.env.get("DISPLAY");
  Deno.env.set("PATH", `${dir}${DELIMITER}${oldPath}`);
  Deno.env.set("DISPLAY", oldDisplay ?? ":0");
  try {
    await fn(argsFile);
  } finally {
    Deno.env.set("PATH", oldPath);
    if (oldDisplay === undefined) Deno.env.delete("DISPLAY");
    else Deno.env.set("DISPLAY", oldDisplay);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name:
    "pickSave: the spawned zenity is a SAVE dialog that confirms overwrite; the chosen path comes back",
  ignore: !linux,
  fn: () =>
    withFakeZenity("echo /home/u/docs/report.md", async (argsFile) => {
      const got = await pickSave({
        title: "Export",
        defaultPath: "/home/u/docs/draft.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      assertEquals(got, "/home/u/docs/report.md");
      const args = (await Deno.readTextFile(argsFile)).trim().split("\n");
      assertEquals(args, [
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        "--title=Export",
        "--filename=/home/u/docs/draft.md",
        "--file-filter=Markdown | *.md",
      ]);
    }),
});

Deno.test({
  name: "pickSave: cancel is null; a broken dialog throws, naming pickSave",
  ignore: !linux,
  fn: async () => {
    await withFakeZenity("exit 1", async () => {
      assertEquals(await pickSave(), null);
    });
    await withFakeZenity("echo 'Gtk: boom' >&2; exit 5", async () => {
      const e = await assertRejects(() => pickSave());
      assert(/^pickSave: zenity failed \(exit 5\)/.test((e as Error).message));
    });
  },
});

Deno.test("pickSave: every provider opens a save dialog that asks before replacing", () => {
  const opts = {
    title: "Save it",
    defaultPath: "/tmp/no-such-dir-aio/out.txt",
    filters: [{ name: "Text", extensions: [".txt"] }],
  };
  const k = pickSpec("linux", "kdialog", "save", opts)!;
  assertEquals(k.args, [
    "--title",
    "Save it",
    "--getsavefilename",
    "/tmp/no-such-dir-aio/out.txt",
    "*.txt|Text",
  ]);
  const osa = pickSpec("darwin", "osascript", "save", opts)!.args[1]!;
  assertEquals(
    osa,
    'return POSIX path of (choose file name with prompt "Save it" ' +
      'default name "out.txt" default location POSIX file "/tmp/no-such-dir-aio")',
  );
  const ps = pickSpec("windows", "powershell", "save", {
    ...opts,
    defaultPath: "C:\\Users\\Dan’s\\out.txt",
  })!;
  assertEquals(ps.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-STA"]);
  const cmd = ps.args[4]!;
  assert(cmd.includes("SaveFileDialog"), cmd);
  assert(cmd.includes("$d.OverwritePrompt = $true;"), cmd);
  assert(cmd.includes("$d.InitialDirectory = 'C:\\Users\\Dan’’s';"), cmd);
  assert(cmd.includes("$d.FileName = 'out.txt';"), cmd);
  assert(cmd.includes("$d.Filter = 'Text|*.txt';"), cmd);
  assert(
    cmd.includes("ShowDialog($o)"),
    "owned by a TopMost form, as opens are",
  );
  // No defaultPath: nothing suggested, kdialog starts in ".".
  assertEquals(
    pickSpec("linux", "zenity", "save", {})!.args,
    ["--file-selection", "--save", "--confirm-overwrite", "--title=Save as"],
  );
  assertEquals(
    pickSpec("linux", "kdialog", "save", {})!.args,
    ["--title", "Save as", "--getsavefilename", "."],
  );
});

Deno.test("pickSave: a defaultPath splits into where to open and what to suggest", async () => {
  const dir = (await tempDir("aio-save-split-")).replaceAll("\\", "/");
  try {
    assertEquals(_splitSavePath(undefined, "linux"), { name: "" });
    assertEquals(_splitSavePath("draft.md", "linux"), { name: "draft.md" });
    assertEquals(_splitSavePath(dir, "linux"), { dir, name: "" });
    assertEquals(_splitSavePath(`${dir}/new.md`, "linux"), {
      dir,
      name: "new.md",
    });
    assertEquals(_splitSavePath("/x.md", "linux"), { dir: "/", name: "x.md" });
    assertEquals(_splitSavePath("C:\\x.md", "windows"), {
      dir: "C:\\",
      name: "x.md",
    });
    assertEquals(
      pickSpec("linux", "zenity", "save", { defaultPath: dir })!.args.at(-1),
      `--filename=${dir}/`,
      "an existing directory opens IN it, suggesting no name",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pickSave: the window is sent the suggested path as given, and its answer is ONE path", () => {
  assertEquals(
    dialogRequest("save", {
      defaultPath: "draft.md",
      filters: [{ name: "Md", extensions: [".md"] }],
    }, "linux"),
    {
      kind: "save",
      title: "Save as",
      defaultPath: "draft.md",
      filters: [{ name: "Md", extensions: ["md"] }],
    },
  );
  assertEquals(
    interpretDialogReply("save", { canceled: false, paths: ["/a/b.md"] }),
    "/a/b.md",
  );
  assertEquals(
    interpretDialogReply("save", { canceled: true, paths: [] }),
    null,
  );
  assertEquals(
    interpretDialogReply("save", { canceled: false, paths: [] }),
    null,
    "an empty filePath is no choice — never ''",
  );
});
