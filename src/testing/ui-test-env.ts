// testUI's browser environment — per-run localStorage isolation, refusing
// native dialogs, the viewport, same-document history, and the fake-layout
// warning. Split out of ui-test.ts; internal to it — nothing here was ever
// exported.

import { withRefusalCode } from "../state/method-rejection.ts";
import { closeWindow } from "./close-window.ts";
import type { AnyDoc } from "./ui-test.ts";

/** The `{ persist: true }` store key: one per PROCESS, so a persistence-flow
 *  test sees continuity between its own mounts while the host's localStorage
 *  (Deno's is on disk and outlives the run) can never hand it a previous
 *  run's state. The entry is removed when the process unloads. */
let _runKey: string | null = null;
export function _persistRunKey(): string {
  if (_runKey) return _runKey;
  const key = `testui:run:${crypto.randomUUID()}`;
  _runKey = key;
  globalThis.addEventListener?.("unload", () => {
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem(key);
    } catch {
      // aio-ok: a read-only host store — the key is unique to this run, so a
      // leftover entry can never be restored by another one.
    }
  });
  return key;
}

/** The backing stores of the live hermetic mounts, newest last — the one
 *  `localStorage` reads and writes while any is live. */
const _lsStack: Map<string, string>[] = [];
let _lsUndo: (() => void) | undefined;

/** Give this mount its own fresh `localStorage`; returns its release.
 *
 *  The global is ONE view for the whole span of live mounts — only what it
 *  reads and writes switches — and a host `Storage` (Deno's is one on-disk
 *  store per project, shared by every test file and `--parallel` process) is
 *  never cleared: its prototype routes the host instance to the top mount's
 *  store, so a module that took `const ls = localStorage` at import time is
 *  isolated per mount too (swapping the global per mount left it writing to
 *  the host store, or to a dead mount's). Releases may come in any order; the
 *  host is restored exactly when the last one goes. */
export function _isolateLocalStorage(): () => void {
  const store = new Map<string, string>();
  if (_lsStack.push(store) === 1) _lsUndo = _installLocalStorage();
  return () => {
    const i = _lsStack.indexOf(store);
    if (i >= 0) _lsStack.splice(i, 1);
    if (_lsStack.length === 0) {
      _lsUndo?.();
      _lsUndo = undefined;
    }
  };
}

/** Storage.prototype's methods as the runtime ships them, taken at import —
 *  before any test can stub them. Anything else found there is a stub. */
const _nativeStorage: Record<string, AnyDoc> | undefined = (() => {
  const S = (globalThis as AnyDoc).Storage?.prototype;
  return S && Object.fromEntries(
    ["getItem", "setItem", "removeItem", "clear", "key"].map((n) => [n, S[n]]),
  );
})();

/** Deno's own alert/confirm/prompt, taken at import — before any test can
 *  answer one. Anything else found there is a test's answer. */
export const _nativeDialogs: Record<string, unknown> = Object.fromEntries(
  ["alert", "confirm", "prompt"].map((n) => [n, (globalThis as AnyDoc)[n]]),
);

/** One refusal per dialog, shared by every mount (see `_dialogHolds`). */
export const _refuseDialog: Record<string, (message?: unknown) => never> =
  Object
    .fromEntries(
      ["alert", "confirm", "prompt"].map((
        name,
      ) => [name, (message?: unknown) => {
        throw withRefusalCode(
          new Error(
            `testUI: ${name}(${
              JSON.stringify(String(message ?? ""))
            }) — a native dialog, and a test has no one to answer it. Answer ` +
              `it for this test: \`globalThis.${name} = () => ${
                name === "confirm" ? "true" : name === "prompt" ? '"…"' : "{}"
              }\`.`,
          ),
          "NATIVE_DIALOG",
        );
      }]),
    );

