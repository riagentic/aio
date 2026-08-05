/**
 * @module
 * `am pin` — which aio version this app uses, and how to change it.
 *
 *   am pin                  what this app is pinned to, what it's actually
 *                           linked to, and which versions are available
 *   am pin v1.0.0-alpha38   pin that version: provision it, relink, record it
 *   am pin main             follow the branch tip (explicitly a moving target)
 *   am pin --latest         pin the newest release
 *   am pin <path>           LOCAL-DEV pin: follow a framework checkout on this
 *                           machine (`am pin /home/dev/code/gen/aio`) — for
 *                           developing an app against a WIP framework
 *
 * The pin is one string in the app's `deno.json` (`"aioVersion"`), committed with
 * the code — so `git clone && am fix && deno task dev` builds the app against
 * the framework it was written for, on any machine, a year later. See
 * src/am/am-versions.ts for why worktrees and why no version ranges.
 */

import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { resolveAioRoot } from "./am-cmd-link.ts";
import { join, relative, resolve } from "@std/path";
import {
  compareVersions,
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
  sortVersions,
  syncFrameworkDeps,
  writePin,
} from "./am-versions.ts";
import {
  isPathPin,
  linkSatisfiesPin,
  PATH_PIN_PREFIX,
  pathPinTarget,
} from "./am-versions.ts";
import {
  type RemovalHit,
  removalMessage,
  removalsInSource,
} from "../state/removals.ts";

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
  /** Releases between the pin and `latest` (0 = current). null when the pin is
   *  not an orderable release (unpinned, `main-<sha>`, a path pin) — those are
   *  deliberate choices, not staleness. */
  behind: number | null;
};

/** Read the app's pin, its link, and what's available — no side effects. */
export async function pinInfo(appDir: string, root: string): Promise<PinInfo> {
  const pinned = await readPin(appDir);
  const linkedPath = await currentLink(appDir);
  const linkedRef = linkedPath
    ? (pinned && linkSatisfiesPin(pinned, linkedPath)
      ? pinned // includes a path pin: dep/aio → the checkout it names
      : refOfLink(linkedPath))
    : null;
  const tags = sortVersions(await knownTags(root));
  const cur = pinned ? parseVersion(pinned) : null;
  return {
    pinned,
    linkedPath,
    linkedRef,
    behind: cur ? tags.filter((t) => compareVersions(t, cur) > 0).length : null,
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
  if (info.behind !== null && info.behind > 0) {
    // A pin is a promise, not a prison: the app keeps building exactly as it
    // is, and it should still be able to see how far the world has moved.
    lines.push(
      `  ⓘ ${info.behind} release(s) behind ${info.latest} — this app keeps ` +
        `building as pinned. \`am pin --latest\` moves it (checked first).`,
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

/** One reason a target version would break this app. */
interface Blocker {
  where: string; // file:line, relative to the app
  hit: RemovalHit;
}

/** Does `ref` still accept an API whose last supporting release was `lastGood`?
 *  A ref we cannot order (`main`, `main-<sha>`, a path pin) is the tip by
 *  definition — treat it as newer, never as "probably fine". */
function stillAccepts(ref: string, lastGood: string): boolean {
  const target = parseVersion(ref);
  const good = parseVersion(lastGood);
  if (!good) return true; // an unorderable row cannot block anything
  if (!target) return false; // main / path pin — ahead of every release
  return compareVersions(target, good) <= 0;
}

/** Walk the app's own sources — never the framework, deps, or build output. */
async function* appSources(dir: string): AsyncGenerator<string> {
  const SKIP = new Set([
    "dep",
    "node_modules",
    "dist",
    ".git",
    "coverage",
    "build",
  ]);
  const walk = async function* (d: string): AsyncGenerator<string> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...await Array.fromAsync(Deno.readDir(d))];
    } catch {
      return; // unreadable dir — not this command's problem to report
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory) yield* walk(p);
      else if (/\.tsx?$/.test(e.name)) yield p;
    }
  };
  yield* walk(dir);
}

/**
 * What would break if this app moved to `ref`.
 *
 * Reads the app's source through the removal registry — the same detector the
 * linter uses — and keeps only the hits the TARGET version no longer accepts.
 * Moving backward to a version that still runs an old spelling is therefore
 * silent, which is the point: the check exists to stop a forward move from
 * being a surprise, not to nag.
 */
export async function preflight(
  appDir: string,
  ref: string,
): Promise<Blocker[]> {
  const blocking: Blocker[] = [];
  for await (const file of appSources(appDir)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    if (!text.includes("cell(")) continue; // config keys live in cell() calls
    for (const hit of removalsInSource(text)) {
      if (stillAccepts(ref, hit.removal.lastGood)) continue;
      blocking.push({
        where: `${relative(appDir, file)}:${hit.line}`,
        hit,
      });
    }
  }
  return blocking;
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
  // A PATH argument is a LOCAL-DEV pin: `am pin /home/dev/code/gen/aio` (or a
  // relative path) records `path:<abs>` in aioVersion, so every later `am fix`
  // keeps linking THIS checkout — the recorded form of `am link --aio=<path>`,
  // for developing an app against a work-in-progress framework. It is
  // machine-specific by nature; ensureVersion fails LOUDLY on a machine where
  // the path does not exist, and `am pin --latest` returns to a release.
  if (
    ref !== "" &&
    (isPathPin(ref) || ref.startsWith("/") || ref.startsWith("./") ||
      ref.startsWith("../") || ref === ".")
  ) {
    const target = resolve(
      Deno.cwd(),
      isPathPin(ref) ? pathPinTarget(ref) : ref,
    );
    ref = PATH_PIN_PREFIX + target;
    // Always on stderr, every mode — the trade-off must be impossible to miss.
    console.error(
      `⚠ local-dev pin — machine-specific: committing it pins every clone ` +
        `to ${target}. Return to a release with "am pin --latest".`,
    );
  }
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

  // PREFLIGHT — the ladder. Moving a pin FORWARD is allowed to be work; it is
  // never allowed to be a surprise. Before the pin changes, read the app's own
  // source for spellings the target version no longer accepts, and say so with
  // file:line. Silence here would mean the app builds, ships, and dies at boot
  // on a framework the tool just told it was fine.
  if (!args.includes("--force")) {
    const blocking = await preflight(appDir, ref);
    if (blocking.length) {
      const lines = blocking.map((b) =>
        `  ${b.where}\n    ${removalMessage(b.hit.removal)}`
      );
      outError(
        `${ref} would break this app — ${blocking.length} removed API(s) ` +
          `still in use:\n${lines.join("\n")}\n` +
          `  Migrate them, pin a version that still runs them, or re-run with ` +
          `--force to pin anyway.`,
        mode,
      );
      Deno.exit(1);
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
        `  dep/aio → ${res.path}${res.created ? "  (provisioned)" : ""}\n` +
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
