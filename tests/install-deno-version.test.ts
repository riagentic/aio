// The reported bug, as a test that can fail here — no container needed.
//
//   "I tried the one-line onboarding installer and it failed — didn't upgrade
//    deno. Even when I upgraded deno myself, the app failed and didn't build,
//    didn't start. Just horrible experience."
//
// The first half of that was one line in `install.sh`:
//
//   if command -v deno >/dev/null 2>&1; then ok "deno $(deno --version)"
//
// Any deno passed. A box with 2.1 got a green checkmark and then failed later,
// somewhere else, describing something else — the worst shape a defect can
// take, because nothing connects the symptom to the cause.
//
// These tests drive the REAL script with a FAKE deno on PATH, so the version
// gate is exercised without downloading anything and without a container. The
// Docker lab (`deno task lab`) proves the whole path on a fresh machine; this
// proves the decision that path depends on, on every `deno task test` run.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { MIN_DENO } from "../src/server/deno-version.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** A sandbox with a fake `deno` of the given version first on PATH, a fake
 *  `git` that refuses to reach the network, and a HOME of its own. */
async function sandbox(denoVersion: string | null): Promise<{
  dir: string;
  env: Record<string, string>;
  bin: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-install-gate-" });
  const bin = join(dir, "bin");
  await Deno.mkdir(bin, { recursive: true });

  if (denoVersion) {
    // Prints exactly what `deno --version` prints, and REFUSES to upgrade —
    // the apt/snap/brew case, where the binary is not the user's to rewrite.
    await Deno.writeTextFile(
      join(bin, "deno"),
      `#!/bin/sh
case "$1" in
  --version) echo "deno ${denoVersion} (release, x86_64-unknown-linux-gnu)"; echo "v8 12.0.0"; echo "typescript 5.6.2" ;;
  upgrade)   echo "error: You do not have write permission to /usr/bin/deno" >&2; exit 1 ;;
  install)   echo "fake deno install: $*" ;;
  *)         echo "fake deno: $*" ;;
esac
`,
    );
    await Deno.chmod(join(bin, "deno"), 0o755);
  }
  return {
    dir,
    bin,
    env: {
      HOME: dir,
      PATH: `${bin}:/usr/bin:/bin`,
      AIO_HOME: join(dir, "aio"),
      AIO_REPO: REPO, // clone from THIS checkout — no network, real git
      DENO_INSTALL: join(dir, ".deno"),
    },
  };
}

async function runInstall(
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const p = await new Deno.Command("sh", {
    args: [join(REPO, "install.sh")],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout) +
      new TextDecoder().decode(p.stderr),
  };
}

