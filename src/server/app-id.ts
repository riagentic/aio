// App identity — THE rule that names an app's lock, data home, socket and
// cookie. Pure resolution, no lock state: split out of single-instance-lock.ts,
// which re-exports every name here, so no importer changes.

import {
  basename,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { legacyIdFallback } from "./app-dirs.ts";
import { locateDenoJsonAbove, readDenoJsonSync } from "./deno-json.ts";
import { inheritedWorkerAppId } from "./cell-worker-protocol.ts";
import { DEFAULT_ENTRY } from "./app-files.ts";

/** Slugify a string for filesystem use — THE transform.
 *
 *  One fact with four copies before this: the appId slug names the lock file,
 *  the data directory, the UDS socket AND the shared-key cookie, and the same
 *  expression was written out in `build-helpers` (binary names),
 *  `electron-shared` (the userData path) and `server.ts` (the cookie). They
 *  agreed, which is the dangerous state: changing the appId rule in one place
 *  would leave two apps whose ids differ only in punctuation sharing a cookie
 *  while holding separate locks — a credential crossing between apps, from an
 *  edit that looked local.
 *
 *  The FALLBACK stays a caller's choice, because it genuinely is one: a lock
 *  with no id is `aio-app`, a nameless binary is `myapp`, a cookie is `app`. */
export function slugify(s: string, fallback = "aio-app"): string {
  const base =
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    fallback;
  // A NON-ASCII name is not a name this can spell, and dropping the letters
  // silently made DIFFERENT apps into ONE. Measured: "Über" and "Ber" both
  // became `ber`, and two apps named entirely in CJK or Cyrillic both became
  // the bare fallback — one `~/.<id>` data directory, one single-instance
  // lock (so the second refuses to start), one UDS socket, one `state.db`,
  // and one shared-key cookie. This function's own header calls that last one
  // "a credential crossing between apps".
  //
  // So a name with a character this alphabet cannot carry gets a short hash
  // of the ORIGINAL. Deliberately narrow: only NON-ASCII input is treated as
  // lossy, so every pure-ASCII id — which is all of them in practice, and
  // every id `cell()` would accept — is byte-identical to before. ASCII
  // punctuation stays a separator, as it always was.
  return _hasNonAscii(s) ? `${base}-${_shortHash(s)}` : base;
}

/** Does `s` carry a character this alphabet cannot spell?
 *
 *  By code point, not by regex: the range that says it (`[^\x00-\x7F]`)
 *  trips `no-control-regex`, and widening it to printable ASCII would make a
 *  tab or a newline "lossy" too — changing the id of a name that reduces
 *  perfectly well today. */
function _hasNonAscii(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return true;
  return false;
}

/** FNV-1a, 32-bit, base36. Short, stable across runs and platforms, and
 *  dependency-free — it only has to tell two app names apart. */
function _shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The identity fields of a project's `deno.json`, in the ONE order that decides
 *  an app's id. Null when the file names none of them.
 *
 *  Shared with the BUILD (`build-config.ts` names the binary with it) because a
 *  compiled app takes its identity from its own filename — so the build's
 *  naming rule and this chain are the same decision seen from two sides. They
 *  used to be two: the build read `title ?? basename(root)` and ignored `appId`
 *  outright, so a `deno.json` with `appId: "wallet"` in a directory called
 *  `thing` was `~/.wallet` in dev and `~/.thing` once compiled. The data
 *  directory MOVED when you compiled — the one asterisk `app-dirs.ts` promises
 *  it does not have. */
export function appIdFromConfig(
  cfg: { appId?: string; title?: string; name?: string } | null | undefined,
): string | null {
  // aio-ok: path-split — a package name (`@scope/name`)
  const raw = cfg?.appId ?? cfg?.title ?? cfg?.name?.split("/").pop();
  return raw ? slugify(raw) : null;
}

/** THE zero-config identity of a project: its deno.json's identity fields
 *  ({@link appIdFromConfig}), else the project directory's name.
 *
 *  One rule, three askers — the dev runtime (`resolveAppId`, with the project
 *  found by walking up from the ENTRY), the build (it names the binary with
 *  it, and a compiled app with no declared id takes its identity from that
 *  name) and `am` (from `projectRoot()`). They used to be three rules: dev read
 *  deno.json from the launch CWD only and otherwise took the ENTRY's directory
 *  name, so a pinned `appId` was dropped when `deno run` started from `src/`,
 *  and an entry at `server/main.ts` was `~/.server` in dev but `~/.<project>`
 *  once compiled and to `am`. */
export function projectAppId(
  root: string,
  cfg: { appId?: string; title?: string; name?: string } | null | undefined,
): string {
  return appIdFromConfig(cfg) ?? slugify(basename(root));
}

/** The entry module's `file:` URL, or null (REPL, eval, a remote entry, a
 *  worker — where `Deno.mainModule` is undefined). */
function _fileEntry(): URL | null {
  try {
    const main = new URL(Deno.mainModule);
    return main.protocol === "file:" ? main : null;
  } catch {
    return null;
  }
}

/** The entry's directory name — its parent when the entry sits in `src/`.
 *  The last rung when no deno.json is anywhere near the entry. */
function _entryDirAppId(main: URL): string | null {
  // aio-ok: path-split — a file: URL pathname — always `/`
  const parts = main.pathname.split("/").filter(Boolean);
  parts.pop(); // the entry file itself
  const dir = parts.pop();
  const name = dir === "src" ? parts.pop() : dir;
  // Undecoded, as it always was: this rung's answer for an existing app must
  // not change under it.
  return name ? slugify(name) : null;
}

/** The launch CWD's deno.json identity — only the previous dev rule and a
 *  non-`file:` entry (which has no project of its own to walk from) use it. */
function _cwdConfigAppId(): string | null {
  try {
    // JSONC-aware: `JSON.parse` threw on a deno.json with a comment in it and
    // the id silently fell through to the directory name.
    return appIdFromConfig(
      readDenoJsonSync(Deno.cwd())?.config as
        | { appId?: string; title?: string; name?: string }
        | undefined,
    );
  } catch {
    return null; // unreadable / malformed — fall through
  }
}

/** The PREVIOUS dev rule: the launch CWD's deno.json identity, else the
 *  entry's directory name. Still THE rule for an entry its project does not
 *  declare (see {@link _projectRuleAppId}).
 *
 *  The CWD's deno.json counts only for an entry INSIDE the CWD: from `~/appA`
 *  (`appId: "a"`), `deno run ../appB/src/app.ts` took the id "a" — and
 *  opened appA's `state.db`. */
function _legacyAppId(main: URL): string | null {
  let inside = false;
  try {
    // Real paths on both sides: a symlinked launch path is still inside, and
    // `relative` needs no separator suffix (a cwd of `/` or `C:\` works).
    const real = (p: string) => {
      try {
        return Deno.realPathSync(p);
      } catch {
        return resolve(p);
      }
    };
    const rel = relative(real(Deno.cwd()), real(fromFileUrl(main)));
    inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    // aio-ok: cwd gone — no cwd project to name the entry; the entry-dir rule answers
  }
  return (inside ? _cwdConfigAppId() : null) ?? _entryDirAppId(main);
}

/** The project rule's id ({@link projectAppId}) — or null unless the entry IS
 *  a declared entry of the project found by walking up from it (THE
 *  app-config walk, `locateDenoJsonAbove`, the one `appDenoJson()` uses):
 *  deno.json `entry` (else `DEFAULT_ENTRY`) or a `build.targets` entry —
 *  what `aio build` compiles, so dev == build for every buildable app.
 *
 *  An entry the project does not declare is not "that project's app": a
 *  monorepo root deno.json with no identity above `apps/a/main.ts` and
 *  `apps/b/main.ts` would make both ONE app (one lock, one `state.db`), and an
 *  unrelated `~/deno.json` would name every entry a few levels below it. */
function _projectRuleAppId(main: URL): string | null {
  const located = locateDenoJsonAbove(main);
  if (!located) return null;
  const root = fromFileUrl(located.dir);
  const { entry, targets } = _declaredEntries(located.config);
  const self = fromFileUrl(main);
  if (![entry, ...targets].some((e) => resolve(root, e) === self)) return null;
  const cfg = located.config as {
    appId?: string;
    title?: string;
    name?: string;
  };
  // A project that declares COMPONENTS (several entries in `build.targets`)
  // and names no identity has no single "this app": each entry keeps its own
  // directory's name, which is what `am` computes per component
  // (`componentAppId`). The project folder's name here would make every
  // component ONE app — one lock, one data directory — and the second refused.
  // (Two shells of one entry are one component.)
  if (!appIdFromConfig(cfg) && new Set(targets.map((t) => join(t))).size > 1) {
    return _entryDirAppId(main);
  }
  return projectAppId(root, cfg);
}

/** A deno.json's declared entries: its `entry` (else `DEFAULT_ENTRY`) — what
 *  `aio build` compiles with no target — and each object-form `build.targets`
 *  entry (a target with none compiles `entry`; the array form is one app). */
function _declaredEntries(
  cfg: Record<string, unknown>,
): { entry: string; targets: string[] } {
  const entry = typeof cfg.entry === "string" && cfg.entry
    ? cfg.entry
    : DEFAULT_ENTRY;
  const raw = (cfg.build as { targets?: unknown } | undefined)?.targets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { entry, targets: [] };
  }
  const targets = Object.values(
    raw as Record<string, { entry?: unknown } | null>,
  ).map((t) =>
    typeof t?.entry === "string" && t.entry.trim() ? t.entry.trim() : entry
  );
  return { entry, targets };
}

