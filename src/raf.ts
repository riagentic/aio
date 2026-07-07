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
