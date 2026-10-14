// Without `--allow-sys` there is no uid — and a wide lock dir still starts
// the app, as it did on 1.0.19.
//
// The one-look rule chmods a wide directory only when it is provably OURS,
// and proof is a uid. A process that cannot read its own (`selfUid()` null:
// no `--allow-sys`) therefore narrowed nothing, refused a `<base>/aio` left
// 0755 by an older build, and had no `aio-u<uid>` to fall back to: an app
// that started on 1.0.19 (measured: chmod to 0700, chosen) threw at boot.
//
// Now a real directory — never a link, which a chmod FOLLOWS — is narrowed
// without the proof: the chmod fails on somebody else's, and what it left is
// looked at again and must be the entry that was judged.
//
// A real process without the permission: no seam stands in for `Deno.uid`.
import { assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href;

const PROBE = `const m = await import(${JSON.stringify(MOD)});
const root = Deno.args[0];
const mode = (p) => (Deno.statSync(p).mode & 0o777).toString(8);
const say = (f) => { try { return f(); } catch (e) { return "THROWS " + e.message; } };
let uid = "none";
try { uid = String(Deno.uid()); } catch { /* not granted */ }
const out = { uid };
// A wide directory at the preferred name: narrowed, and chosen.
const base = root + "/base";
Deno.mkdirSync(base + "/aio", { recursive: true });
Deno.chmodSync(base + "/aio", 0o755);
out.chosen = say(() => m._chooseLockDir(base, "") === base + "/aio");
// aio-ok(umask): every mode read here was SET by a chmod (0755 above, 0700 by the code under test), which no umask changes — and the test runs under permissiveUmask besides.
out.mode = mode(base + "/aio");
// A LINK to a wide directory: the chmod would follow it — never made.
const victim = root + "/victim";
Deno.mkdirSync(victim);
Deno.chmodSync(victim, 0o755);
Deno.symlinkSync(victim, root + "/link");
let chmods = 0;
out.link = m._prepareLockDir(root + "/link", { chmod: () => void chmods++ });
out.linkChmods = chmods;
// aio-ok(umask): set by the chmod above; the question is whether it CHANGED.
out.victim = mode(victim);
// Another entry at the name after the chmod: not the one that was judged.
const swap = root + "/swap";
Deno.mkdirSync(swap);
Deno.chmodSync(swap, 0o755);
out.swap = m._prepareLockDir(swap, {
  chmod: (p, to) => {
    Deno.chmodSync(p, to);
    Deno.removeSync(p);
    Deno.mkdirSync(p, { mode: 0o700 });
  },
});
// A chmod that fails (somebody else's directory): refused by its mode.
const theirs = root + "/theirs";
Deno.mkdirSync(theirs);
Deno.chmodSync(theirs, 0o755);
out.theirs = m._prepareLockDir(theirs, {
  chmod: () => { throw new Deno.errors.PermissionDenied("EPERM"); },
});
console.log("RESULT " + JSON.stringify(out));
`;

Deno.test({
  name:
    "lock dir: with no uid (no --allow-sys) a wide directory is narrowed and used; a link is not chmodded; a swapped entry is refused",
  ignore: Deno.build.os === "windows", // no POSIX mode to narrow, and no uid with or without the permission
  fn: () =>
    permissiveUmask(async () => {
      const root = await tempDir("lock-dir-no-uid-");
      try {
        const probe = join(root, "probe.js");
        await Deno.writeTextFile(probe, PROBE);
        const work = join(root, "w");
        await Deno.mkdir(work);
        const r = await new Deno.Command(Deno.execPath(), {
          // Everything the module needs but `--allow-sys`.
          args: [
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-ffi",
            "--allow-run",
            "--allow-net",
            "--config",
            join(REPO, "deno.json"),
            probe,
            work,
          ],
          env: { AIO_APPS_DIR: join(root, "apps") },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
        const dec = new TextDecoder();
        const line = dec.decode(r.stdout).trim().split("\n").pop() ?? "";
        if (!r.success || !line.startsWith("RESULT ")) {
          throw new Error(`probe failed: ${line}\n${dec.decode(r.stderr)}`);
        }
        const at = (p: string) => join(work, p);
        assertEquals(JSON.parse(line.slice(7)), {
          uid: "none",
          chosen: true,
          mode: "700",
          link: `${at("link")} is mode 755 (not owner-only)`,
          linkChmods: 0,
          victim: "755",
          swap: `${at("swap")} was replaced while it was being checked`,
          theirs: `${at("theirs")} is mode 755 (not owner-only)`,
        });
      } finally {
        await dropTempDir(root);
      }
    }),
});
