// app-key.ts — the app's auth key for --expose. Persisted by default so it
// survives restarts ("one key, use forever"); overridable with a fixed key,
// or disabled explicitly. This is the sugar over the `users` map for the
// common "one shared key" case.
import { appDirs } from "./app-dirs.ts";
import { octal, privateDirRefusal, sharedBits } from "./dir-permissions.ts";
import { dirname, join } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";

/** Outcome of resolving the app key. */
export interface KeyResolution {
  /** The auth token — `undefined` means no framework auth (open / app-level). */
  key: string | undefined;
  /** True when the key was read from / written to the data dir (default mode). */
  persisted: boolean;
  /** True when the user set `key` explicitly (a string, or `false` for open). */
  explicit: boolean;
}

/**
 * Resolve the app's auth key:
 * - `key: "secret"` → that fixed key (auth on).
 * - `key: false` / `undefined` → **no framework auth** (open — the app does
 *   its own user auth, or is deliberately open on a trusted LAN). NOTE the
 *   CALLER decides the default: since alpha52, aio.ts passes `true` for an
 *   exposed app with no per-user auth and `key` unset, so "exposed + nothing"
 *   gets a generated key rather than an open port; `key: false` stays the
 *   explicit opt-out.
 * - `key: true` → a stable key generated once and persisted in the data dir,
 *   the same across restarts.
 */
/** THE alpha52 key-default decision, as one pure function so it is pinned by
 *  a test instead of inferred from boot plumbing: an app that is EXPOSED with
 *  no per-user auth (users/resolveUser/auth) and no `key` decision behaves as
 *  `key: true` — a generated, persisted shared key — instead of an app open
 *  to everyone on the network. `key: false` stays the explicit opt-out;
 *  loopback (not exposed) and per-user apps are untouched. */
export function defaultAppKeyConfig(opts: {
  expose: boolean;
  perUserAuth: boolean;
  key: string | boolean | undefined;
}): { key: string | boolean | undefined; defaulted: boolean } {
  if (opts.expose && !opts.perUserAuth && opts.key === undefined) {
    return { key: true, defaulted: true };
  }
  return { key: opts.key, defaulted: false };
}

/** Make a credential's directory, owner-only. THE spelling.
 *
 *  0700 for the same reason `ensureAppDirs` gives for the tree above it: the
 *  mode of a directory is decided by what it can EVER hold, not by what
 *  today's file happens to be. `resolveAppKey` used to make this directory
 *  itself, at the umask — 0755 on a stock Ubuntu — because it runs before
 *  `aio.run` has built the tree when a test or `am` calls it directly. */
function ensureKeyHome(path: string): void {
  Deno.mkdirSync(dirname(path), { recursive: true });
  if (Deno.build.os === "windows") return; // no POSIX mode; chmod throws
  try {
    Deno.chmodSync(dirname(path), 0o700);
  } catch { /* a restrictive umask or FS may refuse — best effort */ }
}

/** Write a credential so it is never, at any instant, readable by anyone else.
 *  THE spelling — three lived in this file, and only one of them was right.
 *
 *  `mode` applies at CREATE time only, which is why the remove comes first:
 *  rewriting a file some older version left at 0644 would otherwise keep the
 *  0644. And creating at 0600 rather than chmod-ing afterwards closes the
 *  window in which the file exists at the umask — narrow, but a credential
 *  read during it is read for good.
 *
 *  Throws on failure. A silent one leaves the caller believing a secret is on
 *  disk at 0600 when it may be at 0644 or absent. */
function writeSecretFileSync(path: string, contents: string): void {
  ensureKeyHome(path);
  try {
    Deno.removeSync(path);
  } catch { /* not present */ }
  Deno.writeTextFileSync(path, contents, { mode: 0o600 });
  if (Deno.build.os === "windows") return;
  try {
    Deno.chmodSync(path, 0o600); // belt and braces where `mode` was ignored
  } catch { /* chmod unsupported */ }
}

