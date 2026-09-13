// A client whose UI never mounted must SAY so when asked for its surface.
//
// Measured on a live app whose component read a `visible.exclude`d field:
// the tab blank-screened ("BLANK SCREEN (boot): settings.apiKey read in client
// context" in the server log), and then
//   · `am surface` printed `[]` — an empty UI, exit 0;
//   · `am trigger "App:LightButton" click` answered
//     `"available":["window"]` — a missing button.
// Both true, neither the answer: the page had a boot error, and the client
// was the one party that knew it (the shell's `data-aio-blank-screen` card).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { routeCommand } from "../src/browser/browser-air-commands.ts";
import { dec, enc } from "../src/protocol/envelope.ts";

const BOOT_ERR =
  "Error: [aio] settings.apiKey read in client context — the field is listed in visible.exclude.";

/** A page as the shell leaves it after `_fail("boot", err)`. */
function blankPage(win: Window): void {
  const root = win.document.createElement("div");
  root.id = "root";
  const box = win.document.createElement("div");
  box.dataset.aioBlankScreen = "boot";
  const head = win.document.createElement("div");
  head.textContent = "[aio] blank screen — boot";
  const pre = win.document.createElement("pre");
  pre.textContent =
    `${BOOT_ERR}\n    at App (http://localhost/app.js:1:22)\n    at mount (http://localhost/air.js:9:1) (in <App>)`;
  box.append(head, pre);
  root.appendChild(box);
  win.document.body.appendChild(root);
}

/** Send one frame through the client's router and return the decoded reply. */
async function ask(t: "ui-surface" | "ui-trigger", d?: unknown) {
  let reply: string | undefined;
  routeCommand(dec(enc(t, d))!, (m) => (reply = m));
  for (let i = 0; i < 50 && reply === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(reply !== undefined, `${t}: no reply`);
  return dec(reply)!.d as Record<string, unknown>;
}

async function withDocument(
  fill: (win: Window) => void,
  fn: () => Promise<void>,
): Promise<void> {
  const win = new Window({ url: "http://localhost/" });
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = win.document;
  try {
    fill(win);
    await fn();
  } finally {
    g.document = prev;
    await closeWindow(win);
  }
}

Deno.test("ui-surface: a blank-screened client replies with its boot error", async () => {
  await withDocument(blankPage, async () => {
    const d = await ask("ui-surface");
    assert(
      !Array.isArray(d),
      `an empty surface hid the error: ${JSON.stringify(d)}`,
    );
    assertStringIncludes(String(d.error), "blank screen (boot)");
    assertStringIncludes(
      String(d.error),
      "settings.apiKey read in client context",
    );
    assertStringIncludes(String(d.error), "(in <App>)");
    // The error, not a stack dump.
    assert(!String(d.error).includes("app.js:1:22"), String(d.error));
    // --rects asks the same client the same question.
    const r = await ask("ui-surface", { rects: true });
    assertStringIncludes(String(r.error), "blank screen (boot)");
  });
});

Deno.test("ui-trigger: a miss on a blank-screened client names the boot error", async () => {
  await withDocument(blankPage, async () => {
    const d = await ask("ui-trigger", {
      path: "App:LightButton",
      action: "click",
    });
    assertEquals(d.ok, false);
    assertStringIncludes(String(d.error), "blank screen (boot)");
    assertStringIncludes(
      String(d.error),
      "settings.apiKey read in client context",
    );
    // `available` still travels — the recovery list is not replaced.
    assert(Array.isArray(d.available), JSON.stringify(d));
  });
});

Deno.test("ui-surface: a healthy empty page still answers an empty list", async () => {
  await withDocument((win) => {
    const root = win.document.createElement("div");
    root.id = "root";
    win.document.body.appendChild(root);
  }, async () => {
    const d = await ask("ui-surface");
    assertEquals(d, [] as unknown as Record<string, unknown>);
  });
});

Deno.test("am surface: a client's { error } reply is an error, a surface is not", async () => {
  const { surfaceReplyError } = await import("../src/am/am-cmd-inspect.ts");
  assertEquals(surfaceReplyError({ error: "blank screen" }), "blank screen");
  assertEquals(surfaceReplyError([]), null);
  assertEquals(surfaceReplyError([{ component: "App" }]), null);
  assertEquals(surfaceReplyError({ roots: [], measured: {} }), null);
  assertEquals(surfaceReplyError(null), null);
});
