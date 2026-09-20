// pickFile / pickDirectory opened by the app's Electron WINDOW (a field report
// #10: on Windows the dialog the server spawned — powershell.exe, unrelated to
// any window — opened BEHIND the app, sometimes fully hidden).
//
// The fix routes a pick from an Electron window through that window's main
// process (`dialog.showOpenDialog(win, …)`: owned, modal, in front). What is
// pinned here, without a real Electron (see pick-path-electron-e2e for the
// real one and the Windows VM notes in the commit):
//   • PARITY — the window path and the spawned-tool path turn the same pick
//     into the same result (null on cancel, never [], an array for multiple),
//     and are asked for the same thing (title, start dir, bare extensions);
//   • ROUTING — a call from a socket peer that announced `caps: ["dialog"]`
//     opens there; a call from a peer that did not, or from HTTP/WS, does
//     not; a call with no caller goes to the one window when there is one;
//   • ENDINGS — a window that closes mid-dialog, or reports a failure,
//     THROWS; it is never read as a cancel.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  _interpret,
  dialogRequest,
  interpretDialogReply,
  pickFile,
  pickSpec,
} from "../src/server/pick-path.ts";
import {
  _registerDialogHost,
  type DialogHost,
  dialogHostForCall,
  runWithDialogCaller,
} from "../src/server/dialog-host.ts";
import {
  makeServerRequest,
  runWithRequest,
} from "../src/server/auth-context.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { serverFns } from "../src/server/server-fns.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

type Kind = "file" | "files" | "directory";
const out = (stdout: string, code = 0): Deno.CommandOutput =>
  ({
    code,
    success: code === 0,
    signal: null,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  }) as Deno.CommandOutput;

// ── parity: the same pick, the same answer ────────────────────────────────

Deno.test("parity: a pick comes back in the same shape from the window and from a spawned tool", () => {
  const cases: [Kind, string[]][] = [
    ["file", ["/home/u/clip.mp4"]],
    ["files", ["/home/u/a.mp4"]],
    ["files", ["/home/u/a.mp4", "/home/u/b c.mkv"]],
    ["directory", ["/home/u/scratch"]],
    // A `|` is a legal character in a POSIX file or folder name, and NO
    // provider ever uses one as a separator (zenity is spawned with
    // `--separator=\n`, kdialog with `--separate-output`, osascript joins with
    // a linefeed, powershell writes one path per line — see `pickSpec`). The
    // spawned path split on it anyway, so `pickFile()` on `a|b.txt` returned
    // `/home/u/a`: a path that does not exist, handed back as the user's
    // choice, while the window path returned it whole.
    ["file", ["/home/u/a|b.txt"]],
    ["directory", ["/home/u/Rock|Pop"]],
    ["files", ["/home/u/a|b.txt", "/home/u/c.txt"]],
  ];
  for (const [kind, paths] of cases) {
    const native = _interpret(kind, "zenity", out(paths.join("\n")));
    const windowed = interpretDialogReply(kind, { canceled: false, paths });
    assertEquals(windowed, native, `${kind} ${JSON.stringify(paths)}`);
    // …and the shape each kind promises.
    if (kind === "files") assert(Array.isArray(windowed));
    else assertEquals(typeof windowed, "string");
  }
});

Deno.test("parity: cancel is null on both paths, and nothing chosen is null — never []", () => {
  for (const kind of ["file", "files", "directory"] as Kind[]) {
    assertEquals(_interpret(kind, "zenity", out("", 1)), null);
    assertEquals(_interpret(kind, "powershell", out("", 0)), null);
    assertEquals(
      interpretDialogReply(kind, { canceled: true, paths: [] }),
      null,
    );
    assertEquals(
      interpretDialogReply(kind, { canceled: false, paths: [] }),
      null,
      "an OK with no selection is a cancel, as a tool's empty stdout is",
    );
    assertEquals(
      interpretDialogReply(kind, { canceled: true, paths: ["/left/over"] }),
      null,
      "the cancel flag wins over any paths a platform leaves in the answer",
    );
  }
});

