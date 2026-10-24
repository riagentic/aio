// A short static `users:` token is guessable at network speed: the failure
// budget throttles FAILED authentication, and a valid token is served over
// budget by design (tests/auth-ws-url-token-metered.test.ts connects "b42").
// The design stays; the config smell is announced at boot — dev AND prod —
// naming the user, never the token.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import {
  tokenEntropyBits,
  weakStaticTokenUsers,
} from "../src/server/server-auth.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("weakStaticTokenUsers: short or low-entropy tokens are weak, random ones are not", () => {
  const u = (id: string) => ({ id, role: "user" });
  assertEquals(
    weakStaticTokenUsers({
      "b42": u("short"),
      "abcdefghijklmnop": u("lower16"), // 16 × 4.7 = 75 bits
      "0123456789abcdef": u("hex16"), // 64 bits
      [crypto.randomUUID()]: u("uuid"),
      "alice-secret-123": u("mixed16"), // the docs' example: ~98 bits
      "Zq7-Lp2_xW9!mR4t": u("random16"),
    }),
    ["short", "lower16", "hex16"],
  );
  assert(tokenEntropyBits(crypto.randomUUID()) > 120);
  assertEquals(tokenEntropyBits(""), 0);
});

for (const prod of [false, true]) {
  Deno.test(`boot warns about a weak users: token (prod=${prod}) without printing it`, async () => {
    const dir = await tempDir("aio-weak-token-");
    const lines: string[] = [];
    const prev = getLogger();
    setLogger(
      {
        logDir: "",
        pub: (_lvl: string, cat: string, msg?: string) =>
          lines.push(`${cat} ${msg ?? ""}`),
        perf: () => {},
        flush: () => Promise.resolve(),
        // deno-lint-ignore no-explicit-any
      } as any,
    );
    let server;
    try {
      server = createServer({
        port: freePort(),
        title: "weak",
        getUIState: () => ({}),
        dispatch: () => {},
        baseDir: dir,
        debug: () => {},
        prod,
        distDir: join(dir, "dist"),
        users: {
          "b42": { id: "bob", role: "admin" },
          [crypto.randomUUID()]: { id: "alice", role: "user" },
        },
      });
    } finally {
      setLogger(prev);
    }
    try {
      const warn = lines.filter((l) => l.includes("weak static"));
      assertEquals(warn.length, 1, lines.join("\n"));
      assert(warn[0]!.includes('"bob"') && !warn[0]!.includes('"alice"'));
      assert(!warn[0]!.includes("b42"), "the token itself is never logged");
    } finally {
      await server.shutdown();
      await dropTempDir(dir);
    }
  });
}

// A static map is known at boot, so an entry that names nobody (a bare string,
// no id) is said THEN — not on the first login, where dev refuses its token.
// By position, never by token.
Deno.test("boot warns about a users: entry that names nobody, without its token", async () => {
  const dir = await tempDir("aio-users-shape-");
  const lines: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (_lvl: string, cat: string, msg?: string) =>
        lines.push(`${cat} ${msg ?? ""}`),
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  const tok = crypto.randomUUID();
  let server;
  try {
    server = createServer({
      port: freePort(),
      title: "shape",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      distDir: join(dir, "dist"),
      users: {
        [crypto.randomUUID()]: { id: "alice", role: "user" },
        // deno-lint-ignore no-explicit-any
        [tok]: "bob" as any,
      },
    });
  } finally {
    setLogger(prev);
  }
  try {
    const warn = lines.filter((l) => l.includes("users: entry"));
    assertEquals(warn.length, 1, lines.join("\n"));
    assert(warn[0]!.includes("#2") && warn[0]!.includes("a string"), warn[0]);
    assert(!warn[0]!.includes(tok), "the token itself is never logged");
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});
