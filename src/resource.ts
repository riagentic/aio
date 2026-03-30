import { batch, effect, signal, untrack } from "./signal.ts";
import type { Signal } from "./signal.ts";

/** The return type of resource(). */
export interface Resource<T> {
  /** Current data value — undefined while loading or after error. */
  readonly value: T | undefined;
  /** Boolean signal — true while fetching. */
  readonly loading: Signal<boolean>;
  /** Error signal — set if the last fetch threw. */
  readonly error: Signal<unknown>;
  /** Last successful value — persists through refetch cycles. */
  readonly latest: Signal<T | undefined>;
  /** Manually re-trigger the fetch with the current source. */
  refetch(): void;
  /** Optimistic local update — sets value without refetching. */
  mutate(value: T): void;
  /** Tear down: abort in-flight fetch, stop watching source. */
  dispose(): void;
}

/**
 * Async data as signals. Re-fetches when the reactive source changes.
 * Aborts in-flight requests on source change or dispose.
 */
export function resource<S, T>(
  source: () => S,
  fetcher: (source: S, opts: { signal: AbortSignal }) => Promise<T>,
): Resource<T> {
  const data = signal<T | undefined>(undefined);
  const loading = signal(true);
  const error = signal<unknown>(undefined);
  const latest = signal<T | undefined>(undefined);

  let abortController: AbortController | null = null;
  let disposed = false;

  function doFetch(sourceValue: S) {
    if (abortController) abortController.abort();
    const ac = new AbortController();
    abortController = ac;

    batch(() => {
      loading.set(true);
      error.set(undefined);
    });

    fetcher(sourceValue, { signal: ac.signal }).then(
      (result) => {
        if (ac.signal.aborted || disposed) return;
        batch(() => {
          data.set(result);
          latest.set(result);
          loading.set(false);
        });
      },
      (err) => {
        if (ac.signal.aborted || disposed) return;
        batch(() => {
          error.set(err);
          loading.set(false);
        });
      },
    );
  }

  // Watch source reactively — effect auto-tracks source()
  const disposeEffect = effect(() => {
    const sourceValue = source();
    untrack(() => doFetch(sourceValue));
  });

  return {
    get value() {
      return data.value;
    },
    loading,
    error,
    latest,
    refetch() {
      if (disposed) return;
      const sourceValue = untrack(source);
      doFetch(sourceValue);
    },
    mutate(value: T) {
      batch(() => {
        data.set(value);
        latest.set(value);
        error.set(undefined);
        loading.set(false);
      });
    },
    dispose() {
      disposed = true;
      if (abortController) abortController.abort();
      disposeEffect();
    },
  };
}