function _installLocalStorage(): () => void {
  const top = () => _lsStack[_lsStack.length - 1] ?? new Map<string, string>();
  const shim: Record<string, (...a: AnyDoc[]) => unknown> = {
    getItem: (k) => top().get(String(k)) ?? null,
    setItem: (k, v) => void top().set(String(k), String(v)),
    removeItem: (k) => void top().delete(String(k)),
    clear: () => top().clear(),
    key: (i) => [...top().keys()][i] ?? null,
  };
  const g = globalThis as AnyDoc;
  const host = g.localStorage;
  const desc = Object.getOwnPropertyDescriptor(g, "localStorage");
  // The GLOBAL is a Storage-shaped view of the top mount's store — methods,
  // named properties, `length`, `key(i)` AND enumeration (`Object.keys`,
  // `for…in`, `JSON.stringify`), which a prototype patch cannot reach: Deno's
  // Storage answers `ownKeys` from its native store.
  //
  // Not "clear the host and restore it after": Deno's store is ONE on-disk
  // store per project, shared live by every `--parallel` test process. A
  // clear deletes another process's data mid-test (the bug this replaced),
  // and the restore would then overwrite whatever that process wrote since.
  // Symbol keys (inspection, coercion) are never items.
  const item = (k: string | symbol): k is string =>
    typeof k === "string" && top().has(k);
  // `stub(localStorage, "setItem", quotaError)` is a silent no-op in a
  // browser (the define stores an ITEM named "setItem"; the method stays), so
  // a quota test would run the happy path. Refused here, on the global and on
  // a captured reference alike; a stub on Storage.prototype is what works.
  const isMethod = (k: unknown): k is string =>
    typeof k === "string" && Object.hasOwn(shim, k);
  const refuse = (k: string): never => {
    throw withRefusalCode(
      new TypeError(
        `testUI: replacing localStorage.${k} on the instance does nothing in a ` +
          `browser (it stores an item named "${k}"; the method stays), so the ` +
          `test would run the happy path — stub Storage.prototype.${k} instead: ` +
          `stub(Storage.prototype, "${k}", …).`,
      ),
      "STORAGE_STUB",
    );
  };
  const S = g.Storage?.prototype;
  // The mount's entry methods, by name (installed below): they call whatever
  // Storage.prototype holds now — a test's stub, or our routed method.
  const entry: Record<string, (...a: unknown[]) => unknown> = {};
  const method = (k: string) => entry[k] ?? shim[k];
  const view = new Proxy({}, {
    get: (_t, k) =>
      k === "length"
        ? top().size
        : isMethod(k)
        ? method(k)
        : typeof k === "string"
        ? shim[k] ?? top().get(k)
        : undefined,
    set(_t, k, v) {
      if (isMethod(k) && typeof v === "function") refuse(k);
      if (typeof k === "string") top().set(k, String(v));
      return true;
    },
    defineProperty(_t, k, d) {
      if (isMethod(k) && typeof d.value === "function") refuse(k);
      if (typeof k !== "string" || !("value" in d)) {
        throw withRefusalCode(
          new TypeError(
            `testUI: localStorage cannot define ${String(k)} — set an item.`,
          ),
          "STORAGE_STUB",
        );
      }
      top().set(k, String(d.value));
      return true;
    },
    deleteProperty(_t, k) {
      if (typeof k === "string") top().delete(k);
      return true;
    },
    // aio-ok(proto-in): a real Storage answers `"toString" in ls` true too.
    has: (_t, k) => item(k) || (typeof k === "string" && k in shim),
    ownKeys: () => [...top().keys()],
    getOwnPropertyDescriptor: (_t, k) =>
      item(k)
        ? {
          value: top().get(k),
          writable: true,
          enumerable: true,
          configurable: true,
        }
        : undefined,
  });
  Object.defineProperty(g, "localStorage", { value: view, configurable: true });
  const undoGlobal = () => {
    if (desc) Object.defineProperty(g, "localStorage", desc);
    else delete g.localStorage;
  };
  const nat = _nativeStorage;
  if (!host || !S || !nat || Object.getPrototypeOf(host) !== S) {
    return undoGlobal;
  }
  // This process's `{ persist: true }` entry — "a hermetic mount in between
  // resets the flow" — and never anyone else's data.
  try {
    if (_runKey) host.removeItem(_runKey);
  } catch {
    // aio-ok: a read-only host store — the key is unique to this run, so a
    // leftover entry can never be restored by another one.
  }
  // A reference taken BEFORE the mount (`const ls = localStorage` at import)
  // is the host instance itself: its prototype routes it to the top mount's
  // store too. Only its enumeration cannot follow (see above) — read keys
  // through the global, or through `length`/`key(i)`, which do.
  const names = [...Object.keys(shim), "length"];
  const saved = names.map((n) =>
    [n, Object.getOwnPropertyDescriptor(S, n)!] as const
  );
  // A named read (`ls.foo`) reaches getItem with `this` = the proxy's raw
  // target, not `host`: learn it, so both are routed and sessionStorage not.
  let raw: unknown;
  Object.defineProperty(S, "getItem", {
    value(this: unknown) {
      raw = this;
      return null;
    },
    configurable: true,
  });
  try {
    void host["\0aio-probe"];
  } finally {
    Object.defineProperty(S, "getItem", saved[0]![1]);
  }
  // The view too: a spy on Storage.prototype calls through with it as `this`.
  // Dead once released, so a stub restored after the last mount (putting a
  // routed method back) just calls the host's own.
  let live = true;
  const mine = (t: unknown) => live && (t === host || t === raw || t === view);
  // What sits under our routed method, per name: the native one (→ the
  // mount's store) or a stub made BEFORE the mount, which answers for the
  // mount exactly as one made inside it does.
  const base = new Map(saved);
  // Every stub is called with the mount's store as `this`: one that calls
  // through to the native method (which knows only the host's store) fails
  // loudly instead of writing past the mount.
  let brand = "";
  try {
    nat.getItem.call({}, "");
  } catch (e) {
    brand = (e as Error).message;
  }
  const call = (n: string, f: AnyDoc, a: unknown[]) => {
    try {
      return f.apply(view, a);
    } catch (e) {
      if (!(e instanceof TypeError) || e.message !== brand) throw e;
      throw withRefusalCode(
        new TypeError(
          `testUI: a Storage.prototype.${n} stub called the native method, ` +
            `which only reaches the host's store, never the mount's — make ` +
            `the stub after testUI().`,
          { cause: e },
        ),
        "STORAGE_STUB",
      );
    }
  };
  const under = (n: string, a: unknown[]) => {
    const f = base.get(n)!.value;
    return f === nat[n] ? shim[n]!(...a) : call(n, f, a);
  };
  const routed = (n: string): PropertyDescriptor => {
    const d = base.get(n)!;
    return n === "length"
      ? {
        ...d,
        get(this: unknown) {
          return mine(this) ? top().size : d.get!.call(this);
        },
      }
      : {
        ...d,
        value(this: unknown, ...a: unknown[]) {
          if (!mine(this)) return base.get(n)!.value.apply(this, a);
          // Deno's Storage turns a define/assign on the captured instance
          // into setItem of that NAME — the same no-op stub as above.
          if (
            n === "setItem" && isMethod(a[0]) && typeof a[1] === "function"
          ) refuse(a[0]);
          return under(n, a);
        },
      };
  };
  for (const n of names) Object.defineProperty(S, n, routed(n));
  // The host's own chain starts at the mount's entry methods, which call
  // whatever the prototype holds now. A pre-mount stub restored mid-mount
  // puts the native method back there: the mount's store again, never the
  // host's — our routed method goes back under it.
  for (const n of Object.keys(shim)) {
    entry[n] = function (this: unknown, ...a: unknown[]) {
      if (live && S[n] === nat[n]) {
        base.set(n, Object.getOwnPropertyDescriptor(S, n)!);
        Object.defineProperty(S, n, routed(n));
      }
      return live ? call(n, S[n], a) : S[n].apply(this, a);
    };
  }
  Object.setPrototypeOf(
    host,
    Object.create(
      S,
      Object.fromEntries(
        Object.entries(entry).map((
          [n, value],
        ) => [n, { value, configurable: true }]),
      ),
    ),
  );
  return () => {
    live = false;
    Object.setPrototypeOf(host, S);
    // What was under ours goes back — never a stub that was restored.
    for (const n of names) {
      if (n === "length" || S[n] !== nat[n]) {
        Object.defineProperty(S, n, base.get(n)!);
      }
    }
    undoGlobal();
  };
}

