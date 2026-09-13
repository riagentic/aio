// A TOTP code is spent for good — a RESTART does not give it back.
//
// `verifyTotp` remembered the last accepted step in memory, keyed by secret.
// The in-file comment reasoned that a 90-second window made a restart
// irrelevant; but a crash, a deploy or `am restart` happens on its own
// schedule, and a code observed (shoulder, screen share, proxy log) just before
// one was accepted again just after it. The accepted step now lives on the
// account row in auth.db.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { _resetTotpReplay, totpCode } from "../src/server/auth-totp.ts";
import { awaitStableTotpWindow } from "./totp-window-helper.ts";

Deno.test("totp: a code accepted before a restart is refused after it", async () => {
  _resetAuthFails();
  _resetTotpReplay();
  const baseDir = await tempDir("aio-totp-restart-");
  const appId = `totp-restart-${crypto.randomUUID().slice(0, 8)}`;
  const boot = () =>
    testServer({
      cells: [cell("totp_restart", { state: { n: 0 }, methods: {} })],
      auth: true,
      appId,
      baseDir,
    });
  const post = async (
    url: string,
    path: string,
    body: unknown,
    bearer?: string,
  ) => {
    const r = await fetch(`${url}/__aio/auth/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        origin: url,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const pw = "correct horse battery";
  try {
    // Room for every step below to stay inside one ±1 window.
    await awaitStableTotpWindow(12_000);
    const step = Math.floor(Date.now() / 30_000);
    let observed: string;
    let secret: string;
    {
      const a = await boot();
      try {
        const su = await post(a.url, "signup", { id: "tess", password: pw });
        assertEquals(su.status, 201);
        secret = (await post(a.url, "totp/setup", {}, su.j.token)).j.secret;
        const en = await post(a.url, "totp/enable", {
          code: await totpCode(secret, step - 1),
          password: pw,
        }, su.j.token);
        assertEquals(en.status, 200);
        // The owner signs in with the current code — the one an observer saw.
        observed = await totpCode(secret, step);
        const l = await post(a.url, "login", { id: "tess", password: pw });
        const t = await post(a.url, "totp", {
          pending: l.j.pending,
          code: observed,
        });
        assertEquals(t.status, 200, "the owner's login succeeds");
      } finally {
        await a.close();
      }
    }
    // A new process has no memory of it. (The closed store unhooked itself,
    // so this clears memory only — exactly what a restart does.)
    _resetTotpReplay();

    const b = await boot();
    try {
      const l = await post(b.url, "login", { id: "tess", password: pw });
      assert(l.j?.pending, "login asks for the second factor");
      const replay = await post(b.url, "totp", {
        pending: l.j.pending,
        code: observed,
      });
      assertEquals(
        replay.status,
        401,
        "a code spent before the restart must stay spent after it",
      );
      assertEquals(replay.j?.token, undefined);
      // Positive control: a NEWER step still signs in on the restarted app.
      const l2 = await post(b.url, "login", { id: "tess", password: pw });
      const fresh = await post(b.url, "totp", {
        pending: l2.j.pending,
        code: await totpCode(secret, step + 1),
      });
      assertEquals(fresh.status, 200, "the next code is accepted");
    } finally {
      await b.close();
    }
  } finally {
    await dropTempDir(baseDir);
  }
});
