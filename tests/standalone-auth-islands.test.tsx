// The auth UI and islands on the standalone (android) runtime.
//
// Both were KNOWN_DRIFT in tests/standalone-export-parity.test.ts — names an
// app imports from `aio/air` that type-check on every target and die at APK
// bundle time. The decisions, pinned here:
//
//  • auth UI — a standalone app has no server session, so `useUser()` resolves
//    to the anonymous branch (`null`, never `undefined`/loading), `<SignIn/>`
//    renders nothing and says so once, `signOut()` resolves. A component
//    written as `user ? <App/> : <SignIn/>` renders the same branch a signed-
//    out visitor of the server build sees.
//  • islands — `island()`/`reactIsland()` are client-side framework interop
//    with no transport or SSR in them; the SAME implementation as `aio/air`.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { captureConsole } from "./console-capture.ts";
import * as standalone from "../src/standalone-air.ts";
import * as air from "../src/air.ts";
import {
  _resetState,
  island,
  SignIn,
  signOut,
  useUser,
} from "../src/standalone-air.ts";

const gate = cell("standalone-auth-gate", {
  state: { opened: 0 },
  methods: {
    open(s: { opened: number }) {
      s.opened++;
    },
  },
});

function Private() {
  return <div class="private">private</div>;
}
function App() {
  const user = useUser();
  return (
    <div>
      {user ? <Private /> : <div class="anon">anonymous</div>}
      <SignIn />
      <div class="button" onClick={() => gate.open()}>Open</div>
    </div>
  );
}

testUI(
  App,
  "standalone auth UI: the anonymous branch renders, <SignIn/> renders nothing and hints once",
  async (ui) => {
    const html = ui.html();
    assert(html.includes('class="anon"'), "useUser() is null → anonymous UI");
    assert(!html.includes("private"), "no session, no private branch");
    assert(!/<form|<input/.test(html), "<SignIn/> draws no dead-end form");
    // The app keeps working around it.
    ui.OpenButton.click();
    await ui.expectCell(gate, (c) => c.opened === 1);
  },
);

Deno.test("standalone auth UI: useUser() is resolved-anonymous, signOut() resolves", async () => {
  assertEquals(useUser(), null, "null (resolved), never undefined (loading)");
  await signOut();
});

Deno.test("standalone auth UI: <SignIn/> says why it renders nothing — once", () => {
  _resetState(); // the hint is per runtime instance; testUI resets it per mount
  const lines = captureConsole(() => {
    assertEquals(SignIn({}), null);
    assertEquals(SignIn({}), null);
  });
  const hints = lines.filter((l) =>
    l.includes("no server session") && l.includes("--android --remote")
  );
  assertEquals(hints.length, 1, "one hint, not one per render");
});

Deno.test("standalone auth UI: SignIn accepts the browser SignIn's props (shared components type-check)", () => {
  // Compile-time assertion: the standalone SignIn takes every prop the
  // browser one does. A narrower signature would split a shared App by target.
  const props: Parameters<typeof air.SignIn>[0] = {};
  assertEquals(SignIn(props), null);
});

Deno.test("standalone islands: island()/reactIsland() are the SAME implementation as aio/air", () => {
  assert(standalone.island === air.island, "island must be a re-export");
  assert(
    standalone.reactIsland === air.reactIsland,
    "reactIsland must be a re-export",
  );
});

Deno.test("standalone islands: src/air/island.ts and react-island.ts carry no transport", async () => {
  for (const f of ["island.ts", "react-island.ts"]) {
    const src = await Deno.readTextFile(
      new URL(`../src/air/${f}`, import.meta.url),
    );
    const bad = [...src.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((s) => /\/(browser|server)\//.test(s) || s.includes("ssr"));
    assertEquals(bad, [], `${f} reaches transport/SSR: ${bad.join(", ")}`);
  }
});

function Widget() {
  const Isl = island({
    load: () => Promise.resolve({ default: "widget" }),
    mount: (container, _c, props) => {
      container.textContent = `island:${props.n}`;
      return {
        update(p) {
          container.textContent = `island:${p.n}`;
        },
        unmount() {
          container.textContent = "";
        },
      };
    },
    props: () => ({ n: gate.opened }),
  });
  return (
    <div>
      <Isl />
      <div class="button" onClick={() => gate.open()}>Open</div>
    </div>
  );
}

testUI(
  Widget,
  "standalone islands: an island mounts on the standalone runtime and follows cell state",
  async (ui) => {
    await ui.waitFor(() => ui.html().includes("island:0"));
    ui.OpenButton.click();
    await ui.waitFor(() => ui.html().includes("island:1"));
  },
);
