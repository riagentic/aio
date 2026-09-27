// `useAio().state` is a CLIENT read, so `visible:` applies to it — on every
// runtime, through the same seam `cell.field` and selectors use.
//
// Over a socket the hook reads the broadcast frame, which never carries a
// hidden field. The standalone runtime (the APK's `aio/air`) holds the
// composed, server-side state in the hook's signal, and the hook handed it out
// raw: `useAio().state.vault.secretKey` returned the secret there while
// `vault.secretKey` threw. The adapter hook under testUI is pinned in
// use-aio-visible-testui.test.tsx.
import { assertEquals, assertThrows } from "@std/assert";
import { _reset, aio, cell, useAio } from "../src/standalone-air.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

/** Boot a standalone app and run `check` against it. `build` makes the cells
 *  AFTER the runtime reset — `_reset()` clears the cell registry, and a real
 *  app's cells are registered at import, before `aio.run`. */
async function withStandalone(
  appId: string,
  build: () => {
    cells: Parameters<typeof aio.run>[0]["cells"];
    check: () => void;
  },
): Promise<void> {
  _reset();
  try {
    const { cells, check } = build();
    const app = await aio.run({ appId, cells, persist: false });
    try {
      check();
    } finally {
      await app.close();
    }
  } finally {
    _reset();
    _resetAioRuntime();
  }
}

Deno.test("standalone useAio(): a visible.exclude field is not in the state", async () => {
  await withStandalone("sauvVault", () => {
    const vault = cell("sauvVault", {
      state: { hasKey: true, secretKey: "sk-live-123" },
      visible: { exclude: ["secretKey"] },
      methods: {},
    });
    return {
      cells: [vault],
      check: () => {
        assertThrows(() => vault.secretKey);
        const { state } = useAio<{ sauvVault: Record<string, unknown> }>();
        const slice = state!.sauvVault;
        assertEquals(slice.hasKey, true);
        assertEquals(Object.keys(slice), ["hasKey"]);
        assertEquals(JSON.stringify(slice), '{"hasKey":true}');
        // Named, it throws exactly as `vault.secretKey` does — never a quiet
        // `undefined` a component could branch on as data.
        assertThrows(() => slice.secretKey, Error, "sauvVault.secretKey");
      },
    };
  });
});

Deno.test("standalone useAio(): a deep visible.exclude path is stripped", async () => {
  await withStandalone("sauvAcct", () => ({
    cells: [cell("sauvAcct", {
      state: { profile: { name: "ada", encSecKey: "k" } },
      visible: { exclude: ["profile.encSecKey"] },
      methods: {},
    })],
    check: () => {
      const { state } = useAio<
        { sauvAcct: { profile: Record<string, unknown> } }
      >();
      assertEquals(state!.sauvAcct.profile, { name: "ada" });
    },
  }));
});

Deno.test("standalone useAio(): visible.include keeps only the listed fields", async () => {
  await withStandalone("sauvInc", () => ({
    cells: [cell("sauvInc", {
      state: { shown: 1, apiToken: "t" },
      visible: { include: ["shown"] },
      methods: {},
    })],
    check: () => {
      const { state } = useAio<{ sauvInc: Record<string, unknown> }>();
      assertEquals(JSON.stringify(state!.sauvInc), '{"shown":1}');
    },
  }));
});

Deno.test('standalone useAio(): a visible:"none" cell is not in the state', async () => {
  await withStandalone("sauvHidden", () => ({
    cells: [
      cell("sauvHidden", {
        state: { token: "t0ps3cret" },
        visible: "none",
        methods: {},
      }),
      cell("sauvOpen", { state: { n: 1 }, methods: {} }),
    ],
    check: () => {
      const { state } = useAio<Record<string, unknown>>();
      assertEquals("sauvHidden" in state!, false);
      assertEquals(state!.sauvOpen, { n: 1 });
    },
  }));
});

Deno.test("standalone useAio(): the state follows commits", async () => {
  _reset();
  try {
    const c = cell("sauvLive", {
      state: { n: 0, apiSecret: "s" },
      visible: { exclude: ["apiSecret"] },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    const app = await aio.run({
      appId: "sauvLive",
      cells: [c],
      persist: false,
    });
    try {
      await c.inc();
      const { state } = useAio<{ sauvLive: Record<string, unknown> }>();
      assertEquals(JSON.stringify(state!.sauvLive), '{"n":1}');
    } finally {
      await app.close();
    }
  } finally {
    _reset();
    _resetAioRuntime();
  }
});

Deno.test('standalone useAio(): a scope:"client" cell\'s composed slice is not handed out', async () => {
  // The composed state holds the client cell's DECLARED slice, which the loop
  // never updates (the cell lives on its own signal) — a stale value, and one
  // no browser `useAio()` ever sees (the server never sends it).
  await withStandalone("sauvPrefs", () => ({
    cells: [cell("sauvPrefs", {
      scope: "client",
      state: { theme: "light" },
      methods: {
        setTheme(s, t: string) {
          s.theme = t;
        },
      },
    })],
    check: () => {
      const { state } = useAio<Record<string, unknown>>();
      assertEquals("sauvPrefs" in state!, false);
    },
  }));
});
