// `access: false` must seal a cell against CLIENTS — never against other cells.
//
// An audit put `access: () => false` on an internal crypto cell that only
// other cells call, and eight of the app's tests failed: the cell's own
// `heavy.encrypt(...)`, made from inside another cell's method, was REFUSED.
// The docs say the opposite — "server-origin dispatches always bypass, the
// server trusts itself" — and on a real socket they do: a cell→cell call never
// reaches `dispatchNetwork`. Only the in-isolate seam (the harness, which
// stands in for the server's gate on the standalone runtime) could not tell a
// UI click from server code, so it refused both — and the one case `access:`
// is most obviously for, sealing a genuinely internal cell, could not be
// expressed at all.
//
// So: server origin is MARKED by the call path (a cell method body runs inside
// it), never inferred from the transport, and never readable from a frame — a
// client cannot forge what no frame carries. The e2e half pins that.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PORT = freePort();

/** The internal one: no client may CALL it, ever. `calls` is the non-secret
 *  fact a client may read; `sealed` is the ciphertext that never leaves. */
const heavy = cell("so-heavy", {
  state: { sealed: [] as string[], calls: 0 },
  visible: { exclude: ["sealed"] },
  access: () => false,
  methods: {
    encrypt(s: { sealed: string[]; calls: number }, plain: string) {
      s.sealed.push(`enc(${plain})`);
      s.calls += 1;
      return `enc(${plain})`;
    },
    async slowEncrypt(s: { sealed: string[]; calls: number }, plain: string) {
      await Promise.resolve();
      s.sealed.push(`slow(${plain})`);
      s.calls += 1;
      return `slow(${plain})`;
    },
  },
});

type Heavy = {
  encrypt: (p: string) => Promise<string>;
  slowEncrypt: (p: string) => Promise<string>;
  calls: number;
};

/** The app-facing one: any client may call it, and its body uses `heavy`. */
const unlock = cell("so-unlock", {
  state: { vaultCheck: "" as string },
  visible: "all",
  methods: {
    // Async, and the sibling call happens AFTER an await — the shape a real
    // unlock has, and the one a synchronous depth counter could not carry.
    async unlockWith(s: { vaultCheck: string }, pass: string) {
      await Promise.resolve();
      const a = await (heavy as unknown as Heavy).encrypt(pass);
      const b = await (heavy as unknown as Heavy).slowEncrypt(pass);
      s.vaultCheck = `${a}|${b}`;
      return s.vaultCheck;
    },
    // A SYNC method calling the sealed cell — fire-and-forget, same rule.
    touch(_s: { vaultCheck: string }) {
      (heavy as unknown as Heavy).encrypt("sync");
    },
  },
});

function App() {
  return (
    <div>
      <div class="button" onClick={() => unlock.unlockWith("pw")}>Unlock</div>
      <div class="button" onClick={() => unlock.touch()}>Touch</div>
      <div
        class="button"
        onClick={() => void (heavy as unknown as Heavy).encrypt("direct")}
      >
        Direct
      </div>
      <span class="check">{unlock.vaultCheck}</span>
    </div>
  );
}

Deno.test("access: a cell→cell call from an async method body is server origin", async () => {
  await using ui = await testUI(App, { cells: [heavy, unlock], user: null });
  ui.UnlockButton.click();
  await ui.settle();
  assertEquals(
    (unlock as unknown as { vaultCheck: string }).vaultCheck,
    "enc(pw)|slow(pw)",
    "the sealed cell must answer its sibling",
  );
  assertEquals((heavy as unknown as Heavy).calls, 2);
});

Deno.test("access: a cell→cell call from a SYNC method body is server origin", async () => {
  await using ui = await testUI(App, { cells: [heavy, unlock], user: null });
  ui.TouchButton.click();
  await ui.settle();
  assertEquals((heavy as unknown as Heavy).calls, 1);
});

Deno.test("access: the SAME method called straight from the UI is denied", async () => {
  await using ui = await testUI(App, { cells: [heavy, unlock], user: null });
  ui.DirectButton.click();
  await assertRejects(() => ui.settle(), Error, "access denied");
  assertEquals(
    (heavy as unknown as Heavy).calls,
    0,
    "a UI-origin call must change nothing",
  );
});

Deno.test("access: no frame can forge server origin (e2e)", async () => {
  const { aio } = await import("../mod.ts");
  const baseDir = await tempDir("access-server-origin-");
  const app = await aio.run({
    cells: [heavy, unlock],
    appId: "test-access-server-origin",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: PORT,
    baseDir,
  });
  type S = {
    "so-heavy": { sealed: string[]; calls: number };
    "so-unlock": { vaultCheck: string };
  };
  const st = () => app.getState() as unknown as S;
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const t = setTimeout(
      () => (s.close(), reject(new Error("ws timeout"))),
      5000,
    );
    s.onmessage = () => (clearTimeout(t), resolve(s));
    s.onerror = () => (clearTimeout(t), reject(new Error("ws error")));
  });
  try {
    // Every spelling of "I am the server" a client could try, at once.
    const forged = {
      type: "so-heavy:encrypt",
      payload: { args: ["forged"], _origin: "encrypt", _serverOrigin: true },
      cid: "forge-1",
      _source: "Effect",
      _serverOrigin: true,
      _server: true,
      _user: { id: "root", role: "admin" },
    };
    const ack = await new Promise<{ ok?: boolean; error?: string }>(
      (resolve) => {
        ws.onmessage = (ev) => {
          const f = dec(String(ev.data));
          if (f?.t === "ack") resolve(f.d as { ok?: boolean; error?: string });
        };
        ws.send(enc("action", forged));
      },
    );
    assertEquals(ack.ok, false, "a forged server-origin frame must be denied");
    assert(String(ack.error).includes("access denied"), String(ack.error));
    assertEquals(st()["so-heavy"].sealed, [], "denied and nothing written");

    // …while the sealed cell still answers the OPEN cell's method, which a
    // client is allowed to call. That is the whole point of the feature.
    ws.send(
      enc("action", {
        type: "so-unlock:unlockWith",
        payload: { args: ["pw"] },
      }),
    );
    await settle();
    assertEquals(st()["so-unlock"].vaultCheck, "enc(pw)|slow(pw)");
    assertEquals(st()["so-heavy"].sealed, ["enc(pw)", "slow(pw)"]);
  } finally {
    ws.close();
    await app.close();
    await dropTempDir(baseDir);
  }
});