/** Dev inference: the project rule for a declared entry, else the previous
 *  rule — and the previous rule's id even for a declared entry while ITS home
 *  holds this app's data and the project rule's home holds none
 *  ({@link legacyIdFallback}), with the warning the boot logs. */
function _devResolution(): { id: string | null; warning: string | null } {
  const main = _fileEntry();
  if (!main) return { id: _cwdConfigAppId(), warning: null };
  const legacy = _legacyAppId(main);
  const project = _projectRuleAppId(main);
  if (!project) return { id: legacy, warning: null };
  const warning = legacyIdFallback(project, legacy);
  return { id: warning ? legacy : project, warning };
}

/** The boot warning when this dev launch's zero-config id fell back to the
 *  previous rule's ({@link legacyIdFallback}), else null. Null too for every
 *  launch that never used that rule (a compiled binary, a worker thread; an
 *  explicit `appId` is the caller's check). */
export function inferredIdFallbackWarning(): string | null {
  if (inheritedWorkerAppId()) return null;
  const main = _fileEntry();
  if (!main) return null;
  // aio-ok: path-split — a file: URL pathname — always `/`
  if (main.pathname.split("/").some((p) => p.startsWith("deno-compile-"))) {
    return null;
  }
  return _devResolution().warning;
}

/** The deno.json that travels INSIDE a compiled binary, next to its entry.
 *  Read relative to `Deno.mainModule` (the VFS), never the launch directory —
 *  through THE app-config walk (`locateDenoJsonAbove`), the same one
 *  `appDenoJson()` uses for the version in the boot banner. It used to be a
 *  private copy that read only `deno.json` with `JSON.parse`: a `deno.jsonc`
 *  app, or a `deno.json` with one comment in it, found no identity, fell back
 *  to the binary's FILE NAME, and every versioned install
 *  (`app-1.2.3` → `~/.app-1-2-3/`) started from empty state. */