export function resolveAppKey(
  appId: string,
  configKey: string | boolean | undefined,
): KeyResolution {
  const path = appDirs(appId).appKey;
  // A direct caller (a test, `am`) may reach this before aio.run() created the
  // tree — the key is tier ① data, so make its home rather than fail.
  try {
    ensureKeyHome(path);
  } catch { /* exists, or unwritable — the write below reports it */ }
  // Default (undefined) and explicit `false` → no framework auth (open).
  if (configKey === undefined || configKey === false) {
    // Clear any stale key file so tooling reports "open".
    try {
      Deno.removeSync(path);
    } catch { /* not present */ }
    return { key: undefined, persisted: false, explicit: configKey === false };
  }
  if (typeof configKey === "string" && configKey.length > 0) {
    // Mirror the fixed key to disk too, so `am profile` and other local
    // tooling read the ACTIVE key regardless of where it was set.
    try {
      writeSecretFileSync(path, configKey);
    } catch (e) {
      // The fixed key still works in-process; what does NOT work is `am`
      // reading it from the data dir — and that used to fail silently.
      log.warn(
        "auth",
        `could not record the app key at ${path} (${e}) — the key works, ` +
          `but tooling reading it from the data dir will not find it`,
      );
    }
    return { key: configKey, persisted: false, explicit: true };
  }
  // `key: true` → a persisted, stable auto-generated key.
  try {
    try {
      const existing = Deno.readTextFileSync(path).trim();
      if (existing) return { key: existing, persisted: true, explicit: true };
    } catch { /* not created yet */ }
    const key = crypto.randomUUID();
    writeSecretFileSync(path, key);
    return { key, persisted: true, explicit: true };
  } catch {
    // Data dir not writable — fall back to an ephemeral key (still auth-on).
    return { key: crypto.randomUUID(), persisted: false, explicit: true };
  }
}

/** Path to the persisted key file (for tooling like `am profile`). */
export function appKeyPath(appId: string): string {
  return appDirs(appId).appKey;
}

// ── Local control credential (`<data>/control.key`) ──────────────────────────
//
// WHAT IT IS: the proof that the caller is the OS USER WHO OWNS THIS APP'S
// DATA. The app mints it at boot into its own data dir — 0600 inside a 0700
// directory — and `am`/amui read it and present it on `/__aio/trojan/*` calls.
// "Can read this file" is therefore exactly "owns the app's data", which is the
// same trust boundary that makes the trojan's same-machine rule meaningful in
// the first place. A second local user, a remote caller, and a production build
// all still get nothing (see the gate in server-auth.ts).
//
// WHY NOT REUSE THE APP KEY (`app.key`), which already exists here:
//  1. it does not exist where the problem is. aio.ts mints the app key only for
//     `expose && !users && !resolveUser`; the modes that lost their tooling
//     (`auth: true`, `users:`, `resolveUser`) and a plain local dev app have no
//     app key at all, so reuse could not authenticate the case that broke.
//  2. the app key is SHAREABLE ON PURPOSE — `/__aio/pair`, `am profile` and
//     `.aioapp` files hand it to other people's devices. Whoever paired a phone
//     over the LAN would then hold raw state, arbitrary dispatch, SQL and
//     whole-state overwrite. Control-plane authority must come from owning the
//     machine, not from being a member of the app.
//  3. the app key is deliberately FOREVER ("one key, use forever"); this one is
//     minted fresh per boot and removed at shutdown, so a stolen copy is dead
//     the moment the app restarts and there is no rotation story to get wrong.
// Where the app key DOES exist (shared-key mode) it stays the credential `am`
// presents to the app's front door — that gate is the app key's job.
//
// WHY A FILE AND NOT THE LOCK FILE: the lock lives in `$XDG_RUNTIME_DIR/aio/`,
// which falls back to `/tmp` (world-readable, sticky) on macOS and on any Linux
// without XDG_RUNTIME_DIR. `<data>` is 0700 by construction (`ensureAppDirs`),
// and this code REFUSES to mint when it is not — a secret is never written to a
// directory that cannot keep it.

/** `<data>/control.key` — the local operator's credential for the dev control
 *  plane. Owner-only, per-boot, never sent to any other machine. */
export function controlKeyPath(appId: string): string {
  return join(appDirs(appId).data, "control.key");
}

/** Either the credential, or the reason there isn't one — never a silent miss. */
export type ControlKeyResult =
  | { key: string; path: string; error?: undefined }
  | { key?: undefined; path?: undefined; error: string };

