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
  {
    target: "windows",
    env: "real",
    how: "AIO_VM_LAB=1 (a real Windows VM/host)",
    auto: true,
  },
  {
    target: "macos",
    env: "real",
    how: "AIO_VM_LAB=macos (a real Mac)",
    auto: true,
  },
  { target: "soak", env: "72h", how: "deno task soak:72h", auto: true },
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

function ageDays(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

if (import.meta.main) {
  const entries = await load();
  const require = Deno.args.includes("--require");
  const STALE_DAYS = 90;
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
    const age = ageDays(hit.date);
    const mark = age > STALE_DAYS ? "!" : "✓";
    if (age > STALE_DAYS) stale.push(label.trim());
    console.log(
      `  ${mark} ${label} ${hit.date} @${hit.commit}${
        age > STALE_DAYS ? `  (${age}d old)` : ""
      }${hit.detail ? `  ${hit.detail}` : ""}`,
    );
  }
  console.log(
    `\n  ${entries.length}/${CLAIMS.length} proven` +
      (missing.length ? ` · ${missing.length} never run` : "") +
      (stale.length ? ` · ${stale.length} older than ${STALE_DAYS}d` : "") +
      (noGate.length ? ` · ${noGate.length} with NO GATE to prove them` : ""),
  );
  console.log(
    "  a gate writes its own row on success — this file is evidence, not a claim\n",
  );
  // Only `--require` fails, because a release cut on Linux cannot be blocked by
  // a Mac it does not have. Beta is where --require belongs.
  if (require && (missing.length || stale.length)) Deno.exit(1);
}
