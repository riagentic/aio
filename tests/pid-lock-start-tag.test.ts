// The start stamp in a build lock's `.id`, a link journal's name and an
// Electron stage's name must come back as the token it was written from.
//
// A Windows creation time is a FILETIME (~1.3e17), past a double's exact
// range: written through `Number` it came back rounded, never equal to the
// live process's own token, so every live holder read as a recycled pid — a
// second build took a lock that was held, and a live unpack's stage was
// swept.
import { assert, assertEquals } from "@std/assert";
import {
  holderAlive,
  ownIdTail,
  tokenTag,
  withTag,
} from "../src/server/pid-lock.ts";
import {
  isLockOwnerAlive,
  ownerIdentity,
} from "../src/server/single-instance-lock.ts";
import { sleeper } from "./proc-helper.ts";

const FILETIME = "134360879030934133"; // measured on Windows 11

Deno.test("start tag: a Windows creation time survives the round trip exactly", () => {
  const tag = tokenTag(FILETIME);
  assert(/^c[0-9a-f]+$/.test(tag), tag);
  assertEquals(withTag(7, tag), { pid: 7, startToken: FILETIME });
});

Deno.test("start tag: Linux ticks keep the tag older builds read", () => {
  assertEquals(tokenTag("1234567"), "a12d687");
  assertEquals(withTag(7, "a12d687"), { pid: 7, startToken: "1234567" });
  assertEquals(withTag(7, "d0000002aa12d687"), {
    pid: 7,
    startToken: "1234567",
    ns: 42,
  });
  assertEquals(withTag(7, "e6ab3c1f9"), { pid: 7, startEpoch: 0x6ab3c1f9 });
});

Deno.test("start tag: an older build's rounded Windows stamp is no stamp — the pid decides", () => {
  const rounded = `a${Number(FILETIME).toString(16)}`; // what 1.0.19 wrote
  assertEquals(withTag(7, rounded), { pid: 7 });
});

Deno.test("start tag: this process's own tag names this process", () => {
  const id = withTag(Deno.pid, ownIdTail());
  const own = ownerIdentity(Deno.pid);
  assertEquals(id.startToken, own.startToken);
  assertEquals(id.startEpoch, own.startEpoch);
});

Deno.test("start tag: a live child's stamp, written and read back, says alive", async () => {
  const child = sleeper();
  try {
    const own = ownerIdentity(child.pid);
    const tail = own.startToken
      ? tokenTag(own.startToken)
      : own.startEpoch !== undefined
      ? `e${own.startEpoch.toString(16)}`
      : "";
    const id = withTag(child.pid, tail);
    assert(isLockOwnerAlive(id), JSON.stringify(id));
    assert(holderAlive(id, false), JSON.stringify(id));
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
});

Deno.test({
  name:
    "start identity: Windows names a process by its creation time — another start under its pid is not the owner",
  ignore: Deno.build.os !== "windows", // GetProcessTimes; Linux reads /proc, macOS `ps` (tests/lock-identity-print.test.ts)
  async fn() {
    const child = sleeper();
    try {
      const { startToken } = ownerIdentity(child.pid);
      assert(startToken && /^\d{17,19}$/.test(startToken), String(startToken));
      assert(isLockOwnerAlive({ pid: child.pid, startToken }));
      const other = (BigInt(startToken) - 10_000_000n).toString(); // 1 s earlier
      assert(!isLockOwnerAlive({ pid: child.pid, startToken: other }));
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  },
});