/** Make the mount report a real viewport size.
 *
 *  happy-dom honours `width`/`height` for `window.innerWidth/innerHeight` but
 *  leaves `documentElement.clientWidth/clientHeight` at 0 — and that pair is
 *  the other half of every "how big is the window?" read in real code. Both
 *  answers have to agree, or which one a component happens to use decides
 *  whether its test is meaningful. */
export function _installViewport(
  win: AnyDoc,
  width: number,
  height: number,
): void {
  const el = win.document?.documentElement;
  if (!el) return;
  for (
    const [prop, value] of [
      ["clientWidth", width],
      ["clientHeight", height],
    ] as const
  ) {
    try {
      Object.defineProperty(el, prop, { get: () => value, configurable: true });
    } catch {
      // aio-ok: a capability probe, not an operation. `clientWidth` is
      // non-configurable on any DOM that implements real layout (a browser, a
      // future happy-dom), and there the property already answers honestly —
      // which is strictly better than the number this would have installed.
      // There is nothing to report and nothing to retry.
    }
  }
}

/** Does this happy-dom fire `hashchange` for `pushState`/`replaceState`?
 *
 *  MEASURED (happy-dom 20.14.5; 17.6.3 does not): its `Location` queues a
 *  `hashchange` for EVERY URL write whose fragment differs — the two History
 *  calls included, for which a browser fires nothing (HTML, "URL and history
 *  update steps"). A router that `pushState`s to `/list#top` then hears its
 *  own navigation back as a `hashchange`, under testUI and nowhere else.
 *
 *  Proven once per process, on a throwaway window: an engine that behaves
 *  gets no filter at all (see `_installSameDocumentHistory`). */
