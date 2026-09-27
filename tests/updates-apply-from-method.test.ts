// `updates.apply()` / `check()` awaited from an APP method. `long` lifted
// only the updates method's own ceiling, so the caller — the app's method —
// was told "stopped waiting after 30000ms" while a multi-minute install went
// on (field report). The install pauses every pending deadline, as a file
// picker does.
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/cell-test.ts";
import { cell } from "../mod.ts";
import { _setCallTimeouts } from "../src/state/cell-impl.ts";
import {
  installUpdatesRuntime,
  updates,
  type UpdatesRuntime,
} from "../src/updates.ts";

const slow = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const offer = {
  kind: "offer" as const,
  update: {
    version: "2.0.0",
    reason: "",
    notes: null,
    size: null,
    releasedAt: null,
    migrates: false,
    signed: true,
    keyFingerprint: "abcdef012345",
    warnings: [],
  },
};
const runtime: UpdatesRuntime = {
  kind: "manifest",
  channel: "prod",
  current: "1.0.0",
  currentUnknown: null,
  exposed: false,
  check: () => slow(300).then(() => offer),
  apply: () => slow(300),
  setChannel: () => Promise.resolve(),
};
const app = cell("app", {
  state: {},
  methods: {
    async install() {
      await updates.check();
      await updates.apply();
      return updates.status;
    },
  },
});

Deno.test("updates: an app method awaiting a slow check and install is not 'stopped waiting'", async () => {
  // deno-lint-ignore no-explicit-any
  const h = await bootCells([app as any, updates as any]);
  installUpdatesRuntime(runtime);
  _setCallTimeouts(100);
  try {
    // deno-lint-ignore no-explicit-any
    assertEquals(await (app as any).install(), "staged");
  } finally {
    _setCallTimeouts();
    installUpdatesRuntime(null);
    h.dispose();
  }
});
