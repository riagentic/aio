// The router on the standalone (android) runtime — routing is state, not
// transport.
//
// `Route`/`Link`/`NavLink`/`Outlet`/`Redirect`/`useRoute`/`navigate` used to be
// browser-entry-only because the components pulled `ensureConnected` from the
// WS transport; an android app using `<Route>` type-checked green and died at
// APK bundle time (RIS-11, the KNOWN_DRIFT ledger). They now live in
// src/air/router.ts with the runtime boot injected, and the standalone entry
// re-exports them. These tests mount a routed App on the standalone runtime
// (testUI boots exactly that runtime) and navigate — by Link click, by
// `navigate()`, by `Redirect`, through nested routes — and pin the one piece
// of android-specific behaviour: the packaged shell's `/assets/index.html` is
// adopted as the app's "/".
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import {
  _adoptShellPath,
  Link,
  navigate,
  NavLink,
  Outlet,
  Redirect,
  Route,
  routePath,
  useNavigate,
  useRoute,
} from "../src/standalone-air.ts";
import * as standalone from "../src/standalone-air.ts";
import * as air from "../src/air.ts";
import {
  _getRouteBase,
  _setRouteBase,
  navigate as coreNavigate,
  routePath as coreRoutePath,
} from "../src/air/router-core.ts";
import { _setRouterBoot, Route as RawRoute } from "../src/air/router.ts";

// A cell so testUI boots the standalone runtime (cells → aio.run) — the
// production path an android bundle takes, not a bare renderer mount.
const nav = cell("standalone-router-nav", {
  state: { visits: 0 },
  methods: {
    visit(s: { visits: number }) {
      s.visits++;
    },
  },
});

function Home() {
  return <div class="page">home</div>;
}
function Settings() {
  const { params } = useRoute<{ tab: string }>("/settings/:tab");
  return <div class="page">settings:{params.tab}</div>;
}
function Layout() {
  return (
    <section class="layout">
      <Outlet />
    </section>
  );
}
function User() {
  const { params } = useRoute<{ id: string }>("/users/:id");
  return <div class="page">user:{params.id}</div>;
}
function Jump() {
  const go = useNavigate();
  return (
    <div
      class="button"
      onClick={() => {
        nav.visit();
        go("/settings/privacy");
      }}
    >
      Jump
    </div>
  );
}

function App() {
  return (
    <div>
      <nav>
        <Link to="/">Home</Link>
        <NavLink to="/settings/general">Settings</NavLink>
        <Jump />
      </nav>
      <Route path="/" element={<Home />} />
      <Route path="/settings/:tab" element={<Settings />} />
      <Route path="/users" element={<Layout />}>
        <Route path=":id" element={<User />} />
      </Route>
      <span class="where">{routePath.value}</span>
    </div>
  );
}

const pageOf = (html: string) =>
  html.match(/class="page"[^>]*>([^<]*)</)?.[1] ?? null;

testUI(
  App,
  "standalone router: renders the route for '/' and navigates by Link click",
  async (ui) => {
    assertEquals(pageOf(ui.html()), "home");
    ui.SettingsLink.click();
    await ui.settle();
    assertEquals(pageOf(ui.html()), "settings:general");
    assert(ui.html().includes('class="active"'), "NavLink marks itself active");
    assert(ui.html().includes(">/settings/general<"), "routePath is a signal");
    ui.HomeLink.click();
    await ui.settle();
    assertEquals(pageOf(ui.html()), "home");
  },
);

testUI(
  App,
  "standalone router: useNavigate() from a component that also dispatches",
  async (ui) => {
    ui.JumpButton.click();
    await ui.settle();
    assertEquals(pageOf(ui.html()), "settings:privacy");
    await ui.expectCell(nav, (c) => c.visits === 1);
  },
);

testUI(
  App,
  "standalone router: programmatic navigate() + nested Route/Outlet + params",
  async (ui) => {
    navigate("/users/42");
    await ui.settle();
    assert(ui.html().includes('class="layout"'), "parent route rendered");
    assertEquals(pageOf(ui.html()), "user:42");
    navigate("/");
    await ui.settle();
    assertEquals(pageOf(ui.html()), "home");
    assert(!ui.html().includes('class="layout"'), "parent route left");
  },
);

function RedirectApp() {
  return (
    <div>
      <Route path="/" element={<Redirect to="/settings/redirected" />} />
      <Route path="/settings/:tab" element={<Settings />} />
    </div>
  );
}

testUI(
  RedirectApp,
  "standalone router: <Redirect/> navigates on mount",
  async (ui) => {
    await ui.waitFor(() => pageOf(ui.html()) === "settings:redirected");
  },
);

// ── a childless <Route/> written in TSX is an EXACT match ─────────────

function LeafApp() {
  return (
    <div>
      <Route path="/" element={<Home />} />
      <Route path="/settings/:tab" element={<Settings />} />
    </div>
  );
}

