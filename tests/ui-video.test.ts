// `testUI --video=`: the flag, the frozen page, and the look read from the
// app's entry. The pixels are ui-video-e2e's job; these pin what decides them.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  readRunLook,
  snapshotDocument,
  uiVideoConfig,
} from "../src/testing/ui-video.ts";
import { parseCli } from "../src/server/aio-cli.ts";

const noEnv = () => undefined;
const env = (vars: Record<string, string>) => (n: string) => vars[n];

Deno.test("uiVideoConfig: no flag and no env → no video", () => {
  assertEquals(uiVideoConfig([], noEnv), null);
  assertEquals(uiVideoConfig(["--filter", "x"], noEnv), null);
});

Deno.test("uiVideoConfig: a directory, a file, the space form, env, and pace", () => {
  assertEquals(uiVideoConfig(["--video=videos/"], noEnv), {
    path: "videos/",
    kind: "dir",
    format: "mp4",
    paceMs: 800,
  });
  assertEquals(
    uiVideoConfig(["--video", "out/demo.webm", "--video-pace=300"], noEnv),
    {
      path: "out/demo.webm",
      kind: "file",
      format: "webm",
      paceMs: 300,
    },
  );
  assertEquals(
    uiVideoConfig([], env({ AIO_VIDEO: "a.mp4", AIO_VIDEO_PACE: "100" })),
    { path: "a.mp4", kind: "file", format: "mp4", paceMs: 100 },
  );
  // The same value in both places is not a disagreement.
  assertEquals(
    uiVideoConfig(["--video=a.mp4"], env({ AIO_VIDEO: "a.mp4" }))?.path,
    "a.mp4",
  );
});

Deno.test("uiVideoConfig: every mistake throws instead of quietly recording nothing", () => {
  const cases: [string[], Record<string, string>, string][] = [
    [["--videos=x/"], {}, "unknown flag --videos"],
    [["--video"], {}, "needs a value"],
    [["--video", "--video-pace=100"], {}, "needs a value"],
    [["--video-pace=100"], {}, "without --video"],
    [[], { AIO_VIDEO_PACE: "100" }, "without --video"],
    [["--video=a.mp4"], { AIO_VIDEO: "b.mp4" }, "disagree"],
    [["--video=x/", "--video-pace=10"], {}, "50–60000"],
    [["--video=x/", "--video-pace=1.5e3x"], {}, "50–60000"],
    [["--video=demo.mov"], {}, ".mp4 or .webm"],
  ];
  for (const [args, vars, msg] of cases) {
    assertThrows(
      () => uiVideoConfig(args, env(vars)),
      Error,
      msg,
      args.join(" "),
    );
  }
});

Deno.test("--video is the HARNESS's flag: a test process's boot parses it, an app never does", async () => {
  // In this process ui-video.ts is loaded, so every in-process boot (testUI's
  // refusals, testServer's aio.run) reads the test run's arguments without
  // calling --video an unknown app flag.
  parseCli(["--video=videos/", "--video-pace=200"]);
  parseCli(["--video", "videos/"]);
  // An app that never loaded the test harness still refuses it: the flag
  // must not become something `aio.run` silently accepts.
  const o = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { parseCli } from ${
        JSON.stringify(
          new URL("../src/server/aio-cli.ts", import.meta.url).href,
        )
      };
       try { parseCli(["--video=x.mp4"]); console.log("ACCEPTED"); }
       catch (e) { console.log("REFUSED " + e.message); }`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(o.stdout);
  assertStringIncludes(out, "REFUSED");
  assertStringIncludes(out, "--video");
});

Deno.test("snapshotDocument: live values, checked state, marks, and no scripts or handlers", async () => {
  const win = new Window({ url: "http://localhost/" });
  try {
    const doc = win.document;
    doc.title = "t";
    doc.documentElement.setAttribute("data-theme", "dark");
    const style = doc.createElement("style");
    style.textContent = "a{color:red}</style><script>x</script>";
    doc.head.appendChild(style);
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    root.innerHTML =
      `<input id=name value="old"><input type=checkbox id=c checked>` +
      `<textarea id=t>seed</textarea><select id=s><option value=a>a</option><option value=b>b</option></select>` +
      `<button onclick="evil()">Go &amp; "go"</button><script>alert(1)</script>`;
    const input = doc.getElementById("name") as unknown as HTMLInputElement;
    input.value = "typed <b>";
    (doc.getElementById("c") as unknown as HTMLInputElement).checked = false;
    (doc.getElementById("t") as unknown as HTMLTextAreaElement).value = "live";
    (doc.getElementById("s") as unknown as HTMLSelectElement).value = "b";
    input.focus();
    const button = root.querySelector("button");
    const snap = snapshotDocument(doc, root, button, "GoButton · click");

    assertEquals(snap.title, "t");
    assertEquals(snap.caption, "GoButton · click");
    assertEquals(snap.htmlAttrs, [["data-theme", "dark"]]);
    assertStringIncludes(snap.head, "a{color:red}<\\/style>");
    assertStringIncludes(snap.body, '<div id="root">');
    assertStringIncludes(snap.body, 'value="typed &lt;b>"');
    assertStringIncludes(snap.body, "data-aio-video-focus");
    assert(
      !/id="c"[^>]*checked/.test(snap.body),
      "a box unchecked live is unchecked in the picture",
    );
    assertStringIncludes(snap.body, ">live</textarea>");
    assert(/<option value="b" selected="">/.test(snap.body), snap.body);
    assert(
      /<button data-aio-video-target="">Go &amp; "go"<\/button>/.test(
        snap.body,
      ),
      snap.body,
    );
    assert(
      !snap.body.includes("onclick") && !snap.body.includes("<script"),
      snap.body,
    );
  } finally {
    await closeWindow(win);
  }
});

Deno.test("readRunLook: literal keys are read, non-literals are named, comments and strings are not the call", () => {
  const src = `// aio.run({ theme: "full" }) — a comment, not the call
const s = "aio.run({ theme: 'full' })";
await aio.run({
  cells: [todo],
  appId: "ex-todo",
  ui: { theme: "auto", layout: false },
  lang: pick(),
});`;
  assertEquals(readRunLook(src), {
    appId: "ex-todo",
    theme: "auto",
    layout: false,
    unread: ["lang"],
  });
  assertEquals(readRunLook("export default 1"), { unread: [] });
});
