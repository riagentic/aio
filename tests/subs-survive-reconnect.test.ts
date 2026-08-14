// A reconnect must not amnesia the client's subscription list.
//
// The server REPLACES its per-client list with whatever the next `subs` frame
// says. The client's memory of what it had subscribed to is `_accessedPaths` —
// and the first-state branch of `handleMessage` cleared it unconditionally.
// A reconnect re-enters that branch (`_resetInitialStateFlag()` runs on every
// transport swap) with the page still mounted, so the next path any component
// tracked — a route change, a newly mounted component — collapsed to a frame
// containing ONLY that path. Every cell dropped out of the list then stopped
// receiving updates: silently, permanently, and self-sustainingly, since a
// cell that gets no updates cannot re-render to re-track itself.
//
// This is AIO-170; the second (already-received) branch has carried a warning
// about it for releases, and the first branch never got one.
import { assert, assertEquals } from "@std/assert";
import {
  _accessedPaths,
  _resetSubs,
  _setSubsSendFn,
  trackPath,
} from "../src/state/state-subs.ts";
import {
  _resetInitialStateFlag,
  _resetMessageState,
  handleMessage,
} from "../src/state/state-message.ts";
import { dec } from "../src/protocol/envelope.ts";

/** The `subs` frames the client actually put on the wire. */
function captureSubs(): { frames: string[][]; stop: () => void } {
  const frames: string[][] = [];
  _setSubsSendFn((msg) => {
    const f = dec(msg);
    if (f && f.t === "subs") {
      frames.push((f.d as { subs: string[] }).subs);
    }
  });
  return { frames, stop: () => _setSubsSendFn(null) };
}

/** The subs timer coalesces on a 16ms tick. */
const flush = () => new Promise((r) => setTimeout(r, 40));

Deno.test("subs: a reconnect keeps every path the client had tracked", async () => {
  _resetSubs();
  _resetMessageState();
  const { frames, stop } = captureSubs();
  try {
    // First connect: the server's first frame is a full state.
    handleMessage({ todos: { items: [] }, prefs: { theme: "dark" } });
    // Two mounted components track two cells.
    trackPath("todos.items");
    trackPath("prefs.theme");
    await flush();
    assertEquals(frames.at(-1)?.sort(), ["prefs.theme", "todos.items"]);

    // The socket drops and comes back — same page, same components.
    _resetInitialStateFlag();
    handleMessage({ todos: { items: [] }, prefs: { theme: "dark" } });
    assert(
      _accessedPaths.has("todos.items") && _accessedPaths.has("prefs.theme"),
      "the reconnect must not erase what this client is subscribed to",
    );

    // A route change mounts one more component.
    trackPath("session.user");
    await flush();
    const last = frames.at(-1)!.sort();
    assertEquals(
      last,
      ["prefs.theme", "session.user", "todos.items"],
      "the server REPLACES its list from this frame — a partial frame " +
        "unsubscribes the cells it omits, forever",
    );
  } finally {
    stop();
    _resetSubs();
    _resetMessageState();
  }
});

Deno.test("subs: the FIRST state of a session still starts from a clean slate", async () => {
  _resetSubs();
  _resetMessageState();
  const { frames, stop } = captureSubs();
  try {
    // Paths tracked before any state arrives are render-time noise from a
    // previous page/app instance — the original reason the clear exists.
    handleMessage({ todos: { items: [] } });
    assertEquals(_accessedPaths.size, 0, "no leftovers on a true first state");
    trackPath("todos.items");
    await flush();
    assertEquals(frames.at(-1), ["todos.items"]);
  } finally {
    stop();
    _resetSubs();
    _resetMessageState();
  }
});
