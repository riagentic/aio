// AIO Virtual List — useVirtualList hook for large list performance.
// Renders only visible items + overscan buffer. Signal-based.

import {
  type Computed,
  computed,
  type Signal,
  signal,
} from "../state/signal.ts";
import { isSignal } from "./signal-binding.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Configuration for {@linkcode useVirtualList}. */
export interface VirtualListConfig<T> {
  /** Total items array. */
  items: T[] | Signal<T[]>;
  /** Fixed item height in pixels. */
  itemHeight: number;
  /** Container height in pixels. */
  containerHeight: number;
  /** Number of extra items to render above/below viewport. Default 3. */
  overscan?: number;
  /** Optional ref to the scrollable container. When provided, `scrollToIndex`
   *  actually moves the scrollbar (the DOM scrollTop is the source of truth —
   *  setting only the signal would leave the scrollbar in place and the next
   *  user scroll would overwrite it). Attach the same ref to the container
   *  element via `h("div", { ref: vlist.containerRef, ... })`. */
  containerRef?: { current: HTMLElement | null };
}

/** Virtualized window state returned by {@linkcode useVirtualList}. */
export interface VirtualListState<T> {
  /** Visible items with their index and offset. */
  readonly visible: { item: T; index: number; offset: number }[];
  /** Total list height in pixels (for the scroll container). */
  readonly totalHeight: number;
  /** Current scroll offset. */
  readonly scrollTop: number;
  /** Handle scroll event — pass to container's onScroll. */
  onScroll(e: Event): void;
  /** Scroll to a specific item index. */
  scrollToIndex(index: number): void;
  /** The container ref passed in config (if any) — attach to the scrollable
   *  container so `scrollToIndex` can move the scrollbar. */
  readonly containerRef?: { current: HTMLElement | null };
  /** Container style — apply to the scrollable container. */
  readonly containerStyle: Record<string, string>;
  /** Inner style — apply to the inner wrapper that creates total height. */
  readonly innerStyle: Record<string, string>;
}

// ── useVirtualList ──────────────────────────────────────────────────

/**
 * Create a virtual scrolling list. Call outside the component body.
 *
 * ```ts
 * const vlist = useVirtualList({ items: bigArray, itemHeight: 40, containerHeight: 400 });
 *
 * const App = () => h("div", { style: vlist.containerStyle, onScroll: vlist.onScroll },
 *   h("div", { style: vlist.innerStyle },
 *     ...vlist.visible.map(({ item, index, offset }) =>
 *       h("div", { key: index, style: { position: "absolute", top: `${offset}px`, height: "40px" } },
 *         item.name,
 *       ),
 *     ),
 *   ),
 * );
 * ```
 */
export function useVirtualList<T>(
  config: VirtualListConfig<T>,
): VirtualListState<T> {
  const { itemHeight, containerHeight, overscan = 3 } = config;
  const safeItemHeight = Math.max(1, itemHeight);
  const scrollTopSig = signal(0);
  // Per LIST, not per module: two differently-broken lists each deserve their
  // own warning, and one of them must not silence the other.
  let warnedItems = false;

  // Resolve items — support both plain array and signal
  // AIO-289: robust type check using isSignal from signal-binding
  const getItems = (): T[] => {
    const items = config.items;
    // THE decider, not a local copy of it. This used to re-implement the
    // duck-type inline — and the copy tested `typeof === "object"`, which
    // stopped recognising a signal the day signals became callable, sending
    // every signal-backed list straight to the "items must be an array"
    // warning with an empty list behind it.
    if (isSignal(items)) return (items as Signal<T[]>).value;
    // Plain array
    if (Array.isArray(items)) {
      return items;
    }
    // Invalid input — return empty array and warn ONCE. `getItems()` runs
    // inside both the visible and total-height computeds, so this fired on
    // every scroll frame: the same misconfiguration printed hundreds of times,
    // which buries whatever the console was actually needed for. One warning
    // per list, like `_warnA11yOnce` / `_hinted` elsewhere.
    if (!warnedItems) {
      warnedItems = true;
      console.warn(
        `[aio:virtualList] items is ${
          items === null ? "null" : typeof items
        }, not an array or a Signal holding one — THE LIST IS RENDERING EMPTY. ` +
          `Pass items={myArray} or items={mySignal} (the signal itself, not ` +
          `mySignal.value — the list reads it so it can re-render on change).`,
      );
    }
    return [] as T[];
  };

  const visibleComputed: Computed<
    { item: T; index: number; offset: number }[]
  > = computed(() => {
    const items = getItems();
    const scrollTop = scrollTopSig.value;
    const visibleCount = Math.ceil(containerHeight / safeItemHeight) +
      2 * overscan;
    // The window start is clamped at BOTH ends. The upper clamp is the one
    // that was missing: when `items` SHRINKS under a scrolled list (a filter
    // typed into a search box, a page of results replaced by a shorter one)
    // the scroll offset still describes a row that no longer exists, so
    // `startIndex` landed past `items.length`, `endIndex` clamped BELOW it,
    // and the loop produced nothing — a blank list with a live scrollbar and
    // no error. Clamping to the last full window shows the end of the new
    // list, which is what a scrolled-to-the-bottom list should show.
    const maxStart = Math.max(0, items.length - visibleCount);
    const startIndex = Math.min(
      Math.max(0, Math.floor(scrollTop / safeItemHeight) - overscan),
      maxStart,
    );
    const endIndex = Math.min(items.length, startIndex + visibleCount);

    const result: { item: T; index: number; offset: number }[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      result.push({ item: items[i]!, index: i, offset: i * safeItemHeight });
    }
    return result;
  });

  const totalHeightComputed = computed(() =>
    getItems().length * safeItemHeight
  );

  return {
    get visible() {
      return visibleComputed.value;
    },
    get totalHeight() {
      return totalHeightComputed.value;
    },
    get scrollTop() {
      return scrollTopSig.value;
    },
    onScroll(e: Event) {
      const el = e.target as HTMLElement;
      scrollTopSig.set(el.scrollTop);
    },
    scrollToIndex(index: number) {
      const offset = Math.max(0, index) * safeItemHeight;
      scrollTopSig.set(offset);
      // The container's scrollTop is the source of truth — setting only the
      // signal would leave the scrollbar in place, and the next user scroll
      // would overwrite the signal with the unmoved scrollTop. If a container
      // ref is wired, actually scroll it.
      const el = config.containerRef?.current;
      if (el) el.scrollTo({ top: offset });
    },
    get containerRef() {
      return config.containerRef;
    },
    get containerStyle() {
      return {
        overflow: "auto",
        position: "relative",
        height: `${containerHeight}px`,
      };
    },
    get innerStyle() {
      return {
        height: `${totalHeightComputed.value}px`,
        position: "relative",
      };
    },
  };
}
