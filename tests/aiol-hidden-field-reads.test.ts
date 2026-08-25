// aiol rule 25 — the static half of the client-read tripwire (field report §3.3):
// a sync method of a sync/localFirst/client-scoped cell, or a selector of any
// cell, that reads a `visible`-hidden field throws on the client
// (dev and prod alike). The runtime guard is the guarantee; this
// names the read with file:line before anything runs, and names the fix.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSyncMethodHiddenReads } from "../aiol/checks.ts";

async function issues(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkSyncMethodHiddenReads(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: a sync method of a sync cell reading an excluded field is an ERROR naming the fix", async () => {
  const found = await issues({
    "src/vault.ts": `import { cell } from "aio";
export const vault = cell("vault", {
  state: { accounts: [] as string[], encSecKey: "", hasVault: false },
  visible: { exclude: ["encSecKey"] },
  sync: true,
  methods: {
    unlock(s: { encSecKey: string }) {
      if (s.encSecKey === "") throw new Error("no vault");
    },
    async rotate(s: { encSecKey: string }) { s.encSecKey = "x"; },
  },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assertEquals(i.line, 8);
  assert(i.message.includes('"unlock"'), i.message);
  assert(i.message.includes("s.encSecKey"), i.message);
  assert(i.message.includes("REPLAY on the client"), i.message);
  assert(
    i.message.includes("hasEncSecKey: boolean"),
    "names the fact-field fix",
  );
  assert(i.message.includes("server-side/async"), "names the other fix");
});

Deno.test("aiol: a selector reading a hidden field is flagged on ANY cell (selectors run client-side)", async () => {
  const found = await issues({
    "src/vault.ts": `import { cell } from "aio";
export const vault = cell("vault", {
  state: { accounts: [{ name: "a", encSecKey: "" }], pin: "" },
  visible: { exclude: ["pin", "accounts.encSecKey"] },
  methods: {
    // NOT a sync/client cell: sync methods run server-side, untouched.
    setPin(s: { pin: string }, p: string) { s.pin = p; },
  },
  selectors: {
    vaultInitialized: (s: { accounts: { encSecKey: string }[] }) => {
      return s.accounts.some((a) => a.encSecKey !== "");
    },
    hasPin: { deps: ["auth"], fn(s: { pin: string }) { return s.pin !== ""; } },
  },
});
`,
  });
  assertEquals(found.length, 2, JSON.stringify(found));
  const names = found.map((i) => /selector "(\w+)"/.exec(i.message)?.[1]);
  assertEquals(names.sort(), ["hasPin", "vaultInitialized"]);
  const deep = found.find((i) => i.message.includes("vaultInitialized"))!;
  assert(deep.message.includes('"accounts.encSecKey"'), "names the dot-path");
});

Deno.test("aiol: scope: 'client' counts as replaying; visible: 'none' hides every key", async () => {
  const found = await issues({
    "src/ui.ts": `import { cell } from "aio";
export const ui = cell("ui", {
  state: { token: "", open: false },
  visible: "none",
  scope: "client",
  methods: {
    toggle(state: { open: boolean }) { state.open = !state.open; },
  },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  assert(found[0]!.message.includes("state.open"), found[0]!.message);
});

Deno.test("aiol: the fact-field pattern passes clean, and so does a non-sync cell", async () => {
  const clean = await issues({
    "src/vault.ts": `import { cell } from "aio";
export const vault = cell("vault", {
  state: { encSecKey: "", hasVault: false },
  visible: { exclude: ["encSecKey"] },
  sync: true,
  methods: {
    // The fact is published beside the secret; the reducer reads the fact.
    unlock(s: { hasVault: boolean }) { if (!s.hasVault) throw new Error("no"); },
    async rotate(s: { encSecKey: string }) { s.encSecKey = "x"; s.hasVault = true; },
  },
  selectors: { ready: (s: { hasVault: boolean }) => s.hasVault },
});
export const plain = cell("plain", {
  state: { secret: "", n: 0 },
  visible: { exclude: ["secret"] },
  methods: { touch(s: { secret: string }) { s.secret = "server-side, fine"; } },
});
`,
  });
  assertEquals(clean, []);
});

Deno.test("aiol: aiol-ok on the line above suppresses the finding", async () => {
  const clean = await issues({
    "src/v.ts": `import { cell } from "aio";
export const v = cell("v", {
  state: { secret: "" },
  visible: { exclude: ["secret"] },
  sync: true,
  methods: {
    peek(s: { secret: string }) {
      // aiol-ok: replay reads undefined by design here
      return s.secret;
    },
  },
});
`,
  });
  assertEquals(clean, []);
});
