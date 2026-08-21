// updates-core.ts — the pure half of app updates: config resolution, channel
// precedence, version comparison, and the DATA-COMPATIBILITY gate.
//
// Everything here is a total function over plain data, so the rules that decide
// whether a user is offered an update are unit-testable without a network, a
// filesystem, or a running app. The IO half lives in updates-check.ts.
//
// The load-bearing rule, from which most of this file follows: an update is
// only ever OFFERED when the user's data survives it. A release that cannot
// migrate the data on disk is not a smaller update — it is not an update at
// all, and it is surfaced as information instead.
import type {
  CellContract,
  DataContract,
  ShipManifest,
  UpdateTarget,
} from "../build/ship.ts";

// ── config ──────────────────────────────────────────────────────────────────

/** What an app writes in `aio.run({ updates })`.
 *
 *  The string shorthand is the intended shape for almost every app: one URL,
 *  everything else defaulted. The object form exists for the three decisions a
 *  default cannot make for you. */
export type UpdatesInput = string | UpdatesConfig;

/** Where updates come from. The mechanism differs; nothing above it does.
 *
 *  - `"manifest"` — a location holding signed `aio ship` artifacts. The strong
 *    form: authenticity, a data contract, and a binary that is already built.
 *  - `"git"` — a repository is the source of truth. This is how apps installed
 *    by the one-line `run.sh` runner already work, so it is the same principle
 *    with the same shape: a new commit on the followed ref is a new version.
 *    Applying one rebuilds from source instead of downloading a binary. */
export type UpdateSourceKind = "manifest" | "git";

/** The full form. Every field but `source` is optional and has a defensible
 *  default — this is deliberately a handful of switches, not a subsystem. */
export type UpdatesConfig = {
  /** Where the new version comes from — agnostic by design:
   *  - `https://releases.example.com/wallet` — published artifacts
   *  - `file:///mnt/releases/wallet` — a share, a volume, a USB stick
   *  - `https://github.com/you/app` — the repository itself
   *
   *  `<channel>` is interpreted by the source: a directory under a manifest
   *  source, a branch or tag under a git source. */
  source: string;
  /** Override the inferred source kind. Inference is refused rather than
   *  guessed when a URL could plausibly be either. */
  kind?: UpdateSourceKind;
  /** `false` (default) — never install without being told: the app shows its
   *  own dialog, or an interactive terminal asks y/n.
   *  `true` — detect, install and restart unattended. For services with no one
   *  to ask. Still refuses anything that fails verification or the data gate. */
  auto?: boolean;
  /** `true` (default) poll on the channel's schedule · `false` never poll,
   *  `check()` only · a number sets the interval in ms. */
  check?: boolean | number;
  /** Override the channel this install follows. Default: the channel stamped
   *  into the artifact at build time. */
  channel?: string;
  /** The trusted signing key. Omitted ⇒ trust-on-first-use: the first verified
   *  manifest's key is pinned, loudly, and every later release must match it. */
  key?: JsonWebKey;
  /** Install unsigned releases (a private LAN build). Says so at every step. */
  allowUnsigned?: boolean;
};

/** Config after defaults are applied — what the runtime actually uses. */
export type ResolvedUpdates = {
  source: string;
  kind: UpdateSourceKind;
  channel: string;
  /** 0 = never poll (manual `check()` only). */
  intervalMs: number;
  auto: boolean;
  key?: JsonWebKey;
  allowUnsigned: boolean;
};

/** Poll intervals by channel.
 *
 *  A one-minute poll is right where you are iterating and wrong where users
 *  live: on a production install it is 1440 requests a day, on someone else's
 *  machine and bandwidth, for something that changes weekly. Checks are
 *  conditional (ETag), so an unchanged manifest costs a 304 and no body — but
 *  the request still happens, so the interval still matters. */
export const CHANNEL_INTERVAL_MS: Record<string, number> = {
  dev: 60_000, // 1m — you are shipping into it right now
  test: 300_000, // 5m — a tester wants the build promptly
  prod: 21_600_000, // 6h — users, not developers
};

/** Interval for a channel; unknown channel names get the prod cadence, because
 *  a custom channel is far more likely to be a release channel than a dev one. */
export function defaultInterval(channel: string): number {
  return CHANNEL_INTERVAL_MS[channel] ?? CHANNEL_INTERVAL_MS.prod!;
}

