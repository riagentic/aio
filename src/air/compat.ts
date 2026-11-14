// React's hook spellings for AIR — first-class, exported from `aio/air` and
// `aio/air/compat` alike. They run silently: `useState` is correct code, and a
// dev hint on correct code is a warning that cries wolf (they printed one
// until 1.0.6-beta). AIR re-executes components the React way, so each behaves
// as its React namesake — pinned by tests/react-patterns.test.ts.

import { effect, type Signal, signal, untrack } from "../state/signal.ts";
import { isDevMode } from "../state/dev-flag.ts";
import {
  afterRender,
  onCleanup,
  onMount,
  useRef as rendererUseRef,
} from "./aio-renderer.ts";
import { _currentCollector } from "./renderer-state.ts";
import { _noteRenderWrite } from "./renderer-rerender.ts";

/** Re-export useRef from renderer for compat */
export const useRef = rendererUseRef;

// ── useState ───────────────────────────────────────────────────────

/**
 * React's `useState`, signal-backed: `const [v, setV] = useState(0)`.
 * Same job as `useLocal` (aio's spelling, which also offers `.patch` for
 * objects); either is correct.
 *  @tier Core */
export function useState<T>(
  initial: T | (() => T),
): [T, (next: T | ((prev: T) => T)) => void] {
  const ref = rendererUseRef<
    { sig: Signal<T>; set: (next: T | ((prev: T) => T)) => void } | null
  >(null);
  if (ref.current === null) {
    // Matches React behavior: functions are always treated as lazy initializers.
    // If T is itself a function type, wrap it: useState(() => myFn)
    const val = typeof initial === "function"
      ? (initial as () => T)()
      : initial;
    const sig = signal(val);
    // The instance this state belongs to, by its hook-slot array — the one
    // thing a first render's collector and the instance it becomes share.
    const owner = _currentCollector?.refs;
    // Made ONCE, kept beside the signal: React's setter is stable, so React
    // code lists it in deps arrays. A fresh arrow per render was a changed
    // dep per render — `useEffect(() => { load().then(setRows) }, [setRows])`
    // loaded again after every render it caused.
    const set = (next: T | ((prev: T) => T)): void => {
      const prev = sig.peek();
      const v = typeof next === "function"
        ? (next as (prev: T) => T)(prev)
        : next;
      // React's bail-out is `Object.is` and nothing more. The signal's own
      // rule also skips a SHALLOW-equal object (right for `signal()`, which
      // documents it), so the React idioms that hand back a fresh container
      // — `force({})`, `setTodos([...todos])` after a mutation — re-rendered
      // nothing here. `force` only when React would render; an identical
      // value stays the no-op it is in React.
      if (Object.is(prev, v)) return;
      sig.set(v, { force: true });
      // Set during the owner's OWN render — React's "storing information
      // from previous renders". The body already read the old value and
      // drops its subscriptions while it runs, so nobody heard this write
      // and the screen stayed one render behind. The renderer re-runs the
      // body before committing (renderer-rerender.ts `_noteRenderWrite`).
      if (owner) _noteRenderWrite(owner);
    };
    ref.current = { sig, set };
  }
  const { sig, set } = ref.current;

  return [sig.value, set];
}

// ── deps ───────────────────────────────────────────────────────────

/** Whether a hook's deps array changed since `prev` — React's rule: LENGTH
 *  first, then element-wise `Object.is`. ONE decider for every deps hook in
 *  this file. `useMemo` once kept its own copy with `===` while `useEffect`
 *  used `Object.is`, so a `NaN` dep (a `parseFloat` of an empty field) was
 *  "changed" on EVERY render there: `useMemo` recomputed forever and
 *  `useCallback` handed out a fresh identity, re-subscribing each effect that
 *  depended on it. `prev === null` is "never recorded". */
function _depsChanged(
  prev: readonly unknown[] | null,
  next: readonly unknown[],
) {
  return prev === null ||
    prev.length !== next.length ||
    next.some((d, i) => !Object.is(d, prev[i]));
}

// ── useEffect ──────────────────────────────────────────────────────

/**
 * React's `useEffect`: runs after mount, re-runs when a dep changes
 * (`Object.is`), cleanup before each re-run and on unmount. `onMount()` is the
 * same job for the run-once case; `effect()` auto-tracks signals.
 *  @tier Core */
