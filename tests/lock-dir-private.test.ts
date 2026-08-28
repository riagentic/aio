// The lock directory holds every running app's CONTROL SOCKET, and whoever
// connects to one of those can dispatch methods into that app. So the rule for
// it is the rule `mintControlKey` already applied to the control key: a
// private thing is never placed in a directory that cannot keep it.
//
// `lockDir()` had only half of it. It chmod'ed 0700 and swallowed the failure
// — and chmod on a directory you do not own returns EPERM, so a `/tmp/aio`
// somebody else created (0777, or 0700 as themselves) was used exactly as if
// the chmod had worked. On a host with no `$XDG_RUNTIME_DIR` — containers,
// no-systemd boxes, plain ssh — that is a predictable path any local account
// can pre-create.
//
// The ownership half cannot be exercised without a second uid, so the RULE is
// tested as the pure function it is, and the plumbing is tested through a
// preferred directory that is unusable for a reason a test can create.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { privateDirRefusal } from "../src/server/dir-permissions.ts";
import { _prepareLockDir } from "../src/server/single-instance-lock.ts";

const POSIX = Deno.build.os !== "windows";

Deno.test("the rule: owner-only, and OURS", () => {
  const D = "/d";
  assertEquals(privateDirRefusal(D, 0o40700, 1000, 1000), null, "ours, 0700");
  // Group or other can reach it — anyone local walks in.
  assertStringIncludes(privateDirRefusal(D, 0o40777, 1000, 1000)!, "mode 777");
  assertStringIncludes(privateDirRefusal(D, 0o40750, 1000, 1000)!, "mode 750");
  assertStringIncludes(privateDirRefusal(D, 0o40701, 1000, 1000)!, "mode 701");
  // 0700 but SOMEBODY ELSE'S: we cannot narrow it and cannot write in it.
  // This is the case the old chmod-and-hope could not distinguish from success.
  assertStringIncludes(
    privateDirRefusal(D, 0o40700, 1001, 1000)!,
    "owned by uid 1001",
  );
  // Windows: no POSIX bits to read, and the profile ACLs are the boundary.
  assertEquals(privateDirRefusal(D, null, null, null), null);
  // Cannot tell whose it is → must not refuse. A check that cannot tell is
  // not evidence of a problem.
  assertEquals(privateDirRefusal(D, 0o40700, 1001, null), null);
  assertEquals(privateDirRefusal(D, 0o40700, null, 1000), null);
});

Deno.test({
  name: "an unusable lock dir falls back to one we own, loudly",
  ignore: !POSIX,
  fn: async () => {
    const base = await Deno.makeTempDir({ prefix: "aio-lockdir-" });
    try {
      // Unusable for a reason a test can actually create: the preferred path
      // exists and is not a directory. The production case is "another uid
      // owns it", which needs a second account; both reach the same branch.
      await Deno.writeTextFile(`${base}/aio`, "not a directory");
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `import { lockDir } from "${
            new URL("../src/server/single-instance-lock.ts", import.meta.url)
              .href
          }";
           const d = lockDir();
           console.log("DIR=" + d);
           console.log("MODE=" + (Deno.statSync(d).mode! & 0o777).toString(8));`,
        ],
        // AIO_APPS_DIR scopes the directory NAME (`aio-<slug>`), and the
        // suite sets it. Blank it so the preferred path is plain `<base>/aio`.
        env: { XDG_RUNTIME_DIR: base, AIO_APPS_DIR: "" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assertEquals(code, 0, out + err);
      // It did NOT use the unusable path…
      assertStringIncludes(out, "DIR=");
      const dir = /DIR=(.*)/.exec(out)![1]!.trim();
      assertEquals(
        dir.endsWith("/aio"),
        false,
        `used the unusable path: ${dir}`,
      );
      // …it used a uid-scoped sibling, and narrowed it.
      assertStringIncludes(dir, "/aio-u");
      assertStringIncludes(out, "MODE=700");
      // And it SAID so — a control socket moving is not a silent detail.
      assertStringIncludes(err + out, "not a directory");
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name: "the ordinary case still uses the shared directory",
  ignore: !POSIX,
  fn: async () => {
    // The fallback must be the exception: one directory per machine is what
    // lets `am` see every app of this user.
    const base = await Deno.makeTempDir({ prefix: "aio-lockdir-ok-" });
    try {
      const { code, stdout } = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `import { lockDir } from "${
            new URL("../src/server/single-instance-lock.ts", import.meta.url)
              .href
          }";
           const d = lockDir();
           console.log("DIR=" + d + " MODE=" +
             (Deno.statSync(d).mode! & 0o777).toString(8));`,
        ],
        // AIO_APPS_DIR scopes the directory NAME (`aio-<slug>`), and the
        // suite sets it. Blank it so the preferred path is plain `<base>/aio`.
        env: { XDG_RUNTIME_DIR: base, AIO_APPS_DIR: "" },
        stdout: "piped",
        stderr: "null",
      }).output();
      const out = new TextDecoder().decode(stdout);
      assertEquals(code, 0, out);
      assertStringIncludes(out, `DIR=${base}/aio MODE=700`);
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name: "a directory we cannot narrow is refused, not used",
  ignore: !POSIX,
  fn: async () => {
    // THE production case: `/tmp/aio` already exists, owned by another local
    // account, mode 0777. `mkdir -p` succeeds, `chmod` returns EPERM, and the
    // old code swallowed that and bound a control socket in there anyway.
    // A test has one uid, so the EPERM is injected — same branch, same reason.
    const base = await Deno.makeTempDir({ prefix: "aio-lockdir-eperm-" });
    try {
      const dir = `${base}/aio`;
      Deno.mkdirSync(dir);
      Deno.chmodSync(dir, 0o777);
      const refusal = _prepareLockDir(dir, {
        chmod: () => {
          throw new Deno.errors.PermissionDenied("chmod: EPERM");
        },
      });
      assertStringIncludes(
        refusal ?? "",
        "mode 777",
        "a directory that stayed world-traversable was accepted",
      );
      // And with a chmod that works, the same directory is fine — the refusal
      // is about the mode that RESULTS, not about the chmod having thrown.
      assertEquals(_prepareLockDir(dir), null);
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});
