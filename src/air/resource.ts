import { batch, effect, signal, untrack } from "../state/signal.ts";
import type { Signal } from "../state/signal.ts";

/** The return type of resource(). */
export interface Resource<T> {
  /** The last fetch's RESULT.
   *
   *  Stale-while-revalidate during a refetch (AIO-256): a source change keeps
   *  the previous value on screen instead of flashing `undefined`, so a list
   *  does not blink every time its filter moves. `loading` is what says a
   *  fetch is in flight.
   *
   *  `undefined` after a FAILED fetch, because there is no result. That is the
   *  one state where this and {@linkcode Resource.latest} differ, and the
   *  difference is the point: a failed refetch used to leave the old value
   *  here, so `{r.value ? <View/> : <Spinner/>}` rendered stale data as though
   *  it were current, with the failure visible only to code that also checked
   *  `error`. Keep showing the old data deliberately — read `latest` — or
   *  handle the error; do not get it by accident. */
  readonly value: T | undefined;
  /** Boolean signal — true while fetching. */
  readonly loading: Signal<boolean>;
  /** Error signal — set if the last fetch threw. */
  readonly error: Signal<unknown>;
  /** The last SUCCESSFUL value — it survives both a refetch and a failure.
   *  This is the one to render when you want the previous data to stay on
   *  screen while the new fetch is in flight or after it failed. */
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
          // There is no result, so `value` holds none. It used to keep the
          // PREVIOUS fetch's data — which made `value` and `latest` the same
          // signal in every reachable state (so `latest`'s documented purpose
          // could not be observed, and the test for it asserted nothing), and
          // left an app rendering stale rows beside a live error with no way
          // to tell them from fresh ones. Stale-while-revalidate is for the
          // LOADING window (AIO-256); a failure is an answer, and `latest`
          // is where the last good value stays.
          data.set(undefined);
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
      if (abortController) abortController.abort();
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
      // The in-flight fetch is aborted and its continuations early-return on
      // `disposed`, so nothing will ever clear `loading` again. Left true, a
      // disposed resource reported itself as forever-loading and every
      // `{r.loading.value ? <Spinner/> : …}` in the app spun for good. A
      // resource that has been torn down is not loading.
      loading.set(false);
    },
  };
}
