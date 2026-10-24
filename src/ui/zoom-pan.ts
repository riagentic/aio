// zoom-pan.ts — `ZoomPan`: a viewport whose content zooms at the cursor (wheel),
// pans by drag, and fits on request; a click that ends a drag is not a click.
// The camera math is pure and exported, so an app can test it without a DOM.
import { h } from "../air/vdom.ts";
import { onCleanup, onMount, useRef, useSignal } from "../air/aio-renderer.ts";
import type { VChild, VNode } from "../air/vdom.ts";
import { _noteKitRender } from "./styles.ts";

/** Where the camera is: content point (0,0) sits at (`x`, `y`) in the
 *  viewport, drawn `scale` times its size. */
export interface ZoomView {
  x: number;
  y: number;
  scale: number;
}

/** Zoom `view` by `factor` keeping viewport point (`px`, `py`) — the cursor —
 *  over the same content point; the scale is clamped to [`min`, `max`]. Pure. */
export function zoomAt(
  view: ZoomView,
  factor: number,
  px: number,
  py: number,
  min = 0.1,
  max = 10,
): ZoomView {
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const k = scale / view.scale;
  return { x: px - (px - view.x) * k, y: py - (py - view.y) * k, scale };
}

/** The view that shows a `content` box whole and centred in a `viewport` box,
 *  `pad` px from its edges, the scale clamped to [`min`, `max`]. Pure. */
export function fitView(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  pad = 16,
  min = 0.1,
  max = 10,
): ZoomView {
  if (!(content.width > 0 && content.height > 0)) {
    return { x: 0, y: 0, scale: 1 };
  }
  const scale = Math.min(
    max,
    Math.max(
      min,
      Math.min(
        (viewport.width - 2 * pad) / content.width,
        (viewport.height - 2 * pad) / content.height,
      ),
    ),
  );
  return {
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
    scale,
  };
}

/** Props for {@link ZoomPan}. */
export interface ZoomPanProps {
  children?: VChild;
  /** Smallest / largest scale. Default 0.1 / 10. */
  minScale?: number;
  maxScale?: number;
  /** The starting view. Default `{ x: 0, y: 0, scale: 1 }`. */
  initial?: ZoomView;
  /** Fired with every new view (wheel, drag, a button). */
  onView?: (view: ZoomView) => void;
  /** Show the ＋ / － / fit buttons. Default `true`. */
  controls?: boolean;
  class?: string;
  style?: Record<string, string | number>;
  [attr: string]: unknown;
}

/** How far a press may move and still be a click, in px. */
const DRAG_SLOP = 4;
const STEP = 1.25;

/** A zoomable, pannable viewport — a diagram, a map, a big image. Wheel zooms
 *  at the cursor, a drag pans (and the click that ends it does not reach the
 *  content), the buttons zoom about the centre or fit the content. Size the
 *  viewport with `style`/`class` (it fills its box, `overflow: hidden`). */
export function ZoomPan(props: ZoomPanProps): VNode {
  _noteKitRender("aio-zoompan");
  const {
    children,
    minScale = 0.1,
    maxScale = 10,
    initial,
    onView,
    controls = true,
    class: cls,
    style,
    ...attrs
  } = props;
  const view = useSignal<ZoomView>(initial ?? { x: 0, y: 0, scale: 1 });
  const box = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  // Read at event time: the listeners are attached once, at mount.
  const opts = useRef({ minScale, maxScale, onView });
  opts.current = { minScale, maxScale, onView };
  const set = (v: ZoomView) => {
    view.set(v);
    opts.current.onView?.(v);
  };
  const zoomCentre = (factor: number) => {
    const el = box.current;
    const { minScale: lo, maxScale: hi } = opts.current;
    set(
      zoomAt(
        view.peek(),
        factor,
        (el?.clientWidth ?? 0) / 2,
        (el?.clientHeight ?? 0) / 2,
        lo,
        hi,
      ),
    );
  };
  const fit = () => {
    const el = box.current, content = stage.current;
    if (!el || !content) return;
    const { minScale: lo, maxScale: hi } = opts.current;
    set(
      fitView(
        { width: content.scrollWidth, height: content.scrollHeight },
        { width: el.clientWidth, height: el.clientHeight },
        16,
        lo,
        hi,
      ),
    );
  };
  onMount(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // the page must not scroll under a zoom
      const r = el.getBoundingClientRect();
      const { minScale: lo, maxScale: hi } = opts.current;
      set(
        zoomAt(
          view.peek(),
          Math.exp(-e.deltaY * 0.0015),
          e.clientX - r.left,
          e.clientY - r.top,
          lo,
          hi,
        ),
      );
    };
    let press: { x: number; y: number; from: ZoomView } | null = null;
    let dragged = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      press = { x: e.clientX, y: e.clientY, from: view.peek() };
      dragged = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!press) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!dragged && Math.hypot(dx, dy) < DRAG_SLOP) return;
      dragged = true;
      set({ ...press.from, x: press.from.x + dx, y: press.from.y + dy });
    };
    const onUp = () => void (press = null);
    // Capture phase, so the content's own click handler never sees the click
    // that ends a drag.
    const onClick = (e: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    onCleanup(() => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
    });
  });
  const v = view.value;
  const btn = (label: string, aria: string, onClick: () => void) =>
    h("button", {
      type: "button",
      class: "aio-zoompan__btn",
      "aria-label": aria,
      onClick,
    }, label);
  return h(
    "div",
    {
      ...attrs,
      ref: box,
      class: cls ? `aio-zoompan ${cls}` : "aio-zoompan",
      style,
    },
    h("div", {
      ref: stage,
      class: "aio-zoompan__stage",
      style: {
        transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale})`,
      },
    }, children),
    controls
      ? h(
        "div",
        { class: "aio-zoompan__controls" },
        btn("+", "Zoom in", () => zoomCentre(STEP)),
        btn("−", "Zoom out", () => zoomCentre(1 / STEP)),
        btn("⤢", "Fit", fit),
      )
      : null,
  );
}