/** Where the channel default comes from, most specific first.
 *
 *  The artifact's own STAMP is the default rather than a constant, and that is
 *  the whole reason the stamp exists: a test build that followed the prod
 *  channel would update itself into the prod release and vanish — the tester
 *  loses the build they were testing and never learns why. A prod build that
 *  followed dev would push unreviewed code to end users. Both are silent, and
 *  the correct default is knowable at build time, so it is decided there. */
export function resolveChannel(src: {
  /** `--channel=` on this run. */
  flag?: string;
  /** `AIO_UPDATE_CHANNEL` in this environment. */
  env?: string;
  /** Pinned in `data/meta.json` — set at install, or by `am channel`. */
  pinned?: string;
  /** Stamped into the artifact at build time. */
  stamp?: string;
  /** Explicit `updates.channel` in the app's own config. */
  config?: string;
}): string {
  return src.flag || src.env || src.pinned || src.config || src.stamp || "prod";
}

/** Decide what kind of source a URL is.
 *
 *  Deliberately narrow. A wrong guess here is not a cosmetic error — it points
 *  an app at a location that will never answer, and the failure surfaces as
 *  "no updates available", which is indistinguishable from being up to date.
 *  So only unambiguous shapes are inferred, and everything else throws asking
 *  for `kind:` rather than picking one. */
export function classifySource(
  source: string,
  explicit?: UpdateSourceKind,
): UpdateSourceKind {
  if (explicit) return explicit;
  if (/^git[+@]/.test(source) || /^ssh:\/\//.test(source)) return "git";
  if (/\.git\/?$/.test(source)) return "git";
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      `[updates] source is not a URL: "${source}". Use https://…, file:///…, ` +
        `or a git remote.`,
    );
  }
  // A forge URL with exactly owner/repo is a repository; anything deeper is a
  // path someone is publishing artifacts under.
  const forge = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/;
  const segments = url.pathname.split("/").filter(Boolean);
  if (forge.test(url.hostname)) {
    if (segments.length === 2) return "git";
    throw new Error(
      `[updates] cannot tell whether "${source}" is a git repository or a ` +
        `location holding published artifacts — say which with ` +
        `updates: { source, kind: "git" | "manifest" }.`,
    );
  }
  return "manifest";
}

/** Apply defaults to whatever the app declared. */
export function resolveUpdates(
  input: UpdatesInput,
  ctx: { flag?: string; env?: string; pinned?: string; stamp?: string } = {},
): ResolvedUpdates {
  const cfg: UpdatesConfig = typeof input === "string"
    ? { source: input }
    : input;
  const kind = classifySource(cfg.source, cfg.kind);
  // A git source follows a REF, and there is no universal ref named "prod".
  // Defaulting it to the stamp/prod chain would silently follow a branch that
  // does not exist, which reads to the user as "no updates, ever".
  const channel = kind === "git"
    ? (ctx.flag || ctx.env || ctx.pinned || cfg.channel || "main")
    : resolveChannel({ ...ctx, config: cfg.channel });
  const check = cfg.check ?? true;
  return {
    source: cfg.source.replace(/\/+$/, ""),
    kind,
    channel,
    intervalMs: check === false
      ? 0
      : check === true
      ? defaultInterval(channel)
      : check,
    auto: cfg.auto ?? false,
    key: cfg.key,
    allowUnsigned: cfg.allowUnsigned ?? false,
  };
}

/** The manifest URL for a channel and platform.
 *
 *  Platform is in the PATH as well as inside the signed manifest: the path
 *  keeps a mac client from ever downloading a linux build, and the signed field
 *  catches the case where the paths were populated wrongly. Neither alone is
 *  enough — one prevents the mistake, the other detects it. */
export function manifestUrl(
  source: string,
  channel: string,
  platform: { os: string; arch: string },
): string {
  return `${
    source.replace(/\/+$/, "")
  }/${channel}/${platform.os}-${platform.arch}.json`;
}

/** Resolve a manifest's `url` against the manifest's own location, so a release
 *  published beside its manifest needs no absolute URLs. */
export function artifactUrl(manifestUrlStr: string, m: ShipManifest): string {
  return new URL(m.url ?? "", manifestUrlStr).href;
}

// ── versions ────────────────────────────────────────────────────────────────

