// scripts/preflight.ts — the final pass before you publish.
//
//   deno task preflight
//
// Verifies, entirely LOCALLY (no JSR, no publish), that:
//   1. the installer scripts are valid,
//   2. the package is publishable (`deno publish --dry-run`),
//   3. the whole `am` experience works — install `am` as a REAL global command
//      straight from this source, `am create` a fresh app, and confirm it
//      type-checks, its starter test passes, and it compiles to a binary.
//
// Run this before `deno publish`: if it's green, the published version will
// install and scaffold correctly. Self-cleaning; exits non-zero on any failure.

import { fromFileUrl } from "@std/path";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/\/$/, "");
const AM = "am-preflight"; // temp global name — won't clobber a real `am`
const BIN = `${
  Deno.env.get("DENO_INSTALL_ROOT") ?? `${Deno.env.get("HOME")}/.deno`
}/bin/${AM}`;

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  grn: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function sh(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await p.output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

/** A failed step throws with a short reason (its tail of output). */
function fail(reason: string): never {
  throw new Error(reason);
}
const tail = (s: string, n = 12) => s.trim().split("\n").slice(-n).join("\n");

let appDir = "";

const steps: { name: string; run: () => Promise<string> }[] = [
  {
    name: "installer scripts are valid",
    run: async () => {
      const ssh = await sh("sh", ["-n", `${REPO}/install.sh`]);
      if (ssh.code !== 0) fail(`install.sh syntax: ${tail(ssh.err)}`);
      try {
        await Deno.stat(`${REPO}/install.ps1`);
      } catch {
        fail("install.ps1 is missing");
      }
      return "install.sh sh -n ok · install.ps1 present";
    },
  },
  {
    name: "package is publishable (deno publish --dry-run)",
    run: async () => {
      // --allow-dirty: we validate the PACKAGE, not the working tree (dev tree
      // is expected to have uncommitted work). Warnings are fine; only a
      // non-zero exit (real publish error / slow types) fails.
      const r = await sh(
        "deno",
        ["publish", "--dry-run", "--allow-dirty"],
        REPO,
      );
      if (r.code !== 0) {
        fail(`publish dry-run failed:\n${tail(r.err || r.out)}`);
      }
      return "dry-run clean (warnings ok)";
    },
  },
  {
    name: "am installs as a global command (from source)",
    run: async () => {
      const r = await sh("deno", [
        "install",
        "-gAfr",
        "-n",
        AM,
        "--config",
        `${REPO}/deno.json`,
        `${REPO}/src/am.ts`,
      ]);
      if (r.code !== 0) fail(`deno install: ${tail(r.err)}`);
      const v = await sh(BIN, ["version", "--json"]);
      if (v.code !== 0) fail(`${AM} version: ${tail(v.err)}`);
      const version =
        (JSON.parse(v.out.trim() || "{}") as { version?: string }).version;
      if (!version) fail(`no version from ${AM} (got: ${v.out.trim()})`);
      return `installed → ${AM} version = ${version}`;
    },
  },
  {
    name: "am create scaffolds a runnable app",
    run: async () => {
      const parent = await Deno.makeTempDir({ prefix: "preflight-" });
      const r = await sh(
        BIN,
        ["create", "app", `--mirror=${REPO}`, "--json"],
        parent,
      );
      if (r.code !== 0) fail(`am create: ${tail(r.err || r.out)}`);
      appDir = `${parent}/app`;
      const want = [
        "deno.json",
        "src/app.ts",
        "src/cell.ts",
        "src/App.tsx",
        "src/cell.test.ts",
      ];
      for (const f of want) {
        try {
          await Deno.stat(`${appDir}/${f}`);
        } catch {
          fail(`scaffold missing ${f}`);
        }
      }
      return `created ${want.length} files`;
    },
  },
  {
    name: "scaffolded app type-checks (deno task dev would boot)",
    run: async () => {
      const r = await sh("deno", [
        "check",
        "src/app.ts",
        "src/App.tsx",
        "src/cell.test.ts",
      ], appDir);
      if (r.code !== 0) fail(`deno check:\n${tail(r.err)}`);
      return "types clean";
    },
  },
  {
    name: "starter test passes (deno task test)",
    run: async () => {
      const r = await sh("deno", ["test", "-A", "src/cell.test.ts"], appDir);
      if (r.code !== 0) fail(`starter test:\n${tail(r.err || r.out)}`);
      return "green out of the box";
    },
  },
  {
    name: "app compiles to a binary (deno task compile)",
    run: async () => {
      const r = await sh("deno", ["task", "compile"], appDir);
      if (r.code !== 0) fail(`deno task compile:\n${tail(r.err || r.out)}`);
      const hasBin = [...Deno.readDirSync(appDir)].some((e) =>
        e.isFile && !e.name.includes(".")
      );
      if (!hasBin) fail("no binary produced");
      return "binary built";
    },
  },
];

async function cleanup() {
  await sh("deno", ["uninstall", "-g", AM]).catch(() => {});
  if (appDir) {
    await Deno.remove(appDir.replace(/\/app$/, ""), { recursive: true }).catch(
      () => {},
    );
  }
}

console.log(c.b("\n▶ aio preflight — publishability + am/curl onboarding\n"));
let ok = true;
try {
  for (const [i, step] of steps.entries()) {
    const t0 = performance.now();
    Deno.stdout.writeSync(
      new TextEncoder().encode(
        `  ${c.dim(`${i + 1}/${steps.length}`)} ${step.name} … `,
      ),
    );
    try {
      const detail = await step.run();
      const ms = (performance.now() - t0).toFixed(0);
      console.log(`${c.grn("✓")} ${c.dim(`${detail} (${ms}ms)`)}`);
    } catch (e) {
      console.log(c.red("✗"));
      console.log(c.red(`\n    ${(e as Error).message}\n`));
      ok = false;
      break; // fail-fast: later steps depend on earlier ones
    }
  }
} finally {
  await cleanup();
}

/** Source-first: `curl | sh` clones GitHub <branch> and runs `am` from the
 *  clone — so what makes your changes reach users is `git push`, NOT a JSR
 *  publish. Say what's still local (the exact trap behind "preflight green but
 *  curl broken": curl was cloning an older pushed state). */
async function pushNote(): Promise<void> {
  try {
    const branch =
      (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], REPO)).out.trim();
    const dirty =
      (await sh("git", ["status", "--porcelain"], REPO)).out.trim().length > 0;
    // The EXIT CODE matters as much as the output. `git rev-list
    // origin/<branch>..HEAD` exits 128 with empty stdout when the branch does
    // not exist on origin — and an empty string then read as "0 commits
    // ahead", so preflight printed its green "`curl | sh` clones exactly this"
    // for a branch `curl | sh` cannot clone at all. That false green is the
    // exact trap this check exists to prevent. Same for a detached HEAD.
    const revList = await sh(
      "git",
      ["rev-list", "--count", `origin/${branch}..HEAD`],
      REPO,
    );
    const ahead = revList.out.trim();
    const pending: string[] = [];
    if (revList.code !== 0 || !/^\d+$/.test(ahead)) {
      pending.push(
        branch === "HEAD"
          ? "detached HEAD (no branch to clone)"
          : `no origin/${branch} — this branch has never been pushed`,
      );
    } else if (ahead !== "0") pending.push(`${ahead} unpushed commit(s)`);
    if (dirty) pending.push("uncommitted changes");
    if (pending.length) {
      console.log(c.red(c.b(`  ⚠ ${pending.join(" + ")}`)));
      console.log(
        c.dim(
          `    \`curl | sh\` clones origin/${branch} — commit + push to make these live.`,
        ),
      );
    } else {
      console.log(
        c.grn(
          `  ✓ origin/${branch} is up to date — \`curl | sh\` clones exactly this.`,
        ),
      );
    }
  } catch {
    console.log(c.dim("  (couldn't check git push status)"));
  }
}

if (ok) {
  console.log(
    c.grn(c.b("\n✓ preflight passed")) +
      c.dim(" — the am experience works from source.\n"),
  );
  await pushNote();
  console.log(
    c.dim(
      "\n  curl | sh clones GitHub → installs am from the clone. No JSR, no publish.\n",
    ),
  );
  Deno.exit(0);
}
console.log(
  c.red(c.b("\n✗ preflight failed — fix the step above before publishing.\n")),
);
Deno.exit(1);