function _embeddedDenoJson(): unknown {
  try {
    return locateDenoJsonAbove(new URL(Deno.mainModule))?.config ?? null;
  } catch { /* no usable main module */ }
  return null;
}

/** Resolve app ID — explicit `appId` wins; otherwise inferred. */
export function resolveAppId(appId?: string): string {
  if (appId) return slugify(appId);
  // A `worker: true` cell's thread re-runs the app's entry, and its
  // `aio.run()` asks for the identity again. It must get the OWNER's answer,
  // not a fresh inference: `Deno.mainModule` is undefined inside a worker, so
  // neither the embedded deno.json nor the entry directory below is visible
  // there, and all that is left is the CWD — the one source a compiled binary
  // must never take its identity from. Measured: a compiled app with no
  // explicit appId crashed at boot when launched from `/`, and from another
  // project's directory its worker took that project's identity.
  const inherited = inheritedWorkerAppId();
  if (inherited) return inherited;
  // Compiled binaries: NEVER read the cwd's deno.json — the binary may be
  // launched from an unrelated project and must not adopt ITS identity
  // (locks, KV paths). The VFS path carries the binary name — stable per
  // binary regardless of launch directory.
  try {
    const main = new URL(Deno.mainModule);
    // aio-ok: path-split — a file: URL pathname — always `/`
    const compiledSeg = main.pathname.split("/").find((p) =>
      p.startsWith("deno-compile-")
    );
    if (compiledSeg) {
      // The VFS segment is named after the EXECUTABLE FILE, at runtime — so
      // renaming the binary renames the app. That is not a theoretical
      // objection: installing it as `<name>-<version>` (which is how versioned
      // installs and rollbacks work) gave the app the id `name-1-0-0`, and its
      // data directory moved with it. Every upgrade would then start from an
      // empty `~/.<name>-<newversion>/` while the real state sat in the old
      // one — silent, and exactly the kind of loss `~/.<appId>` exists to
      // prevent. `mv app app.bak` would do the same.
      //
      // The binary EMBEDS its deno.json (that is where the version in the boot
      // banner comes from), so the app's declared identity travels inside it
      // and does not depend on what the file is called. This still never reads
      // the CWD's deno.json — the rule that matters here is "not the launch
      // directory's identity", and an embedded file is the binary's own.
      const embedded = appIdFromConfig(
        _embeddedDenoJson() as
          | { appId?: string; title?: string; name?: string }
          | null,
      );
      if (embedded) return embedded;
      return slugify(compiledSeg.slice("deno-compile-".length));
    }
  } catch { /* no main module — fall through */ }
  // Zero-config inference (dev): THE project rule — the project the ENTRY
  // belongs to, not the directory it was launched from.
  const inferred = _devResolution().id;
  if (inferred) return inferred;
  throw new Error(
    '[aio] cannot infer an appId — add appId: "my-app" to aio.run() or ' +
      'an "appId"/"title" field to deno.json',
  );
}