Deno.test("parity: a window-reported failure THROWS — it is not a cancel", () => {
  let threw = "";
  try {
    interpretDialogReply("file", { error: "boom" }, "the Electron window");
  } catch (e) {
    threw = String(e);
  }
  assertStringIncludes(threw, "boom");
  assertStringIncludes(threw, "the Electron window");
  for (
    const bad of [null, {}, { canceled: false }, { paths: "x" }] as unknown[]
  ) {
    let t = false;
    try {
      interpretDialogReply("file", bad as never);
    } catch {
      t = true;
    }
    assert(t, `a malformed answer must throw: ${JSON.stringify(bad)}`);
  }
});

Deno.test("parity: the window is asked for exactly what the tool is given", async () => {
  const dir = await tempDir("pick-parity-");
  const file = join(dir, "last.mp4");
  await Deno.writeTextFile(file, "");
  const opts = {
    startIn: file, // a FILE: its directory is used, on both paths
    filters: [{ name: "Video", extensions: [".mp4", "*.mkv", "webm"] }],
  };
  const req = dialogRequest("files", opts, "linux");
  assertEquals(req, {
    kind: "files",
    title: "Choose a file",
    defaultPath: dir,
    filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm"] }],
  });
  const z = pickSpec("linux", "zenity", "files", opts)!;
  assert(z.args.includes(`--title=${req.title}`));
  assert(z.args.includes(`--filename=${dir}/`));
  assert(z.args.includes("--file-filter=Video | *.mp4 *.mkv *.webm"));

  assertEquals(dialogRequest("directory", opts, "linux"), {
    kind: "directory",
    title: "Choose a folder",
    defaultPath: dir,
  }, "no filters on a folder pick — same as every tool");
  assertEquals(dialogRequest("file", { title: "T" }, "linux"), {
    kind: "file",
    title: "T",
  });
});

// ── routing: which window, if any ─────────────────────────────────────────

function fakeHost(label: string): DialogHost {
  return {
    label,
    open: () => Promise.resolve({ canceled: false, paths: [`/from/${label}`] }),
  };
}

Deno.test("routing: the caller's own connection decides; HTTP/WS callers never get a window", () => {
  const a = fakeHost("a");
  const off = _registerDialogHost(a);
  try {
    // No caller at all (a schedule, a boot hook): the one window.
    assertEquals(dialogHostForCall(), a);
    // A socket peer that cannot open dialogs (the CLI client): not a window.
    assertEquals(runWithDialogCaller(null, () => dialogHostForCall()), null);
    // A caller that came over HTTP / WebSocket — a browser or a script.
    const req = makeServerRequest(
      new Request("http://127.0.0.1/"),
      "127.0.0.1",
      "ws",
    );
    assertEquals(runWithRequest(req, () => dialogHostForCall()), null);
    // Two windows and no caller: no honest answer.
    const offB = _registerDialogHost(fakeHost("b"));
    try {
      assertEquals(dialogHostForCall(), null);
      const b2 = fakeHost("b2");
      assertEquals(runWithDialogCaller(b2, () => dialogHostForCall()), b2);
    } finally {
      offB();
    }
  } finally {
    off();
  }
  assertEquals(dialogHostForCall(), null, "unregistered on close");
});

Deno.test("routing: the caller's window survives the awaits of an async method body", async () => {
  const h = fakeHost("w");
  const got = await runWithDialogCaller(h, async () => {
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();
    return await pickFile();
  });
  assertEquals(got, "/from/w");
});

// ── the socket end to end: announce, ask, answer ──────────────────────────

type Peer = {
  send: (line: string) => Promise<void>;
  frames: { t: string; d?: unknown }[];
  waitFor: (pred: () => boolean, what: string) => Promise<void>;
  close: () => void;
};

