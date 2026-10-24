// What each socket SEES, end to end: a seeded differential over real sockets.
//
// Three signed-in users drive random writes (sync and async) into four cells
// — a `forUser` per-owner view with a deep exclude, a deep-exclude records
// map + list, a top-level include, and an open cell — while clients join late,
// change subscriptions and ask for resyncs. Every frame each client receives
// is applied with the wire applier, and at checkpoints the result must equal
// what a FRESH socket of the same user and subscriptions is handed: the
// patches, the patch-or-full threshold and the debt paths all have to land on
// the same view the server would give that client now. And no frame may ever
// carry a hidden field or another user's row.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { applyWirePatches } from "../src/protocol/patch-ops.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TOK: Record<string, string> = {
  alice: "tok-alice-0123456789abcdefghij",
  bob: "tok-bob-0123456789abcdefghijkl",
  carol: "tok-carol-0123456789abcdefghij",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Markers only hidden fields ever hold. */
const HIDDEN = ["HID_", "PRIV_", "KEY_", "LKEY_", "SSN_", "ZZ_"];

/** Key-order-insensitive JSON (a subs-filtered frame orders cells by subs). */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
    ? `{${
      Object.keys(v).sort().map((k) =>
        `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`
      ).join(",")
    }}`
    : JSON.stringify(v);

