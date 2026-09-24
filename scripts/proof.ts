// The physical-proof matrix: which targets have been proven on REAL hardware,
// when, and at which commit.
//
// The beta gate names five things this machine cannot answer — a real Windows
// pass, a real macOS pass, a real Android device, the 72-hour soak, and an
// off-box remote run (todo.md, "Facts this side cannot change"). Every one is
// behind an opt-in env gate, every one is `ignored (0ms)` in a normal suite,
// and until now nothing recorded whether any of them had EVER run. "We tested
// Windows" was a memory, and a memory is what the docs-vs-gates work in this
// release keeps finding to be wrong.
//
// So the ledger is WRITTEN BY THE GATES, never by hand. A hand-kept matrix is
// a claim; a generated one is evidence. `recordProof` is called by the gated
// test itself, on success, with the commit it ran against — the same principle
// as "read the artifact, not the source tree", applied to proof.
import { dirname, resolve } from "@std/path";

const FILE = resolve(
  new URL("../", import.meta.url).pathname,
  "proof-matrix.json",
);

/** One proven run. `detail` is free text the gate chose (a version, a device). */
export type ProofEntry = {
  target: string;
  env: string;
  commit: string;
  date: string;
  detail?: string;
};

/** Every physical claim the beta gate makes, and the gate that can prove it.
 *  An entry here with no proof is the honest state: "not yet run". */
export const CLAIMS: {
  target: string;
  env: string;
  how: string;
  /** Is there a GATE that writes this row on success? `false` means the claim
   *  has no mechanism at all — nobody can prove it without building one, which
   *  is worth seeing beside the ones that merely have not been run yet. */
  auto: boolean;
}[] = [
  {
    target: "windows",
    env: "wine",
    how: "AIO_WINE_E2E=1 deno task test:wine",
    auto: true,
  },
  // These two say `lab`, not `real`, because that is what their gate checks:
  // `am lab windows` boots the VM and its viewer and artifact share answer.
  // A row reading "windows (real) ✓" for that would claim an APP had run on
  // Windows — broader than the evidence, which is the one mistake this file
  // exists to prevent. The app-level claims are the two below, and they are
  // honest about having no gate.
  {
    target: "windows",
    env: "lab-vm",
    how: "AIO_VM_LAB=1 — a real Windows VM boots; its viewer + share answer",
    auto: true,
  },
  {
    target: "macos",
    env: "lab-vm",
    how: "AIO_VM_LAB=macos — a real Mac's artifact share is serving",
    auto: true,
  },
  {
    target: "windows",
    env: "app-on-real",
    how: "NO GATE — 1.0.3/1.0.4 were fixed by launching the artifact on the " +
      "Windows VM BY HAND (double-click, then read the DOM over --cdp). " +
      "Nothing automates that, so nothing can write this row",
    auto: false,
  },
  {
    target: "macos",
    env: "app-on-real",
    how: "NO GATE — same: driven by hand over ssh (app.log + lsappinfo, no " +
      "screencapture). A killed Gatekeeper-held launch poisons that copy",
    auto: false,
  },
  {
    target: "windows",
    env: "exe-doors",
    how:
      "NO GATE — the packaged app's doors (CSP <meta> in the shell, no TCP " +
      "listen socket, the snapshot route off) are asserted by test:hosts on " +
      "the LINUX packaged Electron only. Nothing runs them against the " +
      "Windows exe",
    auto: false,
  },
  { target: "soak", env: "72h", how: "deno task soak:72h", auto: true },
  {
    target: "android",
    env: "emulator",
    how: "deno task test:android (the SDK + an AVD; boots it headless)",
    auto: true,
  },
  {
    target: "android",
    env: "device",
    how:
      "NO GATE — am lab android proves the CLI against a fake adb, not a phone",
    auto: false,
  },
  {
    target: "remote",
    env: "off-box",
    how: "NO GATE — needs a second machine",
    auto: false,
  },
  // The two surfaces a release ships on EVERY time and the matrix never named,
  // so it read as a list of exotica rather than as the physical record. Both
  // already run as release gates; they simply were not writing their row.
  {
    target: "cli",
    env: "binary",
    how: "deno task test:build — a compiled cli-client talks to a compiled " +
      "server, both from a foreign cwd",
    auto: true,
  },
  {
    target: "web",
    env: "real-browser",
    how: "deno task test:e2e — real Chromium: surface → trigger → server " +
      "state converges",
    auto: true,
  },
];

async function load(): Promise<ProofEntry[]> {
  try {
    return JSON.parse(await Deno.readTextFile(FILE)) as ProofEntry[];
  } catch {
    return [];
  }
}