type Parsed = { nums: number[]; pre: string[] };

function parseVersion(v: string): Parsed {
  const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
  const rest = v.replace(/^v/, "").slice(core.length + 1);
  const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return {
    nums,
    pre: (pre ? rest : "").split(".").filter(Boolean),
  };
}

function comparePre(a: string[], b: string[]): number {
  // No prerelease outranks any prerelease: 1.0.0 > 1.0.0-alpha.
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  return comparePieces(pieces(a), pieces(b));
}

/** A prerelease as the sequence of letter-runs and digit-runs it is made of,
 *  dots or no dots: `alpha62` and `alpha.62` are both `["alpha", "62"]`.
 *
 *  SemVer compares alphanumeric identifiers as ASCII strings, which puts
 *  `alpha9` AFTER `alpha62` — "9" > "6" — and this project's own tags are
 *  exactly that shape (`v1.0.0-alpha62`, `v1.0.0-alpha63`). Read literally, the
 *  updater told an app on `alpha9` that it was newer than the published
 *  `alpha62` and never offered the release; `am`, which parses the number out,
 *  ordered the same pair the other way. Two comparators, two answers, one repo.
 *
 *  So the order is PIECEWISE: letters as letters, digit runs as numbers, and a
 *  dot is just a boundary (`rc1` ≡ `rc.1`). Every ordering SemVer's own spec
 *  lists still holds (`alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11
 *  < rc.1 < release`) — the two differ only where a digit run sits inside an
 *  identifier, and there this is the order every human and the rest of the
 *  toolchain already assume. */
function pieces(ids: string[]): string[] {
  return ids.flatMap((id) => id.match(/\d+|\D+/g) ?? []);
}

