import { onCleanup, onMount, useRef } from "./aio-renderer.ts";

/**
 * Run `cb` on every animation frame until the component unmounts — a managed
 * `requestAnimationFrame` loop with automatic cleanup (no manual
 * cancelAnimationFrame bookkeeping).
 *
 * `cb` receives the high-res frame timestamp (ms) and the delta since the
 * previous frame (0 on the first frame). The latest `cb` is always used, so a
 * closure reading live cell state stays current across re-renders. Pass
 * `active: false` to not start the loop (e.g. behind a feature flag); for
 * frame-by-frame pausing, branch inside `cb`.
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

  onMount(() => {
    if (!active || typeof requestAnimationFrame === "undefined") return;
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
    onCleanup(() => cancelAnimationFrame(id));
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
 * current across re-renders. Pass `active: false` to keep it off (a paused
 * screen); changing `ms` between renders does not restart the interval — use
 * `active` to stop and remount, or branch inside `cb`, for tempo changes.
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

  onMount(() => {
    if (!active) return;
    const id = setInterval(() => cbRef.current(), ms);
    onCleanup(() => clearInterval(id));
  });
}
