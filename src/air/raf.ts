import { onCleanup, onMount, useRef } from "./aio-renderer.ts";
import { _reportHookError } from "./hook-error.ts";

/** Report a throw from a REPEATING callback: loud on the first one, then at
 *  most one line every {@linkcode LOOP_ERROR_SUMMARY_MS} carrying the count.
 *
 *  `_reportHookError` logs on every call, which is right for a hook that runs
 *  once per render and wrong at 60 Hz: a `useRaf` callback that throws every
 *  frame would write 60 stack traces a second, and a console nobody can read
 *  is as silent as no console at all. The first failure is what a developer
 *  needs; the count is what tells them it is still happening.
 *
 *  One reporter per LOOP INSTANCE (created inside the start function), so a
 *  remount reports afresh rather than inheriting a suppressed state. */
const LOOP_ERROR_SUMMARY_MS = 5000;
function _loopErrorReporter(kind: string): (e: unknown) => void {
  let since = 0, suppressed = 0;
  return (e: unknown) => {
    const now = Date.now();
    if (since === 0) {
      since = now;
      _reportHookError(kind, e);
      return;
    }
    suppressed++;
    if (now - since >= LOOP_ERROR_SUMMARY_MS) {
      console.error(
        `[aio-renderer] ${kind} callback has thrown ${suppressed} more time(s) ` +
          `in the last ${
            Math.round((now - since) / 1000)
          }s — the loop is still ` +
          `running and still failing. Latest:`,
        e,
      );
      since = now;
      suppressed = 0;
    }
  };
}

/**
 * The `active` flag of {@linkcode useRaf} / {@linkcode useInterval}: start the
 * loop while active, stop it while not, always stop on unmount.
 *
 * REACTIVE by construction, and it has to be. `onMount` fires exactly once per
 * instance, so reading `active` only there froze it at its mount-time value —
 * the documented `active={game.screen === "playing"}` could then neither start
 * a sequencer that mounted on the title screen nor stop one when the player
 * paused. The component body re-runs on every render, so the flag is re-read
 * here, where a change can still act on it.
 *
 * Shared by both hooks on purpose: two hand-maintained copies of a lifecycle
 * this fiddly diverge, and the one that lags is the one nobody tests.
 *
 * `start` returns its own stop function, so each hook owns its teardown.
 */
function useActiveLoop(active: boolean, start: () => () => void): void {
  const h = useRef<{ stop: (() => void) | null; mounted: boolean }>({
    stop: null,
    mounted: false,
  });
  const run = () => {
    if (!h.current.stop) h.current.stop = start();
  };
  const halt = () => {
    const stop = h.current.stop;
    h.current.stop = null;
    stop?.();
  };
  // A re-render: `active` may have flipped since the last pass. Only act once
  // MOUNTED — before that the first start belongs to onMount below, so a
  // component that renders before it is in the document does not begin
  // ticking against a DOM that is not there yet.
  if (h.current.mounted) {
    if (active) run();
    else halt();
  }
  onMount(() => {
    h.current.mounted = true;
    if (active) run();
    // Registered INSIDE onMount ⇒ unmount only, never on re-render (the
    // re-render path above owns stopping).
    onCleanup(() => {
      h.current.mounted = false;
      halt();
    });
  });
}

/**
 * Run `cb` on every animation frame until the component unmounts — a managed
 * `requestAnimationFrame` loop with automatic cleanup (no manual
 * cancelAnimationFrame bookkeeping).
 *
 * `cb` receives the high-res frame timestamp (ms) and the delta since the
 * previous frame (0 on the first frame). The latest `cb` is always used, so a
 * closure reading live cell state stays current across re-renders.
 *
 * `active` is live: pass an expression over cell state
 * (`active={game.screen === "playing"}`) and the loop really starts and stops
 * with it — the frame callback is cancelled while inactive rather than called
 * and ignored. The delta resets on each restart, so a paused game does not
 * resume with a multi-second `dt`.
 *
 * Must be called inside a component function body during render.
 *
 * ```ts
 * function Canvas() {
 *   const ref = useRef<HTMLCanvasElement>(null!);
 *   useRaf((_t, dt) => {
 *     const ctx = ref.current?.getContext("2d");
 *     if (ctx) draw(ctx, cycle.phase, dt); // live cell read
 *   });
 *   return <canvas ref={ref} />;
 * }
 * ```
 */
export function useRaf(
  cb: (time: number, delta: number) => void,
  active = true,
): void {
  // Keep the latest callback so the loop never calls a stale closure.
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useActiveLoop(active, () => {
    if (typeof requestAnimationFrame === "undefined") return () => {};
    let id = 0;
    let prev = 0;
    let first = true;
    const report = _loopErrorReporter("useRaf");
    const loop = (t: number) => {
      const delta = first ? 0 : t - prev;
      first = false;
      prev = t;
      // RE-ARM FIRST, and contain the callback's throw.
      //
      // This used to call `cb` and then schedule the next frame on the line
      // after it. A self-rescheduling loop that re-arms LAST dies on the first
      // exception: the next `requestAnimationFrame` never runs, and nothing
      // ever restarts it. The component stays mounted, `active` stays true,
      // `onCleanup` never fires — the animation simply stops, forever, with
      // one line in the console that reads like a transient error. A canvas
      // game, a sequencer, a chart that stops redrawing after one bad frame is
      // exactly the silent-broken-UI class this project treats as disqualifying.
      //
      // `setInterval` (useInterval below) self-heals here because the platform
      // re-arms it; this loop is the one that had to do it itself.
      //
      // Contained the same way every other user callback in the render
      // pipeline is (`_reportHookError`): logged loudly and NAMED, and then
      // the loop stands. Continuing on a callback that throws every frame is
      // the deliberate choice — the alternative is a frozen surface.
      id = requestAnimationFrame(loop);
      try {
        cbRef.current(t, delta);
      } catch (e) {
        report(e);
      }
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  });
}

/**
 * Run `cb` every `ms` milliseconds until the component unmounts — a managed
 * `setInterval` with automatic cleanup. The client-side idiom for any cadence
 * that isn't per-frame: a music sequencer's beat, a poll, a clock tick.
 * (`schedule.every` runs on the SERVER — there is no `AudioContext` there;
 * a field report.)
 *
 * The latest `cb` is always used, so a closure reading live cell state stays
 * current across re-renders.
 *
 * `active` is live: the example below really starts the sequencer when play
 * begins and clears the interval when the player pauses — the timer stops, it
 * is not left ticking into a callback that returns early. A `ms` change takes
 * effect on the next start, so flip `active` off and on to change tempo (or
 * branch inside `cb`).
 *
 * Must be called inside a component function body during render.
 *
 * ```ts
 * function Music() {
 *   useInterval(() => audio.step(), 150, game.screen === "playing");
 *   return null;
 * }
 * ```
 */
export function useInterval(
  cb: () => void,
  ms: number,
  active = true,
): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useActiveLoop(active, () => {
    // `setInterval` keeps firing after a throwing tick, so the loop cannot die
    // the way `useRaf`'s could — but an uncaught throw here still surfaces as
    // a bare "Uncaught (in ...)" with no component and no hook name, 1/ms
    // apart. Same reporter as every other user callback in the pipeline.
    const report = _loopErrorReporter("useInterval");
    const id = setInterval(() => {
      try {
        cbRef.current();
      } catch (e) {
        report(e);
      }
    }, ms);
    return () => clearInterval(id);
  });
}
