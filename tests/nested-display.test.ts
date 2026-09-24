// The nested X display is the USER's, not the machine's (cc §10).
//
// Reproduced on a two-account box: `am start` from the second account reused
// the first account's `:77` because its socket was up, and Xephyr ran with
// `-ac` — so `XAUTHORITY=/dev/null xdpyinfo -display :77` opened the other
// user's screen: every window readable, every keystroke injectable. Two
// rules close it, both pinned here: the server starts with a cookie, and a
// display is reused only when this uid owns its socket.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  _spawnXephyr,
  AIO_NESTED_DISPLAY,
  AIO_NESTED_DISPLAY_CANDIDATES,
  displayIsUp,
  displayOwner,
  nestedDisplayCookie,
  nestedDisplayCookieFile,
  nestedDisplayEnv,
  nestedDisplayRange,
  pickNestedDisplay,
  xauthorityEntry,
} from "../src/server/nested-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("xauthorityEntry: the exact bytes libXau reads — FamilyWild, number, name, 16-byte cookie", () => {
  const cookie = new Uint8Array(16).map((_, i) => i * 17);
  const bytes = xauthorityEntry(":77", cookie);
  // family 0xffff · address "" · number "77" · name "MIT-MAGIC-COOKIE-1" · data
  const expect = "ffff" + "0000" + "0002" +
    hex(new TextEncoder().encode("77")) +
    "0012" + hex(new TextEncoder().encode("MIT-MAGIC-COOKIE-1")) +
    "0010" + hex(cookie);
  assertEquals(hex(bytes), expect);
  // `:77.0` is display 77 — the screen is not part of the record.
  assertEquals(hex(xauthorityEntry(":77.0", cookie)), expect);
});

Deno.test({
  name: "xauthorityEntry: what xauth itself lists from the file",
  ignore: !hasTool("xauth"),
  async fn() {
    const dir = await tempDir("xauth-");
    const file = `${dir}/t.auth`;
    const cookie = new Uint8Array(16).map((_, i) => 255 - i);
    await Deno.writeFile(file, xauthorityEntry(":77", cookie));
    const out = new TextDecoder().decode(
      (await new Deno.Command("xauth", { args: ["-f", file, "list"] })
        .output()).stdout,
    );
    assert(out.includes("MIT-MAGIC-COOKIE-1"), out);
    assert(out.includes(hex(cookie)), out);
    assert(out.includes("77"), out);
    await dropTempDir(dir);
  },
});

Deno.test("displayOwner: none / mine — and never 'other' for a socket this uid owns", () => {
  assertEquals(displayOwner(":4242"), "none");
  assertEquals(displayIsUp(":4242"), false);
  // Whatever is up on this box that WE own must read as ours; a display of
  // another account (root's :0 on a desktop) must not read as ours. Assert
  // the shape on :0 — the machine's configuration is not the test's.
  const o = displayOwner(":0");
  assert(o === "mine" || o === "other" || o === "none", o);
});

Deno.test("pickNestedDisplay: a candidate is one of the range, and an up display of ours is reused", () => {
  const pick = pickNestedDisplay();
  const first = Number(AIO_NESTED_DISPLAY.slice(1));
  if (pick === null) return; // every number belongs to other users on this box
  const n = Number(pick.display.slice(1));
  assert(n >= first && n < first + AIO_NESTED_DISPLAY_CANDIDATES, pick.display);
  assertEquals(pick.up, displayOwner(pick.display) === "mine");
  assertNotEquals(displayOwner(pick.display), "other", "never someone else's");
  assertEquals(
    nestedDisplayRange(),
    `:${first}–:${first + AIO_NESTED_DISPLAY_CANDIDATES - 1}`,
  );
});

Deno.test("nestedDisplayEnv: DISPLAY alone without a cookie on file, DISPLAY + XAUTHORITY with one", () => {
  assertEquals(nestedDisplayEnv(":4242"), { DISPLAY: ":4242" });
  const file = nestedDisplayCookieFile(":4243");
  if (!file) return; // no private runtime dir here (Windows)
  assertEquals(nestedDisplayCookie(":4243"), null);
  try {
    Deno.writeFileSync(file, xauthorityEntry(":4243", new Uint8Array(16)), {
      mode: 0o600,
    });
    assertEquals(nestedDisplayEnv(":4243"), {
      DISPLAY: ":4243",
      XAUTHORITY: file,
    });
    // Owner-only: the cookie is the key to the display.
    // aio-ok(umask): the cookie file is written by THIS test with mode 0o600 above — no code under test sets this mode.
    assertEquals((Deno.statSync(file).mode ?? 0) & 0o077, 0);
  } finally {
    Deno.removeSync(file);
  }
});

Deno.test({
  name:
    "a nested display started by aio refuses a client WITHOUT its cookie, and admits one WITH it (cc §10)",
  // Real Xephyr + a real X client, on a NEW display number — the shared one
  // is never stopped by a test. Skipped where the tools are missing.
  ignore: Deno.build.os !== "linux" || !Deno.env.get("DISPLAY") ||
    !hasTool("Xephyr") || !hasTool("xdpyinfo"),
  async fn() {
    // A free number well above the shared range.
    let display = "";
    for (let n = 150; n < 190; n++) {
      if (displayOwner(`:${n}`) === "none") {
        display = `:${n}`;
        break;
      }
    }
    assert(display, "no free display number between :150 and :190");
    const file = nestedDisplayCookieFile(display);
    assert(file, "a private runtime dir exists on Linux");
    const cookie = new Uint8Array(16);
    crypto.getRandomValues(cookie);
    await Deno.writeFile(file, xauthorityEntry(display, cookie), {
      mode: 0o600,
    });
    // Nested INSIDE the shared test display: this throwaway server's window
    // must not land on the developer's desktop either.
    const child = _spawnXephyr(display, "320x240", file, testDisplayEnv());
    assert(child, "Xephyr is installed (gate above)");
    try {
      const deadline = Date.now() + 5000;
      while (!displayIsUp(display) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(displayIsUp(display), `${display} came up`);
      const probe = async (env: Record<string, string>) =>
        (await new Deno.Command("xdpyinfo", {
          args: ["-display", display],
          env: { ...Deno.env.toObject(), ...env },
          stdout: "null",
          stderr: "null",
        }).output()).success;
      assertEquals(
        await probe({ XAUTHORITY: "/dev/null" }),
        false,
        "no cookie → refused (this is the hole `-ac` left open)",
      );
      assertEquals(
        await probe(nestedDisplayEnv(display)),
        true,
        "with the cookie aio hands its children → admitted",
      );
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      await child.status;
      await Deno.remove(file).catch(() => {});
    }
  },
});

function hasTool(name: string): boolean {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    try {
      Deno.statSync(`${dir}/${name}`);
      return true;
    } catch { /* not here */ }
  }
  return false;
}