async function peer(socketPath: string): Promise<Peer> {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const frames: { t: string; d?: unknown }[] = [];
  let open = true;
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    const b = new Uint8Array(1 << 16);
    try {
      while (true) {
        const n = await conn.read(b);
        if (n === null) break;
        buf += decoder.decode(b.subarray(0, n), { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) {
          const f = l ? dec(l) : null;
          if (f) frames.push(f);
        }
      }
    } catch { /* closed */ }
  })();
  return {
    frames,
    send: (line) =>
      conn.write(new TextEncoder().encode(line + "\n")).then(() => {}),
    async waitFor(pred, what) {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > 5000) {
          throw new Error(
            `timed out waiting for ${what}: ${
              JSON.stringify(frames.map((f) => f.t))
            }`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => {
      if (!open) return;
      open = false;
      try {
        conn.close();
      } catch { /* already closed */ }
    },
  };
}

async function withUds(
  fn: (
    socketPath: string,
    calls: Promise<unknown>[],
    probes: Record<string, string | null>,
    hostsSeen: DialogHost[],
  ) => Promise<void>,
) {
  const socketPath = join(await tempDir("pick-uds-"), "s.sock");
  const calls: Promise<unknown>[] = [];
  const probes: Record<string, string | null> = {};
  const hostsSeen: DialogHost[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    (action) => {
      // What a cell method does: an async body that awaits the pick. The
      // promise is recorded (and its rejection observed) by the test.
      if (action.type === "c:probe") {
        const h = dialogHostForCall();
        probes[String((action.payload as { who?: string })?.who)] = h?.label ??
          null;
        if (h) hostsSeen.push(h);
      }
      if (action.type === "c:pick") {
        const p = (async () => {
          await Promise.resolve();
          return await pickFile({ multiple: true, title: "Pick" });
        })();
        p.catch(() => {});
        calls.push(p);
      }
    },
    () => {},
  );
  try {
    await fn(socketPath, calls, probes, hostsSeen);
  } finally {
    uds.shutdown();
  }
}

Deno.test({
  name:
    "uds: a window that announced dialogs opens the pick; its answer is the result",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withUds(async (socketPath, calls) => {
      const w = await peer(socketPath);
      try {
        await w.send(enc("type", { kind: "electron", caps: ["dialog"] }));
        await w.send(enc("action", { type: "c:pick" }));
        await w.waitFor(
          () => w.frames.some((f) => f.t === "dialog"),
          "a dialog frame",
        );
        const ask = w.frames.find((f) => f.t === "dialog")!.d as {
          id: string;
          kind: string;
          title: string;
        };
        assertEquals(ask.kind, "files");
        assertEquals(ask.title, "Pick");
        await w.send(enc("dialog-result", {
          id: ask.id,
          canceled: false,
          paths: ["/a.txt", "/b c.txt"],
        }));
        assertEquals(await calls[0], ["/a.txt", "/b c.txt"]);
      } finally {
        w.close();
      }
    });
  },
});

Deno.test({
  name: "uds: cancel in the window is null",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withUds(async (socketPath, calls) => {
      const w = await peer(socketPath);
      try {
        await w.send(enc("type", { kind: "electron", caps: ["dialog"] }));
        await w.send(enc("action", { type: "c:pick" }));
        await w.waitFor(() => w.frames.some((f) => f.t === "dialog"), "ask");
        const { id } = w.frames.find((f) => f.t === "dialog")!.d as {
          id: string;
        };
        await w.send(enc("dialog-result", { id, canceled: true, paths: [] }));
        assertEquals(await calls[0], null);
      } finally {
        w.close();
      }
    });
  },
});

Deno.test({
  name:
    "uds: the window closing mid-dialog REJECTS the pick (not a cancel, not a hang)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withUds(async (socketPath, calls) => {
      const w = await peer(socketPath);
      await w.send(enc("type", { kind: "electron", caps: ["dialog"] }));
      await w.send(enc("action", { type: "c:pick" }));
      await w.waitFor(() => w.frames.some((f) => f.t === "dialog"), "ask");
      w.close();
      // Bounded: a regression here is a HANG (a pick nobody will ever
      // answer), and a hang must read as a red test, not a stuck suite.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () =>
            rej(new Error("the pick never settled after the window closed")),
          5000,
        );
      });
      try {
        await assertRejects(
          () => Promise.race([calls[0]!, deadline]),
          Error,
          "closed before the dialog was answered",
        );
      } finally {
        clearTimeout(timer);
      }
    });
  },
});

