// STRICT MODE for unmigrated shape drift (a field ask): a persisted cell
// whose on-disk shape drifted from its declared shape with no `onMigrate`
// used to warn forever. DEV now refuses to boot — naming the cell, the
// drifted keys and the fix; PROD keeps the warning (dev stricter than prod:
// category (b) of the dev==prod rule). Both halves are proven on a real boot
// through the ONE decider (`parseCli().prod` → isDevBoot).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { shapeDriftRefusal } from "../src/server/aio-boot.ts";

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setMode(mode: "dev" | "prod"): void {
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}
function restoreArgs(): void {
  Object.defineProperty(Deno, "args", _argsDesc);
  _resetParsedCli();
}

Deno.test("shape-drift refusal: names the cell, the drifted keys and both fixes", () => {
  const msg = shapeDriftRefusal(
    [
      {
        cell: "wallet",
        path: "seedPhrase",
        issue: "unknown-field",
        storedType: "string",
      },
      {
        cell: "wallet",
        path: "balance",
        issue: "type-changed",
        storedType: "string",
        declaredType: "number",
      },
    ],
    "summary",
  );
  assert(msg.includes("REFUSING to boot (dev)"), msg);
  assert(
    msg.includes(
      'cell "wallet": seedPhrase (stored, not declared), balance (string stored, number declared)',
    ),
    msg,
  );
  assert(msg.includes("onMigrate"), msg);
  assert(msg.includes("persist: { exclude"), msg);
  assert(msg.includes("In production this is a warning"), msg);
});

Deno.test("shape-drift strict: DEV refuses to boot on unmigrated drift; PROD boots and warns", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shape-drift-strict-" });
  const dbPath = join(dir, "data.db");
  const appId = "shape-drift-strict";
  const boot = (declared: Record<string, unknown>, port: number) => {
    const wallet = cell("wallet", {
      state: declared,
      methods: {
        set(s: Record<string, unknown>, v: string) {
          s.seedPhrase = v;
        },
      },
    });
    return {
      wallet,
      app: aio.run({
        cells: [wallet],
        appId,
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        port,
        dbPath,
        baseDir: dir,
        persistDebounceMs: 10,
      }),
    };
  };
  try {
    // Boot A (dev): the older shape, persisted.
    setMode("dev");
    {
      const { wallet, app } = boot({ balance: 0, seedPhrase: "" }, freePort());
      const a = await app;
      await (wallet as unknown as { set: (v: string) => Promise<void> }).set(
        "x",
      );
      await new Promise((r) => setTimeout(r, 300));
      await a.close();
    }
    // Boot B (dev): `seedPhrase` dropped, no version bump → REFUSED.
    const err = await assertRejects(
      () => boot({ balance: 0 }, freePort()).app,
      Error,
    );
    const msg = (err as Error).message;
    assert(msg.includes("REFUSING to boot (dev)"), msg);
    assert(
      msg.includes('cell "wallet": seedPhrase (stored, not declared)'),
      msg,
    );
    assert(msg.includes("onMigrate"), msg);
    // Boot C (prod): the same drift BOOTS, and is warned about (the trojan
    // `migrations` route does not exist in prod — the log is the surface).
    setMode("prod");
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
    let app: Awaited<ReturnType<typeof aio.run>> | null = null;
    try {
      app = await boot({ balance: 0 }, freePort()).app;
    } finally {
      console.warn = origWarn;
      await app?.close();
    }
    const w = warned.join("\n");
    assert(w.includes("shape drift") && w.includes("wallet.seedPhrase"), w);
    assertEquals(app !== null, true);
  } finally {
    restoreArgs();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
