// An async method's write-set carries the identity of the call that made it.
//
// A sync method's writes are reduced inside the user's own action, so
// `beforeReduce`/`onAction` see that user. An async method publishes its
// writes later, as a separate `cell:__setMethod` commit — and that commit
// reached the hooks as `user: undefined`. So the guard `docs/auth/auth.md`
// gives for per-user authorization,
//
//   if (type.startsWith("admin:") && user?.role !== "admin") return null;
//
// dropped every async write an ADMIN made, silently, while the call was acked
// `ok` with its return value. The author is read once per CALL, when its
// batcher is made in the call's own scope — never at flush time, because a
// second call's read flushes the first call's pending writes from the SECOND
// call's scope. Pinned below: two users' calls resume in one microtask turn.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOSS = "tok-boss-0123456789abcdefghij";
const ANN = "tok-ann-0123456789abcdefghijk";

Deno.test({
  name: "async write-set: beforeReduce/onAction see the caller, per call",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    type S = { n: number; m: number; by: string[] };
    let release!: () => void;
    const gate = new Promise<void>((r) => release = r);
    const admin = cell("admin", {
      state: { n: 0, m: 0, by: [] } as S,
      visible: "all",
      methods: {
        bump(s: S) {
          s.n++;
        },
        async bumpLater(s: S, who: string) {
          await gate;
          // Both calls resume in one microtask turn; the second one's first
          // read flushes the FIRST one's pending write-set from its own
          // scope — the author must still be the first caller.
          s.m++;
          s.by.push(who);
          return "done";
        },
      },
    });
    const seen: string[] = [];
    const dir = await tempDir("aio-ws-caller");
    const port = freePort();
    const app = await aio.run({
      cells: [admin],
      appId: `ws-caller-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      baseDir: dir,
      port,
      users: {
        [BOSS]: { id: "boss", role: "admin" },
        [ANN]: { id: "ann", role: "admin" },
      },
      // The guard from docs/auth/auth.md, verbatim.
      beforeReduce: (action, _s, user) => {
        const { type } = action as { type: string };
        if (type.startsWith("admin:") && user?.role !== "admin") return null;
        return action;
      },
      onAction: (action, _s, user) => {
        const { type, payload } = action as {
          type: string;
          payload?: { mutations?: { value?: unknown; args?: unknown[] }[] };
        };
        if (type === "admin:__setBumpLater") {
          // `by.push(who)` — the one mutation carrying a string.
          const pushed = payload?.mutations?.flatMap((m) => [
            m.value,
            ...(m.args ?? []),
          ]).find((v) => typeof v === "string");
          seen.push(`${pushed}:${user?.id}`);
        }
      },
    });
    const open = (tok: string) =>
      new Promise<{ ws: WebSocket; acks: unknown[] }>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
        const acks: unknown[] = [];
        ws.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t === "ack") acks.push(f.d);
        };
        ws.onopen = () => res({ ws, acks });
        ws.onerror = () => rej(new Error("ws error"));
      });
    const boss = await open(BOSS);
    const ann = await open(ANN);
    try {
      const call = (s: WebSocket, cid: string, args: unknown[]) =>
        s.send(enc("action", {
          type: "admin:bumpLater",
          payload: { args },
          cid,
        }));
      boss.ws.send(enc("action", {
        type: "admin:bump",
        payload: { args: [] },
        cid: "s",
      }));
      call(boss.ws, "b", ["boss"]);
      call(ann.ws, "a", ["ann"]);
      await sleep(100);
      release();
      for (let i = 0; i < 40 && boss.acks.length + ann.acks.length < 3; i++) {
        await sleep(25);
      }
      await sleep(50);
      const st = (app.getState() as { admin: S }).admin;
      assertEquals(st.n, 1, "control: the sync write passed the guard");
      assertEquals(
        st.m,
        2,
        `both admins' ASYNC writes must land (acks: ${
          JSON.stringify([...boss.acks, ...ann.acks])
        })`,
      );
      assertEquals(
        seen.sort(),
        ["ann:ann", "boss:boss"],
        "each write-set is attributed to its own caller",
      );
    } finally {
      boss.ws.close();
      ann.ws.close();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
