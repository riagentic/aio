// A field report (#9): an app holding ONE workspace watcher under a constant
// key replaces it on every "open folder" — exactly the documented replace-by-key
// pattern, on purpose — and dev still logged "already held — disposing the
// previous resource" once per session. `// aiol-ok` quieted the linter, but the
// runtime had no way to hear "replacing is the point", so an intended replace
// and an accidental key reuse looked the same in the log.
//
// `own.set(id, factory, { replace: true })` says so, for THAT call only: the
// warning stays for every other call site, including a later set of the same
// key without the option.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createOwnManager, own, type OwnEffect } from "../src/state/own.ts";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

function capture() {
  const warns: string[] = [];
  const log = {
    info: (_: string) => {},
    warn: (m: string) => warns.push(m),
    error: (m: string) => warns.push("ERROR " + m),
    debug: (_: string) => {},
  };
  return { warns, log };
}

function withDev<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  g.__aioDev = true;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete g.__aioDev;
    else g.__aioDev = prev;
  }
}

Deno.test("own.set { replace: true }: an intended replace is silent, and still replaces", () => {
  const { warns, log } = capture();
  const order: string[] = [];
  withDev(() => {
    const m = createOwnManager(log);
    m.handle(own.set("ws:watcher", () => () => order.push("dispose:a"), {
      replace: true,
    }));
    m.handle(own.set("ws:watcher", () => () => order.push("dispose:b"), {
      replace: true,
    }));
    assertEquals(order, ["dispose:a"], "the previous resource is disposed");
    assertEquals(m.active(), ["ws:watcher"]);
    m.disposeAll();
  });
  assertEquals(warns, [], "an intended replace must not warn");
});

Deno.test("own.set { replace: true } silences THAT call only — a plain re-set still warns", () => {
  const { warns, log } = capture();
  withDev(() => {
    const m = createOwnManager(log);
    m.handle(own.set("k", () => () => {}, { replace: true }));
    m.handle(own.set("k", () => () => {}, { replace: true }));
    assertEquals(warns, [], "the opted-in replace is silent");
    // Same key, no opt-in: this call site did NOT say replacing is intended.
    m.handle(own.set("k", () => () => {}));
    m.disposeAll();
  });
  assertEquals(warns.length, 1, `one warn for the plain call: ${warns}`);
  assert(/own: 'k' was already held/.test(warns[0]!));
});

Deno.test("own.set { replace: true } on one key does not silence another", () => {
  const { warns, log } = capture();
  withDev(() => {
    const m = createOwnManager(log);
    m.handle(own.set("a", () => () => {}, { replace: true }));
    m.handle(own.set("a", () => () => {}, { replace: true }));
    m.handle(own.set("b", () => () => {}));
    m.handle(own.set("b", () => () => {}));
    m.disposeAll();
  });
  assertEquals(warns.length, 1);
  assert(/own: 'b' was already held/.test(warns[0]!));
});

Deno.test("own.set { replace: false } / no options: the warning is unchanged", () => {
  const { warns, log } = capture();
  withDev(() => {
    const m = createOwnManager(log);
    m.handle(own.set("x", () => () => {}, { replace: false }));
    m.handle(own.set("x", () => () => {}, { replace: false }));
    m.disposeAll();
  });
  assertEquals(warns.length, 1);
});

Deno.test("own.set { replace: true }: the effect stays plain data (survives structuredClone)", () => {
  const e = own.set("c:w", () => {}, { replace: true });
  const cloned = structuredClone(e) as OwnEffect;
  assertEquals((cloned as { replace?: boolean }).replace, true);
  // Without the option the effect carries no extra key — byte-identical to
  // every effect an app emitted before the option existed.
  const plain = own.set("c:w", () => {});
  assert(!("replace" in plain), "no option ⇒ no `replace` key on the effect");
});

Deno.test("own.set options fail loud on a typo or a non-boolean", () => {
  // A misspelled key would otherwise leave the warning on while the author
  // believes it is off — the silent kind of wrong this option exists to avoid.
  assertThrows(
    () =>
      own.set("t", () => {}, { replaced: true } as unknown as {
        replace: boolean;
      }),
    TypeError,
    "replaced",
  );
  assertThrows(
    () =>
      own.set("t", () => {}, { replace: "yes" } as unknown as {
        replace: boolean;
      }),
    TypeError,
    "replace",
  );
});

// End to end through a real dispatch (the effect travels through the method,
// the effect channel and the runtime's manager) — not just the manager.

const ws = cell("own-replace-e2e", {
  state: { dir: "" },
  methods: {
    open(s, dir: string) {
      s.dir = dir;
      s.$do(own.set("own-replace-e2e:watcher", () => () => {}, {
        replace: true,
      }));
    },
  },
});

Deno.test("own.set { replace: true } through a booted cell: no 'already held' line", async () => {
  const said: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => said.push(a.map(String).join(" "));
  }
  try {
    await using _h = await bootCells([ws]);
    await ws.open("/a");
    await ws.open("/b");
  } finally {
    Object.assign(console, orig);
  }
  assert(
    !said.some((l) => /already held/.test(l)),
    `an intended replace must be silent: ${said.join("\n")}`,
  );
});
