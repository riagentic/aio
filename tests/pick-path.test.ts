// pick-path.test.ts — the dialog API, and the one distinction it exists for.
//
// Three field-report apps wrote the same zenity wrapper and at least two
// shipped the same bug: a dialog binary that is NOT INSTALLED exits 1 with no
// output, and so does a user pressing Cancel. Conflating them makes a broken
// Browse button look like an indecisive user (one GPU-pipeline app shipped exactly that).
//
// So the tests that matter are not "does it return a path" — they are the four
// endings, told apart: picked · cancelled · missing · broken. They run against
// a FAKE provider on PATH, which is the only way to exercise a native dialog in
// CI without a human clicking.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { pickDirectory, pickFile, pickSpec } from "../src/server/pick-path.ts";

const linux = Deno.build.os === "linux";

/** Put a fake `zenity` on PATH; returns a restore function. */
async function fakeZenity(body: string): Promise<() => void> {
  const dir = await Deno.makeTempDir({ prefix: "aio-pick-" });
  const bin = join(dir, "zenity");
  await Deno.writeTextFile(bin, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(bin, 0o755);
  const oldPath = Deno.env.get("PATH") ?? "";
  const oldDisplay = Deno.env.get("DISPLAY");
  Deno.env.set("PATH", `${dir}:${oldPath}`);
  Deno.env.set("DISPLAY", oldDisplay ?? ":0"); // a dialog needs a session
  return () => {
    Deno.env.set("PATH", oldPath);
    if (oldDisplay === undefined) Deno.env.delete("DISPLAY");
    else Deno.env.set("DISPLAY", oldDisplay);
    Deno.removeSync(dir, { recursive: true });
  };
}

// ── the four endings ────────────────────────────────────────────────────

Deno.test({
  name: "pickFile: a chosen path comes back as a path",
  ignore: !linux,
  fn: async () => {
    const restore = await fakeZenity(`echo /home/u/clip.mp4`);
    try {
      assertEquals(await pickFile(), "/home/u/clip.mp4");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickFile: CANCEL is null — a normal outcome, not an error",
  ignore: !linux,
  fn: async () => {
    const restore = await fakeZenity(`exit 1`); // zenity's cancel: 1, no output
    try {
      assertEquals(await pickFile(), null);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickFile: a MISSING dialog throws — it must never look like a cancel",
  ignore: !linux,
  fn: async () => {
    const empty = await Deno.makeTempDir({ prefix: "aio-nopath-" });
    const oldPath = Deno.env.get("PATH") ?? "";
    const oldDisplay = Deno.env.get("DISPLAY");
    Deno.env.set("PATH", empty);
    Deno.env.set("DISPLAY", oldDisplay ?? ":0");
    try {
      const e = await assertRejects(() => pickFile());
      assertStringIncludes((e as Error).message, "no file dialog available");
      assertStringIncludes((e as Error).message, "zenity");
      assertStringIncludes(
        (e as Error).message,
        "NOT the same as the user cancelling",
        "the message has to say the thing every wrapper got wrong",
      );
    } finally {
      Deno.env.set("PATH", oldPath);
      if (oldDisplay === undefined) Deno.env.delete("DISPLAY");
      Deno.removeSync(empty, { recursive: true });
    }
  },
});

Deno.test({
  name: "pickFile: a BROKEN dialog throws with the tool's own stderr",
  ignore: !linux,
  fn: async () => {
    const restore = await fakeZenity(`echo "GLib: fatal boom" >&2; exit 2`);
    try {
      const e = await assertRejects(() => pickFile());
      assertStringIncludes((e as Error).message, "exit 2");
      assertStringIncludes((e as Error).message, "fatal boom");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickFile: stderr noise on a SUCCESSFUL pick is not an error",
  ignore: !linux,
  fn: async () => {
    // Healthy desktops print GTK module warnings constantly. A wrapper that
    // reads stderr as failure refuses to work on half the machines it runs on.
    const restore = await fakeZenity(
      `echo "Gtk-Message: Failed to load module 'canberra'" >&2; echo /tmp/a.mp4`,
    );
    try {
      assertEquals(await pickFile(), "/tmp/a.mp4");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickFile: 'cannot open display' is a failure, never a cancel",
  ignore: !linux,
  fn: async () => {
    // The nastiest shape: DISPLAY is SET but dead (a stale value, an ssh
    // session without -X). zenity exits 1 with no stdout — the exact signature
    // of a cancel — and an app told "the user cancelled" never finds this.
    const restore = await fakeZenity(
      `echo "Unable to init server: Could not connect: Connection refused" >&2; exit 1`,
    );
    try {
      const e = await assertRejects(() => pickFile());
      assertStringIncludes((e as Error).message, "Unable to init server");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickFile: multiple returns an array, and cancel stays null (never [])",
  ignore: !linux,
  fn: async () => {
    let restore = await fakeZenity(`printf '/a.mp4\\n/b.mp4\\n'`);
    try {
      assertEquals(await pickFile({ multiple: true }), ["/a.mp4", "/b.mp4"]);
    } finally {
      restore();
    }
    restore = await fakeZenity(`exit 1`);
    try {
      assertEquals(
        await pickFile({ multiple: true }),
        null,
        "cancelled must be null in the multiple form too — one check, not two",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "pickDirectory: refuses up front when there is no desktop session",
  ignore: !linux,
  fn: async () => {
    const oldDisplay = Deno.env.get("DISPLAY");
    const oldWayland = Deno.env.get("WAYLAND_DISPLAY");
    Deno.env.delete("DISPLAY");
    Deno.env.delete("WAYLAND_DISPLAY");
    try {
      // Headless is the case where zenity exits 1 with "cannot open display" —
      // byte-identical to a cancel. Refusing before the spawn is the only way
      // that distinction survives.
      const e = await assertRejects(() => pickDirectory());
      assertStringIncludes((e as Error).message, "no desktop session");
    } finally {
      if (oldDisplay !== undefined) Deno.env.set("DISPLAY", oldDisplay);
      if (oldWayland !== undefined) {
        Deno.env.set("WAYLAND_DISPLAY", oldWayland);
      }
    }
  },
});

// ── the per-OS command, checkable from any OS ───────────────────────────

Deno.test("pickSpec: zenity — directory, multiple and filters", () => {
  const dir = pickSpec("linux", "zenity", "directory", { title: "Scratch" })!;
  assertEquals(dir.cmd, "zenity");
  assertEquals(dir.args.includes("--directory"), true);
  assertEquals(dir.args.includes("--title=Scratch"), true);

  const many = pickSpec("linux", "zenity", "files", {
    filters: [{ name: "Video", extensions: [".mp4", "mkv"] }],
  })!;
  assertEquals(many.args.includes("--multiple"), true);
  assertEquals(
    many.args.includes("--file-filter=Video | *.mp4 *.mkv"),
    true,
    "a leading dot in an extension must not become **.mp4",
  );
});

Deno.test("pickSpec: zenity opens IN a directory (trailing separator)", () => {
  // Without the trailing slash zenity pre-fills the last segment as a FILE
  // NAME instead of opening the folder — a one-character bug that makes the
  // start directory look ignored.
  const s = pickSpec("linux", "zenity", "file", { startIn: "/var/tmp" })!;
  assertEquals(s.args.includes("--filename=/var/tmp/"), true);
});

Deno.test("pickSpec: kdialog's filter is the mirror of zenity's", () => {
  const s = pickSpec("linux", "kdialog", "file", {
    filters: [{ name: "Video", extensions: ["mp4"] }],
  })!;
  assertEquals(s.cmd, "kdialog");
  assertEquals(s.args.includes("--getopenfilename"), true);
  assertEquals(
    s.args.some((a) => a === "*.mp4|Video"),
    true,
    "kdialog takes patterns first, label after the pipe",
  );
});

Deno.test("pickSpec: osascript returns POSIX paths, not aliases", () => {
  const one = pickSpec("darwin", "osascript", "file", { title: 'a "b"' })!;
  assertEquals(one.cmd, "osascript");
  assertStringIncludes(one.args[1]!, "POSIX path of");
  assertStringIncludes(one.args[1]!, '\\"b\\"', "the title has to be escaped");

  const many = pickSpec("darwin", "osascript", "files", {})!;
  assertStringIncludes(many.args[1]!, "multiple selections allowed");
  assertStringIncludes(
    many.args[1]!,
    "repeat with f in fs",
    "each alias in a multi-selection needs its own POSIX path conversion",
  );
});

Deno.test("pickSpec: powershell dialogs are -STA and quote-safe", () => {
  const s = pickSpec("windows", "powershell", "file", {
    title: "it's here",
    filters: [{ name: "Video", extensions: ["mp4", "mkv"] }],
  })!;
  assertEquals(
    s.args.includes("-STA"),
    true,
    "the Windows common dialogs are STA COM objects — without -STA they " +
      "silently never open",
  );
  assertStringIncludes(s.args.at(-1)!, "'it''s here'");
  assertStringIncludes(s.args.at(-1)!, "Video|*.mp4;*.mkv");

  const dir = pickSpec("windows", "powershell", "directory", {})!;
  assertStringIncludes(dir.args.at(-1)!, "FolderBrowserDialog");
});