/** Exported for the one place that must agree with it byte-for-byte: `am`. */
export function comparePieces(pa: string[], pb: string[]): number {
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i], b = pb[i];
    if (a === undefined) return -1; // the shorter sequence is the earlier one
    if (b === undefined) return 1;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) {
      const d = Number(a) - Number(b);
      if (d) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric pieces rank below alphabetic ones
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** Semver comparison with prerelease ordering. -1 · 0 · 1. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** Is `candidate` a prerelease (`1.2.0-rc.1`)? */
export function isPrerelease(v: string): boolean {
  return parseVersion(v).pre.length > 0;
}

// ── data compatibility ──────────────────────────────────────────────────────

/** What the RUNNING app has on disk right now: the persisted schema version of
 *  each cell, plus aio's own persistence schema. */
export type LocalData = {
  schema: number;
  /** cellId → the version currently persisted. */
  cells: Record<string, number>;
};

/** The verdict on whether a release can be installed over this data. */
export type CompatVerdict = {
  /** Safe to install. When false the release is NEVER offered as an update. */
  ok: boolean;
  /** Installing it will run migrations — so a backup is taken first, and a
   *  rollback afterwards must restore that backup rather than just the binary. */
  migrates: boolean;
  /** Why it cannot be installed. Shown verbatim; each line names a cell. */
  blockers: string[];
  /** Survivable, but the user should know (a cell disappeared, say). */
  warnings: string[];
};

/** Is this actually a data contract, or just an object that reached us?
 *
 *  Checked rather than trusted because nothing else checks it: the manifest is
 *  cast, not parsed, and this gate is the last thing between a release and an
 *  app's data. */
function isDataContract(c: unknown): c is DataContract {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  if (typeof o.schema !== "number" || !Number.isFinite(o.schema)) return false;
  if (typeof o.cells !== "object" || o.cells === null) return false;
  return Object.values(o.cells as Record<string, unknown>).every((v) => {
    if (typeof v !== "object" || v === null) return false;
    const cell = v as Record<string, unknown>;
    return typeof cell.version === "number" &&
      typeof cell.migratesFrom === "number";
  });
}

/** What is wrong with it, in the blocker line — "malformed" alone sends
 *  someone to read a manifest by hand. */
function describeContract(c: unknown): string {
  if (typeof c !== "object" || c === null) return `it is ${typeof c}`;
  const o = c as Record<string, unknown>;
  if (typeof o.schema !== "number") return "no `schema` version";
  if (typeof o.cells !== "object" || o.cells === null) return "no `cells` map";
  return "a cell entry without `version`/`migratesFrom`";
}

/** Decide whether a published build can take over this app's data.
 *
 *  This is the gate behind the project's hardest rule: an update never breaks
 *  the app or its data. Anything it cannot prove safe becomes a blocker, and a
 *  blocked release is reported as "a newer version exists that cannot migrate
 *  your data" — never offered as something to click Yes on. */
export function dataCompatibility(
  local: LocalData,
  contract: DataContract | undefined,
): CompatVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let migrates = false;

  const persisted = Object.entries(local.cells);

  // A contract that is PRESENT but not a contract is not a pass. The manifest
  // arrives as `JSON.parse(text) as ShipManifest` — a cast, not a validation —
  // so a mis-published or older-format release could hand this gate `{}` (a
  // TypeError from inside the thing whose contract is "anything it cannot prove
  // safe becomes a blocker") or `{cells:{…}}` with no `schema`, where
  // `undefined < local.schema` is false and the backwards-schema blocker simply
  // could not fire. Both are now what they always should have been: a refusal.
  if (contract && !isDataContract(contract)) {
    return {
      ok: false,
      migrates,
      blockers: [
        `the release's data contract is malformed (${
          describeContract(contract)
        }) ` +
        `— it cannot be checked against your data, so it is not offered. ` +
        `Re-publish with \`aio ship\`, which derives the contract from the ` +
        `cells the build actually runs.`,
      ],
      warnings,
    };
  }

  if (!contract) {
    // Nothing on disk to protect — an app with no persisted cell versions
    // cannot have its data broken by a schema it does not have.
    if (persisted.length === 0) {
      return { ok: true, migrates, blockers, warnings };
    }
    return {
      ok: false,
      migrates,
      blockers: [
        "the release does not declare what it does with persisted data — " +
        "re-publish it with `aio ship` so the data contract is signed",
      ],
      warnings,
    };
  }

  if (contract.schema < local.schema) {
    blockers.push(
      `persistence schema goes backwards (on disk v${local.schema} → ` +
        `release v${contract.schema}); an older store format cannot read ` +
        `data this one wrote`,
    );
  }

  for (const [id, onDisk] of persisted) {
    const c = contract.cells[id];
    if (!c) {
      // Deliberate on the author's part, and not destructive by itself: the
      // rows stay on disk, they just stop being read. Worth saying out loud.
      warnings.push(
        `cell "${id}" no longer exists in the release — its stored data will ` +
          `stop being loaded (it is not deleted)`,
      );
      continue;
    }
    if (c.version < onDisk) {
      blockers.push(
        `cell "${id}" goes backwards (on disk v${onDisk} → release ` +
          `v${c.version}) — the release is older than your data`,
      );
      continue;
    }
    if (c.version === onDisk) continue;
    if (c.migratesFrom > onDisk) {
      blockers.push(
        `cell "${id}" cannot migrate your data (on disk v${onDisk}, release ` +
          `writes v${c.version} and migrates only from v${c.migratesFrom}) — ` +
          `the release has no onMigrate covering your version`,
      );
      continue;
    }
    migrates = true;
  }

  return { ok: blockers.length === 0, migrates, blockers, warnings };
}

/** Derive this build's data contract from the cells it actually runs.
 *
 *  Measured, never declared twice: the same `version`/`onMigrate` the runtime
 *  uses to migrate at boot is what gets published, so a manifest cannot promise
 *  something the binary does not do.
 *
 *  `onMigrate` present ⇒ migrates from 1, because that hook's contract already
 *  is "called when the persisted version is older". Absent ⇒ this build can
 *  only read what it wrote, so an older store is unreadable and the update is
 *  never offered to anyone holding one. */
export function deriveDataContract(
  cells: Iterable<readonly [string, { version: number; onMigrate?: unknown }]>,
  schema: number,
): DataContract {
  const out: Record<string, CellContract> = {};
  for (const [id, info] of cells) {
    // version 0 is "unversioned" — no schema promise to make, and nothing that
    // can block. Publishing it as v0/from-0 keeps the gate a no-op for it.
    out[id] = {
      version: info.version,
      migratesFrom: info.onMigrate ? 1 : info.version,
    };
  }
  return { schema, cells: out };
}

// ── the decision ────────────────────────────────────────────────────────────

