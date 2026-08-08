// `aio/air` must mean the same thing on every target.
//
// The android build remaps the public specifier to a different module:
//   src/build/build-bundle.ts  → const fwEntry = doAndroid
//                                  ? "standalone-air.ts" : "browser-air.ts"
//                                … imports: { "aio": aioEntry, "aio/air": aioEntry }
// so on android `import { … } from "aio/air"` resolves to src/standalone-air.ts.
// That module carried its OWN `useLocal`, narrower than the one every other
// target ships and narrower than the docs:
//
//   docs/basics/api-reference.md — `const [v, setV] = useLocal(0)` (tuple,
//                                   preferred; `{ local, set, patch }` also works)
//   docs/ui/air-reference.md     — `useLocal(init)` → `{ local, set, patch }`
//                                   or tuple `[value, set]`
//
// Neither the tuple form nor `patch()` existed there, so the DOCUMENTED,
// PREFERRED spelling threw `useLocal(...) is not iterable` — on android only,
// at runtime, in an app whose browser and electron builds were green. The
// scaffold's own template uses the one form both copies happened to support,
// so every gate stayed green.
//
// Two rules, both enforced below:
//   1. no symbol may be exported under an `aio/air` name with a DIFFERENT
//      contract per target — a second implementation of a name is the bug;
//   2. what android does not ship is enumerated HERE, with a reason, so the
//      gap is a visible fact instead of a discovery made by a user.
import { assert, assertEquals } from "@std/assert";
import * as air from "../src/air.ts";
import * as android from "../src/standalone-air.ts";

// ── 1. the contract of a shared name is identical on both entries ────────

Deno.test("android aio/air: useLocal honours the documented tuple form", () => {
  // `const [value, set] = useLocal(init)` — the spelling docs call preferred.
  const [value, set] = android.useLocal("a");
  assertEquals(value, "a");
  assertEquals(typeof set, "function");
  // …and its TYPE survives `noUncheckedIndexedAccess` (this repo compiles with
  // it on, so the annotation below is the assertion). A field report suspected
  // the tuple widened to `string | undefined` there, which would have made the
  // documented spelling unusable in a strict app; it does not — a tuple has
  // fixed arity, and the flag only widens index signatures and arrays.
  const strict: string = value;
  assertEquals(strict, "a");
});

Deno.test("android aio/air: useLocal exposes patch() for object state", () => {
  const local = android.useLocal({ a: 1, b: 2 });
  assertEquals(typeof local.patch, "function");
  local.patch({ b: 3 });
  assertEquals(local.local, { a: 1, b: 3 });
});

Deno.test("android aio/air: useLocal.set accepts an updater function", () => {
  const local = android.useLocal(1);
  local.set((n) => n + 1);
  assertEquals(local.local, 2);
});

Deno.test("android aio/air: useLocal is the SAME implementation, not a copy", () => {
  // Two implementations of one public name is the defect itself — a contract
  // that agrees today drifts the next time only one of them is edited.
  assertEquals(
    android.useLocal,
    air.useLocal,
    "src/standalone-air.ts must re-export aio/air's useLocal, not define a " +
      "second one",
  );
});

// ── 2. the android surface gap is enumerated, never discovered ───────────

/** Exports of `aio/air` that the android (standalone) runtime deliberately
 *  does not ship, each because it needs something android has no equivalent
 *  of. Shrinking this list is always allowed; growing it is a decision. */
const ABSENT_ON_ANDROID: Record<string, string> = {
  // Server transport: a standalone app has no WS/IPC connection to report on.
  isConnectionDegraded: "no server transport in a standalone app",
  useConnected: "no server transport in a standalone app",
  useProjection: "built on the transport's reference-sharing projector",
  // Auth UI talks to /__aio/auth/* on a server.
  SignIn: "server auth endpoints",
  signOut: "server auth endpoints",
  useUser: "server auth endpoints",
  // Browser-history router.
  Link: "browser-history router",
  NavLink: "browser-history router",
  Outlet: "browser-history router",
  Redirect: "browser-history router",
  Route: "browser-history router",
  navigate: "browser-history router",
  routePath: "browser-history router",
  routeSearch: "browser-history router",
  useNavigate: "browser-history router",
  useRoute: "browser-history router",
  // Server-side rendering / islands — there is no HTML shell to hydrate into.
  island: "SSR/islands are a server-rendered-page concern",
  reactIsland: "SSR/islands are a server-rendered-page concern",
  renderToStream: "SSR/islands are a server-rendered-page concern",
  // Devtools + test harness connect over the dev server / a DOM shim.
  connectAioDevTools: "devtools bridge is a dev-server concern",
  connectDevTools: "devtools bridge is a dev-server concern",
  disconnectDevTools: "devtools bridge is a dev-server concern",
  setDocument: "test-only DOM injection",
  testComponent: "test-only component harness",
  useTimeTravel: "time travel streams from the server's action log",
};

Deno.test("android aio/air: every absent export is a listed decision", () => {
  const surprises: string[] = [];
  for (const name of Object.keys(air)) {
    if (name in android) continue;
    if (name in ABSENT_ON_ANDROID) continue;
    surprises.push(name);
  }
  assertEquals(
    surprises,
    [],
    "these `aio/air` exports vanish on android with no recorded reason — an " +
      "app that uses them builds everywhere and fails only there:\n  " +
      surprises.join("\n  "),
  );
});

Deno.test("android aio/air: the absent list has no dead entries", () => {
  const stale = Object.keys(ABSENT_ON_ANDROID).filter((n) =>
    !(n in air) || n in android
  );
  assertEquals(
    stale,
    [],
    "listed as absent but no longer missing (or no longer on aio/air) — the " +
      "ledger has to shrink when the gap does",
  );
});

Deno.test("android aio/air: the primitives an app cannot render without are present", () => {
  // A spot-check with names, so the failure reads as the capability lost
  // rather than as a count.
  for (
    const name of [
      "signal",
      "computed",
      "effect",
      "h",
      "Fragment",
      "Show",
      "mount",
      "useForm",
      "useRef",
      "onMount",
    ]
  ) {
    assert(
      name in android,
      `android's aio/air does not export ${name} — the bundle fails to build ` +
        `the moment an app uses it`,
    );
  }
});