async function shortCommit(): Promise<string> {
  try {
    const r = await new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: dirname(FILE),
      stdout: "piped",
      stderr: "null",
    }).output();
    return new TextDecoder().decode(r.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Record that `target` was proven in `env`. Called BY the gated test, on
 *  success — so the ledger cannot claim a run that did not happen. */
export async function recordProof(
  target: string,
  env: string,
  detail?: string,
): Promise<void> {
  const entries = (await load()).filter((e) =>
    !(e.target === target && e.env === env)
  );
  entries.push({
    target,
    env,
    commit: await shortCommit(),
    date: new Date().toISOString().slice(0, 10),
    detail,
  });
  entries.sort((a, b) => (a.target + a.env).localeCompare(b.target + b.env));
  await Deno.writeTextFile(FILE, JSON.stringify(entries, null, 2) + "\n");
}

function ageDays(iso: string, now = Date.now()): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

/** A row older than this is stale. */
export const STALE_DAYS = 90;

/** What one proven row is worth today. Pure — the caller answers whether the
 *  row's commit still exists.
 *
 *  `gone`: the commit the gate ran against is not in this repository any more
 *  (a history rewrite, a squash, a clone without it). The row still says a
 *  gate passed, but nobody can name the code it passed on — which is exactly
 *  the "a memory, not evidence" state this file exists to end, so it prints
 *  as stale, never as ✓, however recent its date. */
export function rowStatus(
  entry: Pick<ProofEntry, "date" | "commit">,
  commitExists: boolean,
  now = Date.now(),
): { state: "ok" | "old" | "gone"; age: number } {
  const age = ageDays(entry.date, now);
  if (!commitExists) return { state: "gone", age };
  return { state: age > STALE_DAYS ? "old" : "ok", age };
}

/** Is `commit` in the TAGGED history of the repo `proof-matrix.json` lives
 *  in — a commit object that some tag contains? Existing is not enough: an
 *  amended draft of a release commit still sits in the object store, on no
 *  ref, and a row naming it printed ✓ for code no release ever shipped. No
 *  git at all counts as unknown and answers true: a tarball checkout cannot
 *  judge, and must not call every row stale for it. */
export function commitExists(commit: string, cwd = dirname(FILE)): boolean {
  try {
    const run = (args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd,
        stdout: "piped",
        stderr: "null",
      }).outputSync();
    const git = (args: string[]) => run(args).success;
    if (!git(["rev-parse", "--git-dir"])) return true;
    if (!git(["cat-file", "-e", `${commit}^{commit}`])) return false;
    const tags = run(["tag", "--contains", commit]);
    return tags.success && tags.stdout.length > 0;
  } catch {
    return true; // aio-ok: no git binary — cannot judge (see above)
  }
}

if (import.meta.main) {
  const entries = await load();
  const require = Deno.args.includes("--require");
  const missing: string[] = [];
  const stale: string[] = [];
  const noGate: string[] = [];

  console.log("\nphysical proof matrix\n");
  for (const c of CLAIMS) {
    const hit = entries.find((e) => e.target === c.target && e.env === c.env);
    const label = `${c.target} (${c.env})`.padEnd(22);
    if (!hit) {
      console.log(
        `  ${c.auto ? "✗" : "·"} ${label} ${
          c.auto ? "never run" : "no gate  "
        } — ${c.how}`,
      );
      if (c.auto) missing.push(label.trim());
      else noGate.push(label.trim());
      continue;
    }
    const { state, age } = rowStatus(hit, commitExists(hit.commit));
    if (state !== "ok") stale.push(label.trim());
    const why = state === "gone"
      ? "  STALE: commit in no tagged history — the proven code cannot be named"
      : state === "old"
      ? `  STALE: ${age}d old`
      : "";
    console.log(
      `  ${
        state === "ok" ? "✓" : "!"
      } ${label} ${hit.date} @${hit.commit}${why}${
        hit.detail ? `  ${hit.detail}` : ""
      }`,
    );
  }
  console.log(
    `\n  ${
      CLAIMS.length - missing.length - stale.length - noGate.length
    }/${CLAIMS.length} proven` +
      (missing.length ? ` · ${missing.length} never run` : "") +
      (stale.length
        ? ` · ${stale.length} stale (older than ${STALE_DAYS}d, or commit gone)`
        : "") +
      (noGate.length ? ` · ${noGate.length} with NO GATE to prove them` : ""),
  );
  console.log(
    "  a gate writes its own row on success — this file is evidence, not a claim\n",
  );
  // Only `--require` fails, because a release cut on Linux cannot be blocked by
  // a Mac it does not have. Beta is where --require belongs.
  if (require && (missing.length || stale.length)) Deno.exit(1);
}
