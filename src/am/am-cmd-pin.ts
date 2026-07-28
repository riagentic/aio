/**
 * @module
 * `am pin` — which aio version this app uses, and how to change it.
 *
 *   am pin                  what this app is pinned to, what it's actually
 *                           linked to, and which versions are available
 *   am pin v1.0.0-alpha38   pin that version: provision it, relink, record it
 *   am pin main             follow the branch tip (explicitly a moving target)
 *   am pin --latest         pin the newest release
 *
 * The pin is one string in the app's `deno.json` (`"aioVersion"`), committed with
 * the code — so `git clone && am fix && deno task dev` builds the app against
 * the framework it was written for, on any machine, a year later. See
 * src/am/am-versions.ts for why worktrees and why no version ranges.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { resolveAioRoot } from "./am-cmd-link.ts";
import {
  currentLink,
  ensureVersion,
  knownTags,
  latestTag,
  linkTo,
  MAIN,
  parseVersion,
  pinnedMinDeno,
  provisioned,
  readPin,
  refOfLink,
  syncFrameworkDeps,
  versionPath,
  writePin,
} from "./am-versions.ts";

export type PinInfo = {
  /** What deno.json asks for (null = unpinned, i.e. "whatever is installed"). */
  pinned: string | null;
  /** What `dep/aio` actually points at, if anything. */
  linkedPath: string | null;
  /** The version that path represents, when it is a provisioned one. */
  linkedRef: string | null;
  /** True when the app is linked to something other than its pin. */
  drift: boolean;
  available: string[];
  latest: string | null;
};

/** Read the app's pin, its link, and what's available — no side effects. */
export async function pinInfo(appDir: string, root: string): Promise<PinInfo> {
  const pinned = await readPin(appDir);
  const linkedPath = await currentLink(appDir);
  const linkedRef = linkedPath ? refOfLink(linkedPath) : null;
  return {
    pinned,
    linkedPath,
    linkedRef,
    // Unpinned apps can't drift — there is nothing to disagree with.
    drift: pinned !== null && linkedPath !== null && linkedRef !== pinned,
    available: await provisioned(),
    latest: await latestTag(root),
  };
}

function render(info: PinInfo, tags: string[]): string {
  const lines: string[] = [];
  lines.push(`aio version: ${info.pinned ?? "(unpinned)"}`);
  if (info.linkedPath) {
    lines.push(`  linked to: ${info.linkedRef ?? info.linkedPath}`);
  } else {
    lines.push(`  linked to: (nothing — run \`am fix\`)`);
  }
  if (info.drift) {
    lines.push(
      `  ⚠ DRIFT — this app asks for ${info.pinned} but is built against ` +
        `${info.linkedRef ?? info.linkedPath}. \`am fix\` corrects it.`,
    );
  }
  if (!info.pinned) {
    lines.push(
      `  ⚠ UNPINNED — a clone of this repo builds against whatever aio is ` +
        `installed. Pin it: \`am pin --latest\``,
    );
  }
  lines.push("");
  lines.push(`  provisioned: ${info.available.join(", ") || "(none)"}`);
  const shown = tags.slice(0, 6);
  lines.push(
    `  releases:    ${shown.join(", ")}${
      tags.length > shown.length ? ", …" : ""
    }`,
  );
  lines.push(`  latest:      ${info.latest ?? "(none)"}`);
  lines.push("");
  lines.push(`  am pin <version>   switch this app (provisions + relinks)`);
  lines.push(`  am pin main        follow the branch tip (moving target)`);
  return lines.join("\n");
}

export async function cmdPin(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const appDir = Deno.cwd();
  const root = resolveAioRoot(args);
  if (!root) {
    outError(
      "can't locate the aio install — reinstall via install.sh or pass --aio=<path>",
      mode,
    );
    Deno.exit(1);
  }

  try {
    await Deno.stat(`${appDir}/deno.json`);
  } catch {
    outError(`no deno.json in ${appDir} — run this inside an aio app`, mode);
    Deno.exit(1);
  }

  const wantLatest = args.includes("--latest");
  const explicit = args.find((a) => !a.startsWith("--"));
  const pinned = await readPin(appDir);

  // No target → report only. Never changes anything, so it is safe to run
  // anywhere (CI included) just to see where an app stands.
  if (!explicit && !wantLatest) {
    const info = await pinInfo(appDir, root);
    out(mode === "pretty" ? render(info, await knownTags(root)) : info, mode);
    if (info.drift) Deno.exit(1); // scriptable: drift is a failure
    return;
  }

  let ref = explicit ?? "";
  if (wantLatest) {
    // "Latest" means latest WITHIN THE APP'S MAJOR. Crossing a major is a
    // breaking upgrade and has to be asked for — a command called `--latest`
    // must never hand a 1.x app a 2.0 checkout. This is the rule that lets the
    // scheme survive aio's own majors.
    const crossMajor = args.includes("--major");
    const current = pinned ? parseVersion(pinned) : null;
    const major = crossMajor || !current ? undefined : current.major;
    const l = await latestTag(root, { major });
    if (!l) {
      outError(
        major === undefined
          ? `no release tags found in ${root} — use \`am pin main\``
          : `no releases in the ${major}.x line. \`am pin --latest --major\` ` +
            `crosses to the newest major (a BREAKING upgrade — read the upgrade guide).`,
        mode,
      );
      Deno.exit(1);
    }
    ref = l;
    if (
      current && parseVersion(l)?.major !== current.major && mode === "pretty"
    ) {
      console.error(
        `⚠ crossing a major: ${pinned} → ${l}. Read ` +
          `docs/upgrade/ before shipping this.`,
      );
    }
  }

  const res = await ensureVersion(root, ref);
  if (!res.ok) {
    outError(res.error, mode);
    Deno.exit(1);
  }
  try {
    await linkTo(appDir, res.path);
  } catch (e) {
    outError(e instanceof Error ? e.message : String(e), mode);
    Deno.exit(1);
  }
  // Record the RESOLVED ref, not what was typed: `am pin main` commits
  // `main-<sha>`, so the pin in the repo is always exact and a clone reproduces
  // the same tree. "Follow main" stays an action you re-run, never a stored
  // state that can change the framework under an app behind its back.
  await writePin(appDir, res.ref);
  // The other half of the pin: align the framework-owned dep entries in the
  // app's map with what THIS version declares (see syncFrameworkDeps).
  const deps = await syncFrameworkDeps(appDir, res.path);
  const minDeno = await pinnedMinDeno(res.path);

  out(
    mode === "pretty"
      ? `pinned to aio ${res.ref}${
        res.ref === ref ? "" : `  (resolved from "${ref}")`
      }\n` +
        `  dep/aio → ${versionPath(res.ref)}${
          res.created ? "  (provisioned)" : ""
        }\n` +
        `  deno.json aioVersion: ${res.ref}\n` +
        deps.map((d) =>
          `  dep synced: ${d.key} ${d.from ?? "(none)"} → ${d.to}\n`
        ).join("") +
        (minDeno ? `  requires Deno ≥ ${minDeno}\n` : "") +
        (ref === MAIN
          ? `  NOTE: pinned to that exact commit. Re-run \`am pin main\` to advance.\n`
          : "") +
        `  commit deno.json so a clone builds against the same version`
      : {
        pinned: res.ref,
        requested: ref,
        path: res.path,
        provisioned: res.created,
        depsSynced: deps,
        minDeno,
      },
    mode,
  );
}
