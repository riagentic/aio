import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

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
    const loop = (t: number) => {
      const delta = first ? 0 : t - prev;
      first = false;
      prev = t;
      cbRef.current(t, delta);
      id = requestAnimationFrame(loop);
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
    const id = setInterval(() => cbRef.current(), ms);
    return () => clearInterval(id);
  });
}
