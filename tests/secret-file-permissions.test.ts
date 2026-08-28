// A credential this framework writes must never, at any instant, be readable
// by another account on the machine. Two things decide that, and only one of
// them is the file: `$HOME` is 0755 on most distros, so a 0600 key inside a
// 0755 directory is fine while a 0644 key inside a 0700 directory is also
// fine — but the directory is what survives someone later dropping a log, a
// backup or a temp file beside it. `ensureAppDirs` already says this about the
// tree; `app-key.ts` made the key's own home itself, at the umask, because it
// runs before `aio.run` has built anything when `am` or a test calls it.
//
// Three spellings of "write a secret" lived in that one file: create then
// chmod (a window at the umask), create-then-chmod inside the SAME try (a
// chmod failure swallowed with the write, leaving 0644 and saying nothing),
// and create with `{ mode: 0o600 }` after removing any existing file — which
// is the only one that is right.
import { assertEquals } from "@std/assert";
import {
  appKeyPath,
  controlKeyPath,
  mintControlKey,
  resolveAppKey,
} from "../src/server/app-key.ts";
import { _resetAppDirs } from "../src/server/app-dirs.ts";

const POSIX = Deno.build.os !== "windows";
const dirOf = (p: string) => p.replace(/[/\\][^/\\]+$/, "");
const mode = (p: string) => (Deno.statSync(p).mode! & 0o777).toString(8);

/** Run `fn` against a throwaway HOME so nothing touches the real one. */
async function inFreshHome(fn: () => void | Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "aio-secret-perm-" });
  const prev = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  _resetAppDirs();
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prev);
    _resetAppDirs();
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test({
  name: "app key: the key is 0600 and its home is 0700",
  ignore: !POSIX,
  fn: () =>
    inFreshHome(() => {
      // `key: true` — generated and persisted.
      resolveAppKey("permapp", true);
      const p = appKeyPath("permapp");
      assertEquals(mode(p), "600", "the app key is readable by other accounts");
      // The directory is the half that was wrong: 0755, because this path
      // made it rather than going through ensureAppDirs.
      assertEquals(mode(dirOf(p)), "700", "the key's home is world-readable");
    }),
});

Deno.test({
  name: "app key: a FIXED key is mirrored with the same care",
  ignore: !POSIX,
  fn: () =>
    inFreshHome(() => {
      resolveAppKey("permapp2", "a-fixed-shared-key");
      const p = appKeyPath("permapp2");
      assertEquals(mode(p), "600");
      assertEquals(mode(dirOf(p)), "700");
    }),
});

Deno.test({
  name: "app key: a file an older version left at 0644 is narrowed, not kept",
  ignore: !POSIX,
  fn: () =>
    inFreshHome(() => {
      const p = appKeyPath("permapp3");
      Deno.mkdirSync(dirOf(p), { recursive: true });
      Deno.writeTextFileSync(p, "left-behind");
      Deno.chmodSync(p, 0o644);
      // `mode` applies at CREATE time only — a plain rewrite would keep 0644.
      resolveAppKey("permapp3", "a-fixed-shared-key");
      assertEquals(mode(p), "600", "the stale wide mode survived the rewrite");
    }),
});

Deno.test({
  name: "control key: same guarantee, and it always had it",
  ignore: !POSIX,
  fn: () =>
    inFreshHome(() => {
      const r = mintControlKey("permapp4");
      assertEquals(r.error, undefined, r.error);
      const p = controlKeyPath("permapp4");
      assertEquals(mode(p), "600");
      assertEquals(mode(dirOf(p)), "700");
    }),
});

Deno.test("app-key.ts writes every secret through the one helper", () => {
  // Structural, not behavioural, and deliberately so: the tests above stat the
  // file AFTER the write, so they cannot see the window a chmod-afterwards
  // leaves open — the mode they observe is 0600 either way. A time-of-check
  // gap is not observable by checking. What IS checkable is that exactly one
  // call site creates these files, and that it creates them narrow.
  const src = Deno.readTextFileSync("src/server/app-key.ts");
  const direct = [...src.matchAll(/Deno\.writeTextFileSync\s*\(/g)].length;
  assertEquals(
    direct,
    1,
    "a secret is written outside writeSecretFileSync again — that call " +
      "creates the file at the umask, and a chmod afterwards is a window",
  );
  const helper = src.slice(src.indexOf("function writeSecretFileSync"));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  assertEquals(
    /Deno\.writeTextFileSync\([^)]*\{[^}]*mode:\s*0o600/.test(body),
    true,
    "the file is no longer CREATED at 0600 — a chmod afterwards leaves a " +
      "window in which it exists at the umask, and a credential read during " +
      "that window is read for good",
  );
  assertEquals(
    body.indexOf("Deno.removeSync") < body.indexOf("Deno.writeTextFileSync"),
    true,
    "`mode` applies at CREATE time only, so the remove has to come first — " +
      "otherwise a file an older version left at 0644 keeps its 0644",
  );
});
