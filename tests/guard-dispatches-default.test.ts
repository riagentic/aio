// Supervised BY DEFAULT (alpha61) — a floating rejection is a loud log line,
// never process death.
//
// The mechanism shipped opt-in after one field report; the next one — a
// wallet — was still wrapping every schedule callsite in try/catch AND
// `.catch(()=>{})`, "exactly the kind of discipline a framework should make
// unnecessary", because a stray `void poll()` rejection killed the process
// mid-signing. For a server that owns persisted state, dying is not failing
// louder. `guardDispatches: false` remains the fail-fast opt-out.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { aio } from "aio";

Deno.test({
  name: "default: an unhandled rejection inside the app does not kill it",
  async fn() {
    const c = cell("guard-default", {
      state: { n: 0 },
      methods: {
        bump(s) {
          s.n++;
        },
        // The RIS-2 shape: fire-and-forget async work that rejects, launched
        // from a method with nothing awaiting it.
        detonate(_s) {
          void (async () => {
            await new Promise((r) => setTimeout(r, 1));
            throw new Error("floating rejection");
          })();
        },
      },
    });
    const app = await aio.run({
      appId: `guard-default-${crypto.randomUUID().slice(0, 8)}`,
      cells: [c],
      dbPath: ":memory:",
      client: "server-only",
      libraryMode: true,
      port: 0,
    });
    try {
      await c.detonate();
      await new Promise((r) => setTimeout(r, 30)); // the rejection lands here
      // Still alive, still dispatching:
      await c.bump();
      assertEquals(c.n, 1);
      assert(true, "process survived a floating rejection");
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name:
    "the guard NEVER swallows a boot failure — refusing to start stays fatal",
  async fn() {
    // Supervision is for RUNTIME strays. A rejection during boot is the app
    // refusing to start (a throwing onMigrate, a failed bind), and swallowing
    // it leaves a zombie — alive, serving nothing, holding the lock — where
    // the contract is a non-zero exit. Flipping the default without this gate
    // hung the framework's own boot-refusal test for over an hour: the child
    // process logged the rejection and idled instead of dying.
    //
    // Pinned at the unit seam (the crash handler), because a child-process
    // repro is the hour-long hang this exists to prevent.
    const { installCrashHandler } = await import(
      "../src/diagnostics/crash-handler.ts"
    );
    let booted = false;
    const prevented: boolean[] = [];
    const uninstall = installCrashHandler({
      log: { error: () => {} },
      getHealthData: () => ({ cells: {} }),
      writeEmergencyCheckpoint: () => {},
      guardRejections: true,
      isBootComplete: () => booted,
    });
    try {
      const fire = () => {
        const ev = new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.resolve(), // placeholder; reason carries the error
          reason: new Error("boom"),
          cancelable: true,
        });
        globalThis.dispatchEvent(ev);
        prevented.push(ev.defaultPrevented);
      };
      fire(); // during boot: NOT prevented — the process would (rightly) die
      booted = true;
      fire(); // after boot: supervised
      assertEquals(prevented, [false, true]);
    } finally {
      uninstall();
    }
  },
});