Deno.test({
  name: "install.sh: an OLD deno is never accepted as 'ok'",
  // The clone step needs git; everything else is fake.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { dir, env } = await sandbox("2.1.4");
    try {
      const r = await runInstall(env);
      // It may upgrade (can't here — the fake refuses) or refuse. What it must
      // NEVER do is print a cheerful "✓ deno 2.1.4" and carry on.
      assertEquals(
        /✓ deno 2\.1\.4/.test(r.out),
        false,
        `install.sh accepted deno 2.1.4 as fine. This is the reported bug — ` +
          `output was:\n${r.out}`,
      );
      assert(
        /older than/.test(r.out) || /upgrad/i.test(r.out),
        `install.sh said nothing about the version being too old:\n${r.out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "install.sh: when it cannot upgrade, it FAILS with the exact commands",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { dir, env } = await sandbox("2.1.4");
    try {
      // No network in this sandbox for deno.land, so the private install also
      // fails — the end state a locked-down machine really reaches.
      const r = await runInstall({ ...env, DENO_LAB_NO_NETWORK: "1" });
      if (r.code === 0) {
        // It managed to install a private deno (this box has network) — then
        // the requirement is that the result is genuinely new enough.
        assert(
          !/✓ deno 2\.1\.4/.test(r.out),
          "exited 0 while still on the old deno",
        );
        return;
      }
      assertStringIncludes(r.out, MIN_DENO);
      assert(
        /deno upgrade|deno\.land\/install\.sh/.test(r.out),
        `the refusal must name the command that fixes it:\n${r.out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "install.sh: the required version comes from the framework, not a copy",
  fn: async () => {
    // The number lives in ONE place (`src/server/deno-version.ts`). A shell
    // script with its own copy is a second decider that goes stale the first
    // time the minimum moves — and nobody notices, because both are "right".
    const sh = await Deno.readTextFile(join(REPO, "install.sh"));
    assertStringIncludes(sh, "src/server/deno-version.ts");
    const hardcoded = [...sh.matchAll(/MIN_DENO="?([0-9]+\.[0-9]+\.[0-9]+)/g)]
      .map((m) => m[1]!);
    for (const v of hardcoded) {
      assertEquals(
        v,
        MIN_DENO,
        `install.sh carries the literal ${v} while the framework requires ` +
          `${MIN_DENO} — the fallback must be regenerated with the source`,
      );
    }
  },
});

Deno.test({
  name: "run.sh: refuses to build on a deno the framework cannot use",
  fn: async () => {
    // run.sh used to ask `command -v deno` and nothing else, so an old deno
    // reached the BUILD, which failed with a syntax/API error that pointed
    // anywhere but at the version.
    const sh = await Deno.readTextFile(join(REPO, "run.sh"));
    assertStringIncludes(sh, "deno-version.ts");
    assert(
      /deno_ok/.test(sh),
      "run.sh must compare the deno version, not just its existence",
    );
  },
});

Deno.test({
  name: "install.sh: checks git AND curl before it needs them",
  fn: async () => {
    const sh = await Deno.readTextFile(join(REPO, "install.sh"));
    const preflight = sh.slice(0, sh.indexOf("Clone / update aio"));
    for (const tool of ["git", "curl"]) {
      assertStringIncludes(
        preflight,
        tool,
        `${tool} must be checked up front — discovering it is missing inside ` +
          `another script's output is the failure mode we are fixing`,
      );
    }
  },
});

// ── what the sandbox install found once the version gate was fixed ───────

Deno.test({
  name: "install.sh: `am` runs even when deno is NOT on PATH",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // `deno install` writes a shim whose body is `exec deno run …` — deno BY
    // NAME. So the tool it just installed works only where deno is already on
    // PATH, and when it isn't the user types `am` and gets
    // `am: 3: exec: deno: not found`: a message about deno, from a script they
    // did not write. This is the second half of the reported "horrible
    // experience", and it is invisible on a machine that already had deno.
    const { dir, env } = await sandbox(null);
    try {
      const r = await runInstall(env);
      assertEquals(r.code, 0, `install.sh failed:\n${r.out}`);
      const am = join(dir, ".deno", "bin", "am");
      const shim = await Deno.readTextFile(am);
      assert(
        !/^exec deno /m.test(shim),
        `the am shim still execs bare "deno":\n${shim}`,
      );
      // …and prove it, with a PATH that has no deno at all.
      const p = await new Deno.Command(am, {
        args: ["version"],
        env: { HOME: dir, PATH: "/usr/bin:/bin" },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(p.stdout) +
        new TextDecoder().decode(p.stderr);
      assertEquals(p.code, 0, `am could not run without deno on PATH:\n${out}`);
      assertStringIncludes(out, "version");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "install.sh: a NEW shell can find am (PATH is persisted, not suggested)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // The old script printed "add it to PATH: …" and exited 0 — so the
    // one-liner's promise ("run this, then use am") was false for anyone who
    // opened a new terminal, which is everyone.
    const { dir, env } = await sandbox(null);
    try {
      const r = await runInstall(env);
      assertEquals(r.code, 0, `install.sh failed:\n${r.out}`);
      const profile = await Deno.readTextFile(join(dir, ".profile")).catch(
        () => "",
      );
      assertStringIncludes(
        profile,
        ".deno/bin",
        "install.sh must WRITE the PATH line, not print it",
      );
      const p = await new Deno.Command("sh", {
        args: ["-lc", "command -v am && am version"],
        env: { HOME: dir, PATH: "/usr/bin:/bin" },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(p.stdout) +
        new TextDecoder().decode(p.stderr);
      assertEquals(p.code, 0, `a fresh login shell cannot run am:\n${out}`);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "install.sh: verifies am with a spelling every RELEASE understands",
  fn: async () => {
    // The installer is fetched from the BRANCH; the framework it installs is
    // the last TAG. Verifying with `am --version` — added on the branch —
    // made the published one-liner fail against the release it had just
    // installed. Whatever the installer calls has to exist in the OLD tag.
    const sh = Deno.readTextFileSync(join(REPO, "install.sh"));
    const body = sh.replace(/^\s*#.*$/gm, ""); // comments may discuss it
    assertEquals(
      /\bam --version\b/.test(body),
      false,
      "install.sh must verify with `am version`: the installer runs from the " +
        "branch and installs the last tag, so a newer spelling breaks the " +
        "published one-liner",
    );
    assert(
      /\bversion\b/.test(body),
      "it must still verify the version somehow",
    );
  },
});

Deno.test({
  name: "install.sh: a fresh macOS/zsh account gets a file zsh actually READS",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // macOS has defaulted to zsh since Catalina and ships NO ~/.zshrc, so the
    // old "only touch it if it exists" rule skipped every zsh file and wrote
    // only ~/.profile — which a login zsh never reads (/etc/zprofile →
    // ~/.zprofile → ~/.zshrc). The installer then verified with `sh -lc`,
    // which DOES read ~/.profile, so it reported "am works in a new shell
    // too" while the user's next Terminal had no `am`: a check passing in a
    // shell the user does not use.
    //
    // persist_path is extracted and run in a sandbox HOME — the decision is
    // what is under test, not the download.
    const sh = await Deno.readTextFile(join(REPO, "install.sh"));
    const fn = sh.match(/^persist_path\(\) \{[\s\S]*?^\}/m)?.[0];
    assert(fn, "persist_path() not found — did it move?");

    const run = async (env: Record<string, string>, home: string) => {
      const p = await new Deno.Command("sh", {
        args: ["-c", `${fn}\npersist_path`],
        env: { ...env, HOME: home, PATH: "/usr/bin:/bin" },
        clearEnv: true,
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(
        p.code,
        0,
        new TextDecoder().decode(p.stderr) || "persist_path failed",
      );
    };
    const read = (f: string) => Deno.readTextFile(f).catch(() => "");

    // 1. A fresh mac: zsh login shell, no rc files at all.
    const mac = await Deno.makeTempDir({ prefix: "persist-mac-" });
    // 2. A linux box with bash: must NOT grow zsh files it has no shell for.
    const linux = await Deno.makeTempDir({ prefix: "persist-linux-" });
    try {
      await run({ SHELL: "/bin/zsh" }, mac);
      assertStringIncludes(
        await read(join(mac, ".zprofile")),
        ".deno/bin",
        "a zsh login shell reads ~/.zprofile — it must be written even when " +
          "absent, which is the normal state of a fresh macOS account",
      );
      assertStringIncludes(
        await read(join(mac, ".profile")),
        ".deno/bin",
        "…and ~/.profile stays, for sh/bash",
      );

      await run({ SHELL: "/bin/bash" }, linux);
      assertStringIncludes(await read(join(linux, ".profile")), ".deno/bin");
      if (Deno.build.os !== "darwin") {
        assertEquals(
          await read(join(linux, ".zprofile")),
          "",
          "a bash machine must not sprout zsh files it will never read",
        );
      }
    } finally {
      await Deno.remove(mac, { recursive: true }).catch(() => {});
      await Deno.remove(linux, { recursive: true }).catch(() => {});
    }
  },
});