/** THE rule for "may a control credential live in this directory", as one pure
 *  function so it can be pinned by a test rather than inferred from plumbing.
 *  Returns the refusal, or null when the directory keeps a secret.
 *  A `null` mode is Windows (no POSIX bits) — there the ACLs of the user's own
 *  profile directory are the boundary, and the trojan is still dev-only and
 *  same-machine-only.
 *  @internal */
export function _controlDirRefusal(
  dir: string,
  mode: number | null,
): string | null {
  // The generic rule lives in dir-permissions.ts; this adds what to DO.
  if (privateDirRefusal(dir, mode) === null) return null;
  return `app data dir ${dir} is mode ${
    octal(mode)
  } (not owner-only) — refusing to write a control-plane credential where ` +
    `another local user could read it; chmod 700 it (or unset AIO_APPS_DIR ` +
    `if it points at a shared directory) and restart`;
}

/** Mint (or replace) this app's local control credential. Server side, boot.
 *
 *  Fails LOUD and mints NOTHING when the data dir is not owner-only: writing a
 *  control-plane secret into a directory another local user can read would turn
 *  a dev convenience into exactly the side entrance this exists to avoid. The
 *  0700 is re-applied first — the app owns this directory, so a wrong mode is
 *  fixed rather than merely reported; the refusal is for when it CANNOT be
 *  (another owner, a read-only or permission-less mount). */
export function mintControlKey(appId: string): ControlKeyResult {
  const path = controlKeyPath(appId);
  const dir = dirname(path);
  try {
    Deno.mkdirSync(dir, { recursive: true });
    if (Deno.build.os !== "windows") Deno.chmodSync(dir, 0o700);
  } catch {
    /* exists / chmod unsupported — the stat below is the real check */
  }
  let dirMode: number | null = null;
  try {
    dirMode = Deno.statSync(dir).mode;
  } catch (e) {
    return {
      error: `cannot stat the app data dir ${dir} (${
        e instanceof Error ? e.message : e
      }) — no local control credential`,
    };
  }
  const refusal = _controlDirRefusal(dir, dirMode);
  if (refusal) return { error: refusal };
  const key = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  try {
    writeSecretFileSync(path, key + "\n");
  } catch (e) {
    return {
      error: `cannot write ${path} (${
        e instanceof Error ? e.message : e
      }) — no local control credential`,
    };
  }
  return { key, path };
}

/** Read this app's local control credential. Client side (`am`, amui).
 *
 *  Refuses a credential the filesystem says is not exclusively ours — a
 *  group/world-readable file, or one owned by another uid, is either leaked or
 *  planted, and using it either way is worse than reporting it. */
export function readControlKey(appId: string): ControlKeyResult {
  const path = controlKeyPath(appId);
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(path);
  } catch {
    return {
      error: `no local control credential at ${path} — the app mints one at ` +
        `boot in dev; it is absent for a production build, for an app started ` +
        `before this aio version, or when this app's data lives elsewhere ` +
        `(AIO_APPS_DIR / appDir). Restart the app in dev to get one`,
    };
  }
  const shared = sharedBits(st.mode);
  if (shared !== null && shared !== 0) {
    return {
      error:
        `${path} is mode ${
          octal(st.mode)
        } — other local users can read this control credential. Refusing to use ` +
        `it: delete it and restart the app (and check the mode of its parent dir)`,
    };
  }
  let uid: number | null = null;
  try {
    uid = Deno.uid?.() ?? null;
  } catch { /* --allow-sys not granted — fall back to the mode check */ }
  if (uid !== null && st.uid !== null && st.uid !== uid) {
    return {
      error: `${path} is owned by uid ${st.uid}, not by you (uid ${uid}) — ` +
        `refusing to present another user's control credential`,
    };
  }
  let key = "";
  try {
    key = Deno.readTextFileSync(path).trim();
  } catch (e) {
    return {
      error: `cannot read ${path} (${e instanceof Error ? e.message : e})`,
    };
  }
  if (!key) return { error: `${path} is empty — restart the app` };
  return { key, path };
}

/** Remove the credential (shutdown). Best-effort: a leftover file is inert —
 *  the running app only ever accepts the value it holds in memory. */
export function removeControlKey(appId: string): void {
  try {
    Deno.removeSync(controlKeyPath(appId));
  } catch { /* never existed / already gone */ }
}
