// AIO Virtual List — useVirtualList hook for large list performance.
// Renders only visible items + overscan buffer. Signal-based.

import {
  type Computed,
  computed,
  type Signal,
  signal,
} from "../state/signal.ts";

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

  // Resolve items — support both plain array and signal
  // AIO-289: robust type check using isSignal from signal-binding
  const getItems = (): T[] => {
    const items = config.items;
    // Duck-type signal: has _subscribers Set, value getter, set method
    if (
      items !== null &&
      typeof items === "object" &&
      "_subscribers" in items &&
      "value" in items
    ) {
      return (items as Signal<T[]>).value;
    }
    // Plain array
    if (Array.isArray(items)) {
      return items;
    }
    // Invalid input — return empty array and warn in dev
    console.warn("[aio:virtualList] items must be an array or Signal<array>");
    return [] as T[];
  };

  const visibleComputed: Computed<
    { item: T; index: number; offset: number }[]
  > = computed(() => {
    const items = getItems();
    const scrollTop = scrollTopSig.value;
    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / safeItemHeight) - overscan,
    );
    const visibleCount = Math.ceil(containerHeight / safeItemHeight) +
      2 * overscan;
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
      scrollTopSig.set(index * safeItemHeight);
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
