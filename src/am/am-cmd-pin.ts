/**
 * @module
 * `am pin` — which aio version this app uses, and how to change it.
 *
 *   am pin                  what this app is pinned to, what it's actually
 *                           linked to, and which versions are available
 *   am pin v1.0.0-alpha38   pin that version: provision it, relink, record it
 *   am pin main             follow the branch tip (explicitly a moving target)
 *   am pin latest           pin the newest release (`--latest` is the same)
 *   am pin <path>           LOCAL-DEV pin: follow a framework checkout on this
 *                           machine (`am pin /opt/aio-checkout`) — for
 *                           developing an app against a WIP framework
 *
 * The pin is one string in the app's `deno.json` (`"aioVersion"`), committed with
 * the code — so `git clone && am fix && deno task dev` builds the app against
 * the framework it was written for, on any machine, a year later. See
 * src/am/am-versions.ts for why worktrees and why no version ranges.
 */

import type { GlobalFlags } from "./am-types.ts";
import {
  block,
  count,
  detectMode,
  fold,
  hints,
  kv,
  out,
  outError,
  stack,
} from "./am-output.ts";
import { resolveAioRoot, withoutAioFlag } from "./am-cmd-link.ts";
import { join, relative, resolve } from "@std/path";
import {
  compareVersions,
  currentLink,
  ensureVersion,
  knownTags,
  LATEST,
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
import { DENO_JSON_NAMES, LOCAL_PIN_FILE } from "../server/deno-json.ts";
import {
  isPathPin,
  linkSatisfiesPin,
  PATH_PIN_PREFIX,
  pathPinTarget,
} from "./am-versions.ts";
import {
  isFixturePath,
  type RemovalHit,
  removalMessage,
  removalsInDenoJson,
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
  const linked = info.linkedPath
    ? (info.linkedRef ?? info.linkedPath)
    : "nothing yet";
  // The RANGE is over orderable releases only, and `sortVersions` returns
  // parsed Semvers rather than the tags — so map back to `raw`. `main-<sha>`
  // has no position, and pairing it with a release was never a range.
  const avail = sortVersions(info.available).map((v) => v.raw);
  const loose = info.available.length - avail.length;
  const facts = kv([
    {
      label: "aio",
      value: info.pinned ?? "unpinned",
      tone: info.pinned ? "ok" : "warn",
    },
    { label: "linked", value: linked, tone: info.drift ? "warn" : undefined },
    { label: "latest", value: info.latest },
    {
      label: "provisioned",
      // A count and a range, never the 34-item, 1200-character line this used
      // to print — the question is "have I got enough of them here", and a
      // list of every tag answers it worse than a number does.
      value: info.available.length === 0
        ? "none"
        : String(info.available.length),
      note: avail.length > 1
        ? `${avail.at(-1)} … ${avail[0]}${
          loose ? ` +${loose} unversioned` : ""
        }`
        : avail[0] ?? undefined,
    },
    { label: "releases", value: tags.length ? fold(tags, 4) : null },
  ]);

  // Warnings come BEFORE the reference facts: a reader who has a problem is
  // reading to find it, and it was last on the page.
  const warnings = [
    info.drift &&
    block(
      "warn",
      "Drift — this app is built against something it did not ask for.",
      `deno.json pins ${info.pinned}; dep/aio points at ${
        info.linkedRef ?? info.linkedPath
      }.`,
      "am fix",
    ),
    !info.pinned &&
    block(
      "warn",
      "This app is not pinned.",
      "A clone of this repo builds against whatever aio happens to be " +
        "installed on that machine, which is how the same source produces two " +
        "different apps.",
      "am pin latest",
    ),
    !info.linkedPath && info.pinned &&
    block(
      "warn",
      "Nothing is linked.",
      "The pin is recorded but dep/aio does not exist yet, so nothing builds.",
      "am fix",
    ),
    // A pin is a promise, not a prison: the app keeps building exactly as it
    // is, and it should still be able to see how far the world has moved.
    info.behind !== null && info.behind > 0 &&
    block(
      "info",
      `${count(info.behind, "release")} behind ${info.latest}.`,
      "This app keeps building as pinned — nothing changes until you move it.",
      "am pin latest",
    ),
  ].filter((b): b is string => typeof b === "string");

  return stack(
    facts,
    ...warnings,
    hints([
      ["am pin latest", "the newest release in this app's major"],
      ["am pin <version>", "switch this app (provisions + relinks)"],
      ["am pin main", "follow the branch tip (a moving target)"],
      ["am pin <path>", "follow a framework checkout on this machine"],
    ]),
  );
}

/** What `am pin`'s arguments ask for: the newest release, or an explicit ref.
 *
 *  `latest` is a WORD, the sibling of `main`. Every other target of this
 *  command is one — `am pin main`, `am pin v1.0.0-alpha73`, `am pin
 *  /opt/aio-checkout` — so "the newest release" was the only one that demanded
 *  a flag, and the spelling a user reaches for first (`am pin latest`, by
 *  analogy with the line right above it in the help) failed with
 *  `aio version "latest" not found`, listing the very releases it was asking
 *  for. `--latest` keeps working: it is in shipped docs and in every upgrade
 *  guide, and there is no reason to break it.
 *
 *  The word cannot shadow a real ref: `latestTag()` resolves over PARSEABLE
 *  versions only, so a git tag literally named `latest` is not reachable as a
 *  pin target through any path — `main` is the spelling for a moving ref.
 *
 *  `--aio <path>` carries its value as a SEPARATE argument, and that value is
 *  a path, never the ref this scan is looking for — hence `withoutAioFlag`.
 *
 *  Pure, so one test pins both spellings to the same act. */
export function pinTarget(
  args: string[],
): { wantLatest: boolean; explicit: string | undefined } {
  const positional = withoutAioFlag(args).find((a) => !a.startsWith("--"));
  return {
    wantLatest: args.includes("--latest") || positional === LATEST,
    explicit: positional === LATEST ? undefined : positional,
  };
}

/** One reason a target version would break this app. */
export interface Blocker {
  where: string; // file:line, relative to the app
  hit: RemovalHit;
  /** True when the file is a test/fixture path (`isFixturePath`): the old
   *  spelling is a fixture, so the move WARNS and proceeds instead of
   *  refusing — a real config key on a real path still refuses. */
  fixture: boolean;
}

/** One blocker, as every surface prints it: file:line, the QUOTED line that
 *  matched, then the removal message. */
export function blockerLines(b: Blocker): string {
  return `  ${b.where}\n    | ${b.hit.text}\n    ${
    removalMessage(b.hit.removal)
  }`;
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
  // deno.json first: a removed top-level key (`target`) is a config fact the
  // source walk below cannot see.
  try {
    const djPath = join(appDir, "deno.json");
    const raw = await Deno.readTextFile(djPath);
    const dj = JSON.parse(raw) as Record<string, unknown>;
    for (const removal of removalsInDenoJson(dj)) {
      if (stillAccepts(ref, removal.lastGood)) continue;
      const line = raw.split("\n").findIndex((l) =>
        new RegExp(`"${removal.key}"\\s*:`).test(l)
      );
      blocking.push({
        where: `deno.json:${line + 1}`,
        hit: {
          removal,
          line: line + 1,
          text: (raw.split("\n")[line] ?? "").trim(),
        },
        fixture: false,
      });
    }
  } catch {
    // no deno.json, or not JSON — the normal flow reports that properly
  }
  for await (const file of appSources(appDir)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    // Every source file: a removed API shape (a type alias, an argument
    // order) lives anywhere, not only beside a `cell(` call.
    for (const hit of removalsInSource(text)) {
      if (stillAccepts(ref, hit.removal.lastGood)) continue;
      const rel = relative(appDir, file);
      blocking.push({
        where: `${rel}:${hit.line}`,
        hit,
        fixture: isFixturePath(rel),
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
      "Can't locate the aio install.",
      mode,
      "am fix   (or pass --aio <path>)",
    );
    Deno.exit(1);
  }

  // BOTH names Deno accepts — `DENO_JSON_NAMES` is the decider, and a `.jsonc`
  // app was told it was not an aio app at all.
  let hasConfig = false;
  for (const name of DENO_JSON_NAMES) {
    try {
      await Deno.stat(`${appDir}/${name}`);
      hasConfig = true;
      break;
    } catch { /* try the other name */ }
  }
  if (!hasConfig) {
    outError(
      `No ${DENO_JSON_NAMES.join(" or ")} in ${appDir}.\n` +
        `am pin reads and writes an app's pin, so it has to run inside one.`,
      mode,
      "cd <your app>   ·   am create <name>",
    );
    Deno.exit(1);
  }

  const { wantLatest, explicit } = pinTarget(args);
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
  // A PATH argument is a LOCAL-DEV pin: `am pin /opt/aio-checkout` (or a
  // relative path) records `path:<abs>` in aioVersion, so every later `am fix`
  // keeps linking THIS checkout — the recorded form of `am link --aio=<path>`,
  // for developing an app against a work-in-progress framework. It is
  // machine-specific by nature; ensureVersion fails LOUDLY on a machine where
  // the path does not exist, and `am pin latest` returns to a release.
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
      `⚠ local-dev pin — this machine only: recorded in ${LOCAL_PIN_FILE} ` +
        `(git-ignored), deno.json untouched. Return to a release with ` +
        `"am pin latest".`,
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
          : `no releases in the ${major}.x line. \`am pin latest --major\` ` +
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
  // `--force` is a GLOBAL flag now (am-utils parses it), so it never reaches
  // the positional list. Reading both spellings keeps a script that passed it
  // positionally working, and keeps this from silently ignoring it — which is
  // what happened the moment the flag moved.
  if (!args.includes("--force") && !flags.force) {
    const found = await preflight(appDir, ref);
    const blocking = found.filter((b) => !b.fixture);
    const fixtures = found.filter((b) => b.fixture);
    // A removed spelling on a TEST/FIXTURE path is the app's own upgrade
    // test or self-test feeding the old shape on purpose — said, with the
    // line, never refused. Always stderr: the pin proceeds and this must not
    // vanish into a JSON payload nobody reads.
    if (fixtures.length) {
      console.error(
        `⚠ ${fixtures.length} removed API(s) on test/fixture paths — ` +
          `${ref} no longer runs them; pinning anyway:\n` +
          fixtures.map(blockerLines).join("\n"),
      );
    }
    if (blocking.length) {
      outError(
        `${ref} would break this app — ${blocking.length} removed API(s) ` +
          `still in use:\n${blocking.map(blockerLines).join("\n")}\n` +
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
  const wrote = await writePin(appDir, res.ref);
  // The other half of the pin: align the framework-owned dep entries in the
  // app's map with what THIS version declares (see syncFrameworkDeps).
  //
  // The pin is ALREADY WRITTEN by the time this runs, so a throw here used to
  // surface as an unhandled `SyntaxError` from `JSON.parse` — on a deno.jsonc
  // with a comment in it, which Deno itself accepts — leaving an app pinned,
  // linked, and told nothing except a stack trace. The pin stands; say what
  // did not happen and how to finish it.
  let deps: Awaited<ReturnType<typeof syncFrameworkDeps>> = [];
  try {
    deps = await syncFrameworkDeps(appDir, res.path);
  } catch (e) {
    outError(
      `pinned to aio ${res.ref} (dep/aio → ${res.path}), but the framework ` +
        `dependency entries could NOT be synced: ${
          e instanceof Error ? e.message : String(e)
        }\n` +
        `  The pin itself is written. Fix the app config so it parses, then ` +
        `re-run \`am pin ${res.ref}\` to finish the sync.`,
      mode,
    );
    Deno.exit(1);
  }
  const minDeno = await pinnedMinDeno(res.path);

  out(
    mode === "pretty"
      ? `pinned to aio ${res.ref}${
        res.ref === ref ? "" : `  (resolved from "${ref}")`
      }\n` +
        `  dep/aio → ${res.path}${res.created ? "  (provisioned)" : ""}\n` +
        (wrote.file === "deno.json"
          ? `  deno.json aioVersion: ${res.ref}\n` +
            (wrote.removedLocal
              ? `  removed ${LOCAL_PIN_FILE} (local path override) — this release now wins\n`
              : "")
          : `  ${wrote.file}: ${
            pathPinTarget(res.ref)
          }  (git-ignored, this machine only; deno.json untouched)\n`) +
        deps.map((d) =>
          `  dep synced: ${d.key} ${d.from ?? "(none)"} → ${d.to}\n`
        ).join("") +
        (minDeno ? `  requires Deno ≥ ${minDeno}\n` : "") +
        (ref === MAIN
          ? `  NOTE: pinned to that exact commit. Re-run \`am pin main\` to advance.\n`
          : "") +
        (wrote.file === "deno.json"
          ? `  commit deno.json so a clone builds against the same version`
          : `  commit nothing — \`am pin latest\` returns to a release`)
      : {
        pinned: res.ref,
        requested: ref,
        recordedIn: wrote.file,
        path: res.path,
        provisioned: res.created,
        depsSynced: deps,
        minDeno,
      },
    mode,
  );
}
