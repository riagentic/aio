// deno-lint-ignore-file
// browser-air-commands: Server command routing for AIR transport.
// Routes server-initiated control frames (surfaces, triggers, time-travel,
// diag, acks, vitals) — v2 envelope, one decoded frame in, one reply out.

import { handleTTMessage } from "../air/time-travel-panel.ts";
import {
  _setDevChunkLoader,
  devHooks,
  loadDevChunk,
  type UiRemoteApi,
} from "../air/dev-hooks.ts";
import { _vitalsTransportProbe, _w } from "./browser-protocol.ts";
import { _rejectAck, _resolveAck } from "./browser-ack.ts";
import { _deliverDiag } from "../protocol/protocol-diagnostics.ts";
import { subsRefusedByServer } from "../state/state-subs.ts";
import {
  type AckPayload,
  enc,
  type Frame,
  wireError,
} from "../protocol/envelope.ts";
import type { VitalsPong } from "../vitals/transport-probe.ts";

/** The page's boot failure, when it has one — else null.
 *
 *  A page whose UI never mounted answered `am surface` with `[]` and a trigger
 *  with `available: ["window"]`: both true, and both read as "the UI is empty"
 *  rather than "the UI crashed", while the server log said BLANK SCREEN. The
 *  shell's blank-screen card (`data-aio-blank-screen`, server-html-gen.ts) is
 *  where that error lives on the client — and a later successful mount clears
 *  the root, so a card that is there is a failure that still stands.
 *
 *  The message and the component chain, not the stack: this lands in a CLI
 *  line, and the full trace is already in the server's log. */
export function blankScreenError(): string | null {
  const doc = (globalThis as {
    document?: { querySelector?: (s: string) => Element | null };
  }).document;
  const card = doc?.querySelector?.("[data-aio-blank-screen]");
  if (!card) return null;
  const stage = card.getAttribute("data-aio-blank-screen") || "boot";
  const text = card.querySelector("pre")?.textContent ?? "";
  const chain = / \(in <[^\n]*\)\s*$/.exec(text)?.[0] ?? "";
  const message = text.slice(0, text.length - chain.length).split("\n")
    .filter((l) => !/^\s*at /.test(l)).join(" ").trim();
  const capped = message.length > 1500 ? `${message.slice(0, 1500)}…` : message;
  return `the page hit a blank screen (${stage}) — its UI never mounted: ` +
    `${capped || "(no details)"}${chain}`;
}

// THE ONE `import()` of the dev-only chunk (air/dev-hooks.ts explains what is
// in it and why none of it can run on a production page). It is registered
// HERE rather than in the transport because this is the module every browser
// path already reaches — the transport imports it for `routeCommand`, and so
// does anything driving the command router on its own — while `air/` may not
// import `browser/` and so cannot hold the import itself.
_setDevChunkLoader(() => import("./dev-diagnostics.ts"));

/** The surface/trigger executor, loading the dev-only chunk it lives in if it
 *  is not here yet.
 *
 *  Both frames arrive from ONE sender — the trojan REST API — which
 *  `server-static.ts` never mounts in production, so on a production page this
 *  path is unreachable and `ui-remote.ts` + its two engines (24 KB raw) are
 *  not in the bundle at all. Asking for the chunk here rather than assuming it
 *  keeps the tool working in every case where the frame CAN arrive, and
 *  `loadDevChunk` says so out loud if it cannot be fetched. */
async function uiRemote(): Promise<UiRemoteApi | null> {
  if (!devHooks.uiRemote) await loadDevChunk();
  return devHooks.uiRemote;
}

/** What a surface/trigger reply says when the engine is not on this page.
 *  Never silence: a caller that gets `[]` reads it as "the UI is empty". */
const NO_ENGINE = "the aio dev tooling engine is not on this page — " +
  "`am surface` / `am trigger` need the dev-only chunk, which a production " +
  "bundle does not carry (run the app with `aio dev`)";