/** Why a fetched manifest is not something to offer. */
export type UpdateDecision =
  | { kind: "current"; reason: string }
  | { kind: "offer"; version: string; migrates: boolean; warnings: string[] }
  | { kind: "incompatible"; version: string; blockers: string[] }
  | { kind: "refused"; reason: string };

/** The tip of the followed ref, as `git ls-remote` reports it — one cheap
 *  network round-trip, no clone. */
export type GitHead = {
  sha: string;
  ref: string;
  /** `version` from the repo's deno.json, when the checker could read it. */
  version?: string;
};

/** Decide against a git source.
 *
 *  A repository has no signed manifest and no version ordering — a ref moves,
 *  and where it moves is the new version. So the comparison is identity, not
 *  order, and the DATA GATE CANNOT RUN YET: what the new commit does to the
 *  store is only knowable once it has been built. That check therefore happens
 *  after the build and before the restart, and `migrates` is reported unknown
 *  here rather than assumed false. */
export function decideGit(opts: {
  currentSha: string | null;
  head: GitHead;
  dismissed?: string | null;
}): UpdateDecision {
  const { head } = opts;
  if (!opts.currentSha) {
    return {
      kind: "refused",
      reason:
        "this install does not record the commit it was built from, so a git " +
        "source has nothing to compare against — reinstall with the one-line " +
        "runner, or publish artifacts and use a manifest source",
    };
  }
  if (opts.currentSha === head.sha) {
    return { kind: "current", reason: `${head.ref} is at ${short(head.sha)}` };
  }
  if (opts.dismissed === head.sha) {
    return { kind: "current", reason: `${short(head.sha)} was dismissed` };
  }
  return {
    kind: "offer",
    version: head.version
      ? `${head.version} (${short(head.sha)})`
      : short(head.sha),
    // Unknown until the commit is built and asked. The applier re-checks.
    migrates: false,
    warnings: [
      "a git source is rebuilt from the repository — its data compatibility " +
      "is verified after the build and before anything is restarted",
    ],
  };
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** Turn a verified manifest into what the user is told.
 *
 *  Ordering matters: a release is refused before it is compared, compared
 *  before its data is judged, and judged before it is ever called an update.
 *  `"incompatible"` is a distinct outcome from `"refused"` on purpose — the
 *  user is told a newer version exists and why they cannot take it, rather
 *  than being shown nothing (which reads as "I am up to date"). */
export function decide(opts: {
  current: string;
  manifest: ShipManifest;
  local: LocalData;
  /** Install targets this client can actually perform. */
  canInstall: UpdateTarget[];
  /** Follow prerelease versions within the channel. */
  prerelease?: boolean;
  /** The version the user already said no to. */
  dismissed?: string | null;
}): UpdateDecision {
  const { manifest: m, current } = opts;

  if (!opts.canInstall.includes(m.target)) {
    return {
      kind: "refused",
      reason: m.target === "android"
        ? `Android packages install through the OS — open the release page to update`
        : `this install cannot apply a "${m.target}" release`,
    };
  }

  const cmp = compareVersions(m.version, current);
  if (cmp === 0) return { kind: "current", reason: `${current} is the latest` };
  if (cmp < 0) {
    // Not an error worth alarming anyone about: it is what a channel switch
    // looks like from the old side, and what a rolled-back release looks like.
    return {
      kind: "current",
      reason: `${current} is newer than ${m.channel}'s ${m.version}`,
    };
  }

  if (!opts.prerelease && isPrerelease(m.version)) {
    return {
      kind: "current",
      reason:
        `${m.version} is a prerelease — set prerelease: true to follow it`,
    };
  }

  if (m.minFrom && compareVersions(current, m.minFrom) < 0) {
    return {
      kind: "incompatible",
      version: m.version,
      blockers: [
        `${m.version} can only be installed over ${m.minFrom} or newer — ` +
        `update to ${m.minFrom} first`,
      ],
    };
  }

  const compat = dataCompatibility(opts.local, m.data);
  if (!compat.ok) {
    return {
      kind: "incompatible",
      version: m.version,
      blockers: compat.blockers,
    };
  }

  if (opts.dismissed && compareVersions(m.version, opts.dismissed) <= 0) {
    return { kind: "current", reason: `${m.version} was dismissed` };
  }

  return {
    kind: "offer",
    version: m.version,
    migrates: compat.migrates,
    warnings: compat.warnings,
  };
}