Deno.test({
  name:
    "uds: a peer that did NOT announce dialogs is never a dialog host — even with a window connected beside it",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withUds(async (socketPath, _calls, probes) => {
      const win = await peer(socketPath);
      const cli = await peer(socketPath);
      try {
        await win.send(enc("type", { kind: "electron", caps: ["dialog"] }));
        await cli.send(enc("type", { kind: "electron" })); // no caps
        await cli.send(enc("type", { kind: "electron", caps: ["other"] }));
        await cli.send(
          enc("action", { type: "c:probe", payload: { who: "cli" } }),
        );
        await win.send(
          enc("action", { type: "c:probe", payload: { who: "win" } }),
        );
        await cli.waitFor(
          () => "cli" in probes && "win" in probes,
          "both probes",
        );
        assertEquals(
          probes.cli,
          null,
          "the CLI peer's call must not open a dialog in someone's window",
        );
        assertStringIncludes(String(probes.win), "Electron window");
        assert(!cli.frames.some((f) => f.t === "dialog"));
      } finally {
        win.close();
        cli.close();
      }
    });
  },
});

// A serverFn is the other door a pick comes through (`serverFn("files").open()`
// from the UI). Same rule: the calling connection decides.
const SFN_NS = `pickprobe-${crypto.randomUUID().slice(0, 8)}`;
serverFns(SFN_NS, {
  who: () => dialogHostForCall()?.label ?? null,
});

Deno.test({
  name: "uds: a serverFn call runs as a call from ITS connection too",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withUds(async (socketPath) => {
      const win = await peer(socketPath);
      const cli = await peer(socketPath);
      try {
        await win.send(enc("type", { kind: "electron", caps: ["dialog"] }));
        await new Promise((r) => setTimeout(r, 30));
        const ask = (p: Peer, cid: string) =>
          p.send(enc("sfn", { cid, ns: SFN_NS, name: "who", args: [] }));
        await ask(cli, "c1");
        await ask(win, "w1");
        const reply = (p: Peer, cid: string) =>
          p.frames.find((f) =>
            f.t === "sfnr" && (f.d as { cid?: string }).cid === cid
          )?.d as { cid: string; ok: boolean; value?: unknown } | undefined;
        await cli.waitFor(() => !!reply(cli, "c1"), "cli sfnr");
        await win.waitFor(() => !!reply(win, "w1"), "win sfnr");
        assertEquals(reply(cli, "c1"), { cid: "c1", ok: true, value: null });
        assertStringIncludes(
          String(reply(win, "w1")?.value),
          "Electron window",
        );
      } finally {
        win.close();
        cli.close();
      }
    });
  },
});

Deno.test({
  name:
    "uds: a pick started AFTER its window closed rejects at once — it cannot hang",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // The stale-host case: a long method takes the window's host into its
    // scope, the window closes while it works, and only THEN does it call
    // pickFile. The frame would go to a dead socket and nothing would ever
    // answer it.
    await withUds(async (socketPath, _calls, _probes, hostsSeen) => {
      const w = await peer(socketPath);
      await w.send(enc("type", { kind: "electron", caps: ["dialog"] }));
      await w.send(enc("action", { type: "c:probe", payload: { who: "win" } }));
      await w.waitFor(() => hostsSeen.length > 0, "the host");
      const host = hostsSeen[0]!;
      w.close();
      // The close is asynchronous on the server side; wait for the roster to
      // forget it, then ask the dead window for a dialog.
      const t0 = Date.now();
      while (dialogHostForCall() !== null && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("open() on a dead window never settled")),
          5000,
        );
      });
      try {
        await assertRejects(
          () =>
            Promise.race([
              host.open({ kind: "file", title: "too late" }),
              deadline,
            ]),
          Error,
          "window closed",
        );
      } finally {
        clearTimeout(timer);
      }
    });
  },
});