export function useEffect(
  fn: () => void | (() => void),
  deps?: unknown[],
): void {
  // ONE hook-slot layout for every deps form. The forms used to take
  // different numbers of `useRef` slots (two with deps, one with `[]`, two
  // with none), and slots are matched by CALL ORDER — so a deps array that
  // went from `[x]` to `[]`, or from absent to present, moved every hook
  // after this one onto another's slot: a later `useState` read a ref
  // record and the render threw. React re-runs the effect (warning in dev);
  // so does this, because the kind of deps is now data in one record.
  const st = useRef<_EffectState>({
    want: null,
    tok: 0,
    ran: null,
    ranTok: -1,
    off: null,
    live: false,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const s = st.current;
  const want = deps === undefined ? null : deps;
  // A changed SHAPE is a bug in the caller (React says so too). Re-running is
  // the safe reading of it, and the length-first compare already does that;
  // the warning is observe-only.
  if (s.tok > 0 && isDevMode()) _warnDepsShape(s.want, want);
  s.want = want;
  s.tok++;

  const teardown = (): void => {
    const off = s.off;
    s.off = null; // cleared FIRST: a cleanup that throws is not run twice
    if (off) off();
  };
  // Runs at most once per committed render, against the deps of the LATEST
  // render: the comparison is with what the effect last RAN with, decided
  // here and not when it was scheduled. A render the renderer discards and
  // re-runs (state set during render) drops what it scheduled, so a decision
  // recorded at schedule time would be lost with it.
  const flush = (): void => {
    const w = s.want;
    if (w === null ? s.ranTok === s.tok : !_depsChanged(s.ran, w)) return;
    teardown();
    s.ran = w && w.slice();
    s.ranTok = s.tok;
    if (w === null) {
      // No deps: a fresh closure after every render, and — as `effect()` —
      // also re-run by a signal it reads.
      s.off = effect(() => fnRef.current());
      return;
    }
    // Deps: purely deps-driven, so its reads are untracked. `[]` keeps the
    // plain call it has always had.
    const c = w.length === 0 ? fnRef.current() : untrack(() => fnRef.current());
    if (typeof c === "function") s.off = c;
  };

  if (!s.live) {
    // The first run lands after the mount commit. Asked for by every render
    // until it has run (a render the renderer throws away takes its `onMount`
    // with it; after the instance mounts, extra ones are discarded). The
    // unmount teardown is registered INSIDE onMount, which makes it
    // unmount-only: registered in the body it would also fire before every
    // re-render — and a re-render with UNCHANGED deps does not re-run the
    // effect, so it tore the effect down and nothing put it back.
    onMount(() => {
      s.live = true;
      onCleanup(teardown);
      flush();
    });
    return;
  }
  // Re-runs land AFTER the diff/commit phase so the effect sees the committed
  // DOM (React semantics). queueMicrotask would fire before the diff runs,
  // reading stale layout and racing the impending patch.
  if (want === null || _depsChanged(s.ran, want)) afterRender(flush);
}

type _EffectState = {
  /** The latest render's deps — `null` when it passed no array. */
  want: readonly unknown[] | null;
  /** Renders seen; a no-deps effect runs once per render. */
  tok: number;
  /** The deps it last ran with — `null` when it has not run WITH deps. */
  ran: readonly unknown[] | null;
  /** The render it last ran for (the no-deps form). */
  ranTok: number;
  /** Tears the current run down: the deps form's returned cleanup, or the
   *  no-deps form's live `effect()`. */
  off: (() => void) | null;
  /** Its first run (onMount) has happened. */
  live: boolean;
};

function _warnDepsShape(
  prev: readonly unknown[] | null,
  next: readonly unknown[] | null,
): void {
  // `-1` stands for "no deps array".
  const a = prev?.length ?? -1, b = next?.length ?? -1;
  if (a !== b) {
    console.warn(
      `[aio] useEffect deps changed shape (${a} → ${b}; -1 = none): it ` +
        `re-runs. Keep one length, always present or always absent.`,
    );
  }
}

// ── useCallback ────────────────────────────────────────────────────

/**
 * React-compatible `useCallback` — a STABLE identity across renders, which is
 * the thing it is for.
 *
 * It used to return `fn` unchanged, on the reasoning that AIR auto-optimizes
 * rendering so a memoized callback buys nothing. That is true of RENDERING and
 * false of IDENTITY, and identity is what a deps array compares. `useEffect`
 * on this same surface promises "Deps are honored (React semantics)" and
 * compares with `Object.is`, so a fresh arrow every render was a CHANGED dep
 * every render. Measured:
 *
 *   useEffect(fn, [useCallback(cb, [])])  over 1 mount + 3 re-renders
 *     React: subscribe 1, unsubscribe 0
 *     aio:   subscribe 4, unsubscribe 3
 *
 * …and the canonical fetch-on-mount shape — `useEffect(() => { setN(...) },
 * [load])` with `load` a `useCallback` — became an unbounded render loop
 * instead of running once. The compat layer exists so React code "compiles and
 * runs"; the single most common React idiom silently did neither.
 *
 * It is `useMemo(() => fn, deps)`, which is exactly what React's is.
 *
 * The parameter keeps its `_deps` name: the public surface is FROZEN and
 * `check:api` reads the signature verbatim, so renaming it — even to the same
 * type in the same position — is a refused change. It is read now; the
 * underscore is history, not a claim.
 *  @tier Core */
export function useCallback<T>(fn: T, _deps?: unknown[]): T {
  return useMemo(() => fn, _deps);
}

// ── useMemo ────────────────────────────────────────────────────────

/**
 * React's `useMemo`: recomputes when a dep changes (`Object.is`, length
 * first). `computed()` is the signal-native way for derived values.
 *  @tier Core */
export function useMemo<T>(fn: () => T, _deps?: unknown[]): T {
  const ref = useRef<{ deps: unknown[] | undefined; value: T } | null>(null);
  // LENGTH first. An element-wise compare judges a SHRINKING deps array
  // unchanged whenever its surviving prefix matches, so `useMemo(fn, [...ids])`
  // with one id removed kept the old value: measured, deps `[0,1,2]` → `[0,1]`
  // returned 3 and never recomputed. That is a wrong VALUE rendered to the
  // page, not a missed optimisation. Its twin `useEffect` in this same file
  // already compares lengths — two deciders for one question, and this was the
  // half that had not been done — now `_depsChanged`, shared with it.
  const prev = ref.current?.deps;
  if (
    ref.current === null ||
    !_deps ||
    !prev ||
    _depsChanged(prev, _deps)
  ) {
    ref.current = { deps: _deps, value: fn() };
  }
  return ref.current.value;
}