Deno.test({
  name:
    "ws: every socket's applied frames equal a fresh view of its user, and nothing leaks",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    type Note = { owner: string; text: string; hid: string };
    const notes = cell("pvNotes", {
      state: { items: [] as Note[], n: 0, tag: "" },
      visible: {
        exclude: ["items.hid"],
        forUser: (s, u) => ({
          ...s,
          items: s.items.filter((i) => i.owner === u?.id),
        }),
      },
      access: () => true,
      methods: {
        add(s, owner: string, text: string) {
          s.items.push({ owner, text, hid: `HID_${owner}` });
          s.n++;
        },
        del(s, i: number) {
          if (s.items.length) s.items.splice(i % s.items.length, 1);
        },
        edit(s, i: number, t: string) {
          const it = s.items[i % Math.max(1, s.items.length)];
          if (it) it.text = t;
        },
        addTag(s, t: string) {
          s.tag += t;
        },
        async addLater(s, owner: string, text: string) {
          await sleep(1);
          s.items.push({ owner, text, hid: `HID_${owner}` });
        },
      },
    });
    type Acct = { name: string; key: string };
    const accts = cell("pvAccts", {
      state: {
        priv: "",
        rows: {} as Record<string, Acct>,
        list: [] as Acct[],
        pub: 0,
      },
      visible: { exclude: ["priv", "rows.key", "list.key"] },
      access: () => true,
      methods: {
        setPriv(s, v: string) {
          s.priv = `PRIV_${v}`;
        },
        put(s, id: string, n: string) {
          s.rows[id] = { name: n, key: `KEY_${id}` };
        },
        drop(s, id: string) {
          delete s.rows[id];
        },
        push(s, n: string) {
          s.list.push({ name: n, key: `LKEY_${n}` });
        },
        renameAll(s) {
          s.list = s.list.map((r) => ({ ...r, name: r.name + "!" }));
          s.rows = { ...s.rows };
        },
        bump(s) {
          s.pub++;
        },
      },
    });
    const inc = cell("pvInc", {
      state: { a: 0, p: { name: "" }, z: "" },
      visible: { include: ["a", "p"] },
      access: () => true,
      methods: {
        incA(s) {
          s.a++;
        },
        setP(s, n: string) {
          s.p = { name: n };
        },
        setZ(s, v: string) {
          s.z = `ZZ_${v}`;
        },
      },
    });
    const open = cell("pvOpen", {
      state: { log: [] as string[], s: "" },
      visible: "all",
      access: () => true,
      methods: {
        log1(s, v: string) {
          s.log.push(v);
          if (s.log.length > 12) s.log.shift();
        },
        appS(s, v: string) {
          s.s += v;
        },
      },
    });

    let seed = 7;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) /
      0x7fffffff;
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    const users = ["alice", "bob", "carol"] as const;
    const cells = ["pvNotes", "pvAccts", "pvInc", "pvOpen"] as const;
    const num = () => Math.floor(rnd() * 9);
    const ops: (() => [string, unknown[]])[] = [
      () => ["pvNotes:add", [pick(users), `t${num()}`]],
      () => ["pvNotes:addLater", [pick(users), `L${num()}`]],
      () => ["pvNotes:del", [num()]],
      () => ["pvNotes:edit", [num(), `e${num()}`]],
      () => ["pvNotes:addTag", ["x".repeat(num() % 4)]],
      () => ["pvAccts:setPriv", [`p${num()}`]],
      () => ["pvAccts:put", [pick(["u1", "u2", "key", "rows"]), `n${num()}`]],
      () => ["pvAccts:drop", [pick(["u1", "u2", "key"])]],
      () => ["pvAccts:push", [`l${num()}`]],
      () => ["pvAccts:renameAll", []],
      () => ["pvAccts:bump", []],
      () => ["pvInc:incA", []],
      () => ["pvInc:setP", [`n${num()}`]],
      () => ["pvInc:setZ", ["v"]],
      () => ["pvOpen:log1", [`v${num()}`]],
      () => ["pvOpen:appS", ["ab"]],
    ];

    const dir = await tempDir("aio-pv-diff");
    const port = freePort();
    const app = await aio.run({
      cells: [notes, accts, inc, open],
      appId: `pv-diff-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      baseDir: dir,
      port,
      users: Object.fromEntries(
        users.map((id) => [TOK[id], { id, role: "user" }]),
      ),
    });

    type Client = {
      name: string;
      user: string;
      ws: WebSocket;
      state: unknown;
      frames: string[];
      subs?: string[];
      broken?: string;
    };
    const all: Client[] = [];
    const connect = (name: string, user: string, subs?: string[]) =>
      new Promise<Client>((res, rej) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/ws?token=${TOK[user]}`,
        );
        const c: Client = {
          name,
          user,
          ws,
          state: undefined,
          frames: [],
          subs,
        };
        ws.onmessage = (e) => {
          const raw = String(e.data);
          const f = dec(raw);
          if (f?.t === "state") {
            c.frames.push(raw);
            c.state = f.d;
          } else if (f?.t === "patches") {
            c.frames.push(raw);
            try {
              c.state = applyWirePatches(c.state, f.d as never);
            } catch (err) {
              c.broken ??= String(err);
            }
          }
        };
        ws.onopen = () => {
          if (subs) ws.send(enc("subs", { subs }));
          res(c);
        };
        ws.onerror = () => rej(new Error("ws error"));
      });
    /** The view a fresh socket of `c`'s user and subscriptions is handed. */
    const freshView = async (c: Client) => {
      const f = await connect("fresh", c.user, c.subs);
      // The connect frame, then the subs reply when there are subs.
      for (let i = 0; i < 200 && f.frames.length < (c.subs ? 2 : 1); i++) {
        await sleep(5);
      }
      await sleep(20);
      f.ws.close();
      return f.state;
    };

    try {
      for (const u of users) all.push(await connect(u, u));
      all.push(await connect("alice-subs", "alice", ["pvNotes", "pvOpen"]));
      all.push(await connect("bob-subs", "bob", ["pvAccts", "pvInc"]));
      let cid = 0;
      const mismatches: string[] = [];
      for (let i = 0; i < 240; i++) {
        const [type, args] = pick(ops)();
        const by = pick(all.slice(0, 3));
        by.ws.send(enc("action", { type, payload: { args }, cid: `${cid++}` }));
        const r = rnd();
        if (r < 0.02 && all.length < 10) {
          const u = pick(users);
          all.push(
            await connect(
              `late${i}`,
              u,
              rnd() < 0.5 ? undefined : [pick(cells), pick(cells)],
            ),
          );
        } else if (r < 0.04) {
          const c = pick(all);
          c.subs = rnd() < 0.3 ? ["*"] : [pick(cells), pick(cells)];
          c.ws.send(enc("subs", { subs: c.subs }));
        } else if (r < 0.05) pick(all).ws.send(enc("resync"));
        if (rnd() < 0.3) await sleep(Math.floor(rnd() * 25));
        if (i % 60 === 59) {
          await sleep(250);
          for (const c of all) {
            const want = canon(await freshView(c));
            const got = canon(c.state);
            if (c.broken) mismatches.push(`${c.name} @${i}: ${c.broken}`);
            else if (got !== want) {
              mismatches.push(`${c.name} @${i}:\n got ${got}\nwant ${want}`);
            }
          }
        }
      }
      assertEquals(mismatches, [], "a client's applied frames diverged");

      const leaks: string[] = [];
      for (const c of all) {
        for (const f of c.frames) {
          const hidden = HIDDEN.find((m) => f.includes(m));
          if (hidden) leaks.push(`${c.name} got hidden ${hidden}: ${f}`);
          for (const other of users) {
            if (other !== c.user && f.includes(`"owner":"${other}"`)) {
              leaks.push(`${c.name} got ${other}'s row: ${f}`);
            }
          }
        }
      }
      assertEquals(leaks, [], "a frame carried what its client may not see");
    } finally {
      for (const c of all) c.ws.close();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
