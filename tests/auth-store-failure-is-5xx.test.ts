// An auth route whose STORE fails answers 5xx and logs it — never a 4xx.
//
// auth.db deleted under a running app makes every write throw (the file
// guard). `signup` mapped every non-`user_exists` error to `400`, so the
// client was told its request was bad, nothing reached the server log, and an
// operator saw only a trickle of "bad requests". `login` let the throw escape
// to Deno's default handler: a bare 500 on stderr, outside the app's log.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type AuthFlows, handleAuthFlow } from "../src/server/auth-flows.ts";
import { openSessionStore } from "../src/server/sessions.ts";
import { openUserStore } from "../src/server/auth-users.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PW = "correct horse battery";

Deno.test("auth: a store that cannot write answers 503 + an error log; a bad request stays 4xx", async () => {
  _resetAuthFails();
  const dir = await tempDir("aio-auth-store-fail-");
  const path = join(dir, "auth.db");
  const sessions = openSessionStore(path);
  const users = openUserStore(path, { sessions: () => sessions });
  const cfg = {
    users,
    sessions,
    signup: true,
    cookie: false,
    secure: false,
    appTitle: "t",
  } as AuthFlows;
  let n = 0;
  const post = async (p: string, body: unknown, bearer?: string) => {
    const req = new Request(`http://127.0.0.1:1/__aio/auth/${p}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    // A fresh client key per request: the budgets are not what is tested.
    const r =
      (await handleAuthFlow(req, new URL(req.url), cfg, `10.0.1.${++n}`))!;
    return { status: r.status, j: await r.json() };
  };
  const errors: string[] = [];
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (level: string, _cat: string, msg: string) => {
      if (level === "error") errors.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    await users.create("alice", PW);
    const token = sessions.issue({ id: "alice", role: "user" });
    const reset = users.issueToken("reset", "alice", 60_000);
    for (const f of ["auth.db", "auth.db-wal", "auth.db-shm"]) {
      await Deno.remove(join(dir, f)).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
    }
    // A genuinely bad request is still the client's fault.
    const bad = await post("signup", { id: "bob", password: "short" });
    assertEquals(bad.status, 400, JSON.stringify(bad.j));
    assertEquals(errors.length, 0, errors.join("\n"));

    for (
      const [route, body, bearer] of [
        ["signup", { id: "bob", password: PW }],
        ["login", { id: "alice", password: PW }],
        ["password", { old: PW, new: "another long password" }, token],
        ["reset", { token: reset, password: "another long password" }],
      ] as [string, unknown, string?][]
    ) {
      const before = errors.length;
      const r = await post(route, body, bearer);
      assert(
        r.status >= 500,
        `${route}: a storage failure answered ${r.status} ${
          JSON.stringify(r.j)
        }`,
      );
      assert(errors.length > before, `${route}: nothing logged at error level`);
    }
  } finally {
    setLogger(prev);
    users.close();
    sessions.close();
    await dropTempDir(dir);
    _resetAuthFails();
  }
});