testUI(
  LeafApp,
  "standalone router: <Route path='/'/> in TSX does not match every path",
  async (ui) => {
    // The JSX runtime passes `children: []` for a childless element; the
    // router took that as "has nested routes" and matched "/" as a prefix of
    // everything, so Home stayed on screen beside every other page.
    navigate("/settings/general");
    await ui.settle();
    const pages = [...ui.html().matchAll(/class="page"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );
    assertEquals(pages, ["settings:general"]);
  },
);

// ── one implementation, every target ──────────────────────────────────

Deno.test("standalone router: the SAME components as aio/air, not a copy", () => {
  // Two implementations of one public name is the defect (see the android
  // surface test's useLocal rule): a contract that agrees today drifts the
  // next time only one copy is edited. Identity, not shape.
  for (
    const k of [
      "Route",
      "Link",
      "NavLink",
      "Outlet",
      "Redirect",
      "useRoute",
      "useNavigate",
      "navigate",
      "routePath",
      "routeSearch",
      "page",
    ] as const
  ) {
    assert(
      (standalone as Record<string, unknown>)[k] ===
        (air as Record<string, unknown>)[k],
      `${k}: src/standalone-air.ts and src/air.ts must export the same ` +
        `symbol (src/air/router.ts) — the browser entry still ships its own`,
    );
  }
});

Deno.test("standalone router: the router refuses to render outside a runtime entry", () => {
  // Never silent: `src/air/router.ts` imported directly has no boot step; a
  // Route rendered there is a wiring bug, not a state to run in.
  const prev = standalone.ensureConnected;
  _setRouterBoot(null);
  try {
    assertThrows(
      () => RawRoute({ path: "/", element: null }),
      Error,
      "no runtime installed",
    );
  } finally {
    _setRouterBoot(prev);
  }
});

// ── the packaged shell's document is the app's "/" ────────────────────

function stubLocation(href: string): () => void {
  const g = globalThis as Record<string, unknown>;
  const hadLoc = Object.getOwnPropertyDescriptor(globalThis, "location");
  const hadHist = Object.getOwnPropertyDescriptor(globalThis, "history");
  let cur = new URL(href);
  const entries: string[] = [href];
  let idx = 0;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get: () => ({
      href: cur.href,
      origin: cur.origin,
      pathname: cur.pathname,
      search: cur.search,
      hash: cur.hash,
      assign(u: string) {
        cur = new URL(u);
      },
    }),
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    get: () => ({
      pushState(_s: unknown, _t: string, u: string | URL) {
        cur = new URL(String(u), cur.href);
        entries.splice(idx + 1);
        entries.push(cur.href);
        idx++;
      },
      replaceState(_s: unknown, _t: string, u: string | URL) {
        cur = new URL(String(u), cur.href);
        entries[idx] = cur.href;
      },
      go(n: number) {
        idx = Math.max(0, Math.min(entries.length - 1, idx + n));
        cur = new URL(entries[idx]!);
      },
    }),
  });
  return () => {
    if (hadLoc) Object.defineProperty(globalThis, "location", hadLoc);
    else delete g.location;
    if (hadHist) Object.defineProperty(globalThis, "history", hadHist);
    else delete g.history;
  };
}

Deno.test("standalone router: /assets/index.html (the android asset loader) is adopted as '/'", () => {
  const restore = stubLocation(
    "https://appassets.androidplatform.net/assets/index.html?x=1",
  );
  try {
    _adoptShellPath();
    assertEquals(_getRouteBase(), "/assets");
    assertEquals(location.pathname, "/assets/", "URL rewritten, no load");
    assertEquals(location.search, "?x=1", "query kept");
    assertEquals(coreRoutePath.value, "/", "<Route path='/'> matches");
    // App-absolute navigation stays under the shell's directory, so relative
    // asset URLs (`./bundle.js`) keep resolving.
    coreNavigate("/settings/general");
    assertEquals(location.pathname, "/assets/settings/general");
    assertEquals(coreRoutePath.value, "/settings/general");
  } finally {
    _setRouteBase("");
    restore();
  }
});

Deno.test("standalone router: a document served from a directory is left alone", () => {
  const restore = stubLocation("http://localhost:3000/app/");
  try {
    _adoptShellPath();
    assertEquals(_getRouteBase(), "");
    assertEquals(location.pathname, "/app/");
  } finally {
    _setRouteBase("");
    restore();
  }
});

// ── the router carries no transport ───────────────────────────────────

Deno.test("standalone router: src/air/router*.ts import nothing from browser/ or server/", async () => {
  for (const f of ["router.ts", "router-core.ts"]) {
    const src = await Deno.readTextFile(
      new URL(`../src/air/${f}`, import.meta.url),
    );
    const bad = [...src.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((s) =>
        /\/(browser|server)\//.test(s) || s.includes("protocol-router")
      );
    assertEquals(bad, [], `${f} reaches the transport: ${bad.join(", ")}`);
  }
});