/** Route server-initiated command frames. Returns true if consumed. */
export function routeCommand(
  f: Frame,
  sendRaw: (msg: string) => void,
): boolean {
  switch (f.t) {
    case "ui-surface":
      // Reply async — the executor lives in the dev-only chunk, which is
      // fetched on demand (it is not in a production bundle).
      (async () => {
        try {
          const engine = await uiRemote();
          if (!engine) {
            sendRaw(enc("ui-surface-result", { error: NO_ENGINE }));
            return;
          }
          // `full` lifts the text cap (`am surface --full`); `rects` attaches
          // layout geometry (`am surface --rects`). The rects reply is an
          // OBJECT, not an array, because the measurement counts travel with
          // it — see getMeasuredSurfaces.
          const d = f.d as { full?: boolean; rects?: boolean } | undefined;
          const result = d?.rects === true
            ? engine.getMeasuredSurfaces(d.full === true)
            : engine.getSerializedSurfaces(d?.full === true);
          const roots = Array.isArray(result) ? result : result.roots;
          // Nothing mounted AND a boot failure on the page: the error is the
          // answer, in the `{ error }` shape this reply already uses for a
          // throw.
          const crashed = roots.length === 0 ? blankScreenError() : null;
          sendRaw(enc(
            "ui-surface-result",
            crashed ? { error: crashed } : result,
          ));
        } catch (e) {
          sendRaw(enc("ui-surface-result", { error: String(e) }));
        }
      })();
      return true;

    case "ui-trigger":
      // Reply async — the trigger settles the app before responding.
      (async () => {
        try {
          const engine = await uiRemote();
          if (!engine) {
            sendRaw(enc("ui-trigger-result", { ok: false, error: NO_ENGINE }));
            return;
          }
          const result = await engine.runUITrigger(
            f.d as Parameters<UiRemoteApi["runUITrigger"]>[0],
          );
          // A miss on a page that never mounted is not a typo'd path — say
          // what happened to the page, and keep `available` beside it.
          const crashed = result.ok ? null : blankScreenError();
          sendRaw(enc(
            "ui-trigger-result",
            crashed
              ? { ...result, error: `${result.error} — ${crashed}` }
              : result,
          ));
        } catch (e) {
          sendRaw(enc("ui-trigger-result", { ok: false, error: String(e) }));
        }
      })();
      return true;

    case "tt-state":
      handleTTMessage(f.d as object);
      return true;

    case "diag":
      // ONE sink (protocol-diagnostics `_deliverDiag`): overlay when the page
      // has one, console otherwise. Four hand-written copies of this check
      // meant a server-sent diagnostic vanished on every page without the dev
      // overlay — which is every page, since nothing injects it.
      _deliverDiag(f.d as Record<string, unknown>);
      // A refused SUBSCRIPTION is not only a message — the client has to act
      // on it, or it goes on believing it is subscribed to a set the server
      // never accepted. See `subsRefusedByServer`.
      if ((f.d as { type?: unknown } | null)?.type === "ws-subs") {
        subsRefusedByServer();
      }
      return true;

    // AIO-2.2: per-action ack — settles the Promise returned by an awaited
    // cell method (registered in browser-ack).
    case "ack": {
      const d = (f.d ?? {}) as AckPayload;
      const { cid, ok, value } = d;
      if (typeof cid === "string") {
        // `wireError` keeps the server's failure CODE on the rejection, so an
        // app can branch with `errorCode(e) === "ACCESS_DENIED"` instead of
        // matching a message the semver policy never promised to keep.
        if (ok) _resolveAck(cid, value);
        else _rejectAck(cid, wireError(d, "server rejected action"));
      }
      return true;
    }

    // Vitals pong — forward to the transport probe so RTT/staleness stays
    // fresh in AIR/IPC mode (the WS handler in browser-air-transport.ts
    // never sees these frames).
    case "vitals-pong":
      try {
        if (_vitalsTransportProbe) {
          _vitalsTransportProbe.processPong(f.d as VitalsPong);
        }
      } catch { /* ignore malformed pong */ }
      return true;

    default:
      return false;
  }
}