let _historyHashchangeProof: Promise<boolean> | null = null;
export function _historyFiresHashchange(hd: AnyDoc): Promise<boolean> {
  return _historyHashchangeProof ??= (async () => {
    const w = new hd.Window({ url: "http://localhost/" });
    try {
      let fired = false;
      w.addEventListener("hashchange", () => fired = true);
      w.history.replaceState(null, "", "#aio-probe");
      // Queued BEHIND the timer the defect arms (same delay, so FIFO).
      await new Promise<void>((r) => w.setTimeout(r, 0));
      return fired;
    } finally {
      await closeWindow(w);
    }
  })();
}

/** Make Back/Forward a SAME-DOCUMENT traversal, as it is in a browser.
 *
 *  MEASURED (happy-dom 17.6.3): `history.back()` between two `pushState`
 *  entries treats the step as a whole-document navigation. On a `new
 *  Window()` (a detached frame) that navigation is refused and it falls back
 *  to rewriting `location` — so the URL moves, but no `popstate` fires and
 *  `history.state` still answers the entry it left. A router listens for
 *  exactly that event, so under testUI a routed app's Back button changed
 *  the address bar and left the old page on screen, while the same app in a
 *  browser re-rendered. A test of "Back returns to the list" could not pass
 *  against a correct app.
 *
 *  RE-MEASURED (happy-dom 20.14.5): the traversal is same-document now and
 *  `popstate` carries the right state — but it all happens INSIDE `back()`,
 *  where a browser queues a task (code right after `back()` reads the old
 *  URL). Still replaced, for that; `tests/testui-history-traversal.test.tsx`
 *  goes red without it on both versions.
 *
 *  `quietHash` (the engine failed `_historyFiresHashchange`): the
 *  `hashchange` it owes for each `pushState`/`replaceState` made here is
 *  dropped as it is dispatched — matched oldest-first by its exact
 *  `oldURL → newURL`, the order the engine queues them in — so one caused by
 *  `location.hash = …` or a fragment link still arrives.
 *
 *  So the harness keeps the session history itself, for this window only:
 *  `pushState`/`replaceState` still go through happy-dom (it validates the
 *  origin and moves `location`), and each is recorded here. A traversal is
 *  what the HTML spec makes it: queued as a TASK (never synchronous — code
 *  right after `back()` still reads the old URL, as in a browser), a no-op
 *  past either end, then `location`/`state` move and `popstate` fires on the
 *  window, followed by `hashchange` when only the fragment differs. Every
 *  navigation the app can make stays a real happy-dom call; only the part
 *  happy-dom gets wrong is replaced, so this is never more permissive than a
 *  browser. `go(0)` (a reload) is left to happy-dom. */
export function _installSameDocumentHistory(
  win: AnyDoc,
  quietHash: boolean,
): void {
  const h = win?.history;
  if (!h || typeof h.pushState !== "function") return;
  /** `oldURL newURL` of each `hashchange` the engine owes for a History call. */
  const owed: string[] = [];
  /** The traversal's own `hashchange` — never one of the engine's. */
  const own = new WeakSet<object>();
  const viaHistory = (
    call: (state: unknown, title: string, url?: string | URL | null) => void,
  ): typeof call =>
  (state, title, url) => {
    const was = win.location.href, wasHash = win.location.hash;
    call(state, title, url);
    if (quietHash && win.location.hash !== wasHash) {
      owed.push(`${was} ${win.location.href}`);
    }
  };
  const push = viaHistory(h.pushState.bind(h));
  const replace = viaHistory(h.replaceState.bind(h));
  const reload = h.go.bind(h);
  if (quietHash) {
    const dispatch = win.dispatchEvent;
    win.dispatchEvent = function (this: unknown, ev: AnyDoc) {
      if (
        ev?.type === "hashchange" && !own.has(ev) &&
        owed[0] === `${ev.oldURL} ${ev.newURL}`
      ) {
        owed.shift();
        return true;
      }
      return dispatch.call(this, ev);
    };
  }
  const entries: { href: string; state: unknown }[] = [
    { href: win.location.href, state: h.state },
  ];
  let index = 0;
  const engineState = () =>
    Reflect.get(Object.getPrototypeOf(h), "state", h) as unknown;
  const current = () => ({ href: win.location.href, state: engineState() });
  const base = (href: string) => href.split("#")[0];
  /** A fragment navigation made OUTSIDE the History API (`location.hash = …`,
   *  a `#` link — which `<Link>` leaves to the browser) is a new entry with
   *  no state, as in a browser. This list never heard of it, so `back()`
   *  went one entry too far. Noticed on the next look at the history rather
   *  than at every door the address can change through. MEASURED (happy-dom
   *  20.14.5): `location.hash = …` also keeps the old entry's `state`. */
  const sync = () => {
    const href = win.location.href;
    if (href === entries[index]!.href) return;
    if (base(href) !== base(entries[index]!.href)) return;
    replace(null, "", href);
    entries.length = index + 1;
    entries.push({ href, state: null });
    index++;
  };
  const traverse = (delta: number) => {
    sync();
    win.setTimeout(() => {
      if (win.closed) return;
      const target = entries[index + delta];
      if (!target) return;
      const oldURL = win.location.href;
      index += delta;
      replace(target.state, "", target.href);
      const ev = new win.Event("popstate");
      Object.defineProperty(ev, "state", { value: h.state });
      win.dispatchEvent(ev);
      const [oldBase, oldHash = ""] = oldURL.split("#");
      const [newBase, newHash = ""] = target.href.split("#");
      if (oldBase === newBase && oldHash !== newHash) {
        const hc = new win.HashChangeEvent("hashchange", {
          oldURL,
          newURL: target.href,
        });
        own.add(hc);
        win.dispatchEvent(hc);
      }
    }, 0);
  };
  Object.defineProperties(h, {
    pushState: {
      configurable: true,
      value(state: unknown, title: string, url?: string | URL | null) {
        sync();
        push(state, title, url);
        entries.length = index + 1;
        entries.push(current());
        index++;
      },
    },
    replaceState: {
      configurable: true,
      value(state: unknown, title: string, url?: string | URL | null) {
        sync();
        replace(state, title, url);
        entries[index] = current();
      },
    },
    go: {
      configurable: true,
      value(delta = 0) {
        const d = Math.trunc(Number(delta)) || 0;
        if (d === 0) return reload(0);
        traverse(d);
      },
    },
    back: { configurable: true, value: () => traverse(-1) },
    forward: { configurable: true, value: () => traverse(1) },
    length: { configurable: true, get: () => (sync(), entries.length) },
    state: { configurable: true, get: () => (sync(), engineState()) },
  });
}

/** Say out loud that there is no layout engine here.
 *
 *  `getBoundingClientRect()` returns all zeros and `clientWidth` is 0 for
 *  every element, because nothing lays anything out. Code that measures then
 *  takes its degenerate branch — and passes. That is the single worst
 *  outcome a test harness can produce: a green test that exercised the
 *  fallback and would have passed against a broken implementation. So the
 *  FIRST measurement per mount says what happened and what to do instead.
 *
 *  Once per mount, not per call: a virtualised list measures every row, and a
 *  warning that scrolls the terminal is a warning nobody reads. */
export function _warnOnFakeLayout(win: AnyDoc): void {
  const proto = win.Element?.prototype;
  if (!proto) return;
  let warned = false;
  const warn = (what: string) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[aio:testUI] ${what} was read, and there is no layout engine here — ` +
        `every element measures 0×0 at position 0,0. A component that ` +
        `branches on its own size therefore takes its DEGENERATE branch, and ` +
        `the test passes without exercising the real one.\n` +
        `  fix: assert the behaviour, not the geometry — or stub the ` +
        `measurement for this test (\`Object.defineProperty(el, ` +
        `"clientWidth", { value: 800 })\`).\n` +
        `  note: the WINDOW does have a size — set it with ` +
        `testUI(App, { viewport: { width, height } }).`,
    );
  };
  const origRect = proto.getBoundingClientRect;
  if (typeof origRect === "function") {
    proto.getBoundingClientRect = function (this: AnyDoc) {
      const r = origRect.call(this);
      if (!r || (!r.width && !r.height)) warn("getBoundingClientRect()");
      return r;
    };
  }
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get) continue;
    const get = desc.get;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        get(this: AnyDoc) {
          const v = get.call(this);
          // documentElement carries the viewport (see _installViewport) and
          // has its own own-property getter, so it never reaches this one.
          if (!v) warn(prop);
          return v;
        },
      });
    } catch {
      // aio-ok: the property is non-configurable in this runtime, so the
      // harness cannot install its own — the caller gets the runtime's, which
      // is the correct fallback and needs no report.
    }
  }
}
