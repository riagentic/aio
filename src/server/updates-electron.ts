/**
 * @module
 * An update to a shared-runtime app (`"build": { "electronRuntime":
 * "shared" }`) may pin a DIFFERENT Electron than the one it replaces. That
 * runtime is not in the package — it is in the per-user shared store
 * (electron/shared-runtime.ts) — so the updater puts it there BEFORE the
 * swap, while the running version still works:
 *
 *   verified + test-started → ask the new build which Electron it needs
 *   (`--aio-electron-runtime`) → in the store? done : download it → swap
 *
 * So the first start of the new version never waits on a download, and a
 * download that fails leaves the update NOT installed and the app as it was.
 * The old runtime stays in the store: the rollback copy still starts from it,
 * and `am prune` keeps whatever an installed app names.
 *
 * A build that predates the flag refuses it by name ("unknown flag") and
 * carries its own Electron, as every build before this did. Any OTHER failure
 * to answer refuses the update: what the new build needs is then unknown, and
 * a swap that guessed "nothing" could leave an app that cannot open.
 */
import { electronSlug } from "../electron/electron-runtime-fetch.ts";
import {
  ensureSharedElectron,
  recordSharedUse,
  sharedElectronReady,
} from "../electron/shared-runtime.ts";
import { probeOffThread } from "./updates-apply.ts";

/** What a build answered to `--aio-electron-runtime`, or null. Pure: the
 *  answer is the LAST line of stdout that parses (the app's own modules may
 *  print before it). */
export function parseElectronRuntimeAnswer(
  stdout: string,
):
  | { runtime: string; version?: string; sha256?: string; client?: string }
  | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const v = JSON.parse(l.trim());
      if (v && typeof v.runtime === "string") {
        return {
          runtime: v.runtime,
          version: typeof v.version === "string" ? v.version : undefined,
          ...(typeof v.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256)
            ? { sha256: v.sha256 }
            : {}),
          ...(typeof v.client === "string" ? { client: v.client } : {}),
        };
      }
    } catch {
      // aio-ok: not the answer line — keep looking
    }
  }
  return null;
}

/** What a build said when asked how it gets its Electron. */
export type ElectronRuntimeProbe =
  | {
    kind: "answer";
    runtime: string;
    version?: string;
    sha256?: string;
    /** The client the build baked as this binary's default (only an online
     *  binary that is not the desktop package says it). */
    client?: string;
  }
  /** It predates the question: it refused the flag by name. */
  | { kind: "old" }
  | { kind: "failed"; why: string };

/** Pure: the probe's outcome from the child's exit and output. */
export function classifyElectronRuntimeProbe(
  out: { success: boolean; code: number; stdout: string; stderr: string },
): ElectronRuntimeProbe {
  if (out.success) {
    const a = parseElectronRuntimeAnswer(out.stdout);
    return a
      ? { kind: "answer", ...a }
      : { kind: "failed", why: "it exited 0 but printed no answer" };
  }
  if (/unknown flag: --aio-electron-runtime/.test(out.stderr)) {
    return { kind: "old" };
  }
  const last = out.stderr.trim().split("\n").slice(-2).join(" ");
  return {
    kind: "failed",
    why: `it exited ${out.code}${last ? ` — ${last}` : ""}`,
  };
}

/** Ask `exe` how it gets its Electron — in a worker, so an antivirus scan of
 *  a new exe holds no thread the app answers on (`probeOffThread`). */
export async function askElectronRuntime(
  exe: string,
  timeoutMs = 60_000,
): Promise<ElectronRuntimeProbe> {
  if (Deno.build.os !== "windows") {
    // A download arrives 0600; the smoke test makes it executable the same
    // way. A chmod that fails leaves the spawn below to say so.
    await Deno.chmod(exe, 0o755).catch(() => {
      // aio-ok: best effort — an artifact that still cannot run says so below
    });
  }
  try {
    const out = await probeOffThread(
      exe,
      ["--aio-electron-runtime"],
      timeoutMs,
      {
        stdout: true,
      },
    );
    if ("spawnError" in out) return { kind: "failed", why: out.spawnError };
    if (out.timedOut) {
      return { kind: "failed", why: `no answer within ${timeoutMs / 1000}s` };
    }
    return classifyElectronRuntimeProbe({ ...out, stdout: out.stdout ?? "" });
  } catch (e) {
    return { kind: "failed", why: e instanceof Error ? e.message : String(e) };
  }
}

const NOT_INSTALLED = "The update was NOT installed; the running version " +
  "is untouched.";

/** Make sure the Electron the verified new build at `exe` needs is in the
 *  shared store, and that the store knows this app needs it (so `am prune`
 *  between now and the new version's first start keeps it). Throws —
 *  refusing the update — when that cannot be known or had. */
export async function prefetchSharedElectron(
  exe: string,
  opts: {
    log: (m: string) => void;
    onProgress?: (fraction: number) => void;
    /** The download is about to begin — called only when one happens. */
    onDownload?: () => void;
    /** The download's size in bytes, once, when its response states one. */
    onTotal?: (bytes: number) => void;
    /** The installed artifact the store's record names (as a start does). */
    installed: string;
    /** The staged package carries `electron-shared.json`: it IS a shared
     *  build, whatever it answers. */
    markedShared?: boolean;
    /** Injected in tests. */
    ask?: (exe: string) => Promise<ElectronRuntimeProbe>;
    ensure?: typeof ensureSharedElectron;
    ready?: typeof sharedElectronReady;
    record?: typeof recordSharedUse;
    slug?: string;
  },
): Promise<void> {
  const answer = await (opts.ask ?? askElectronRuntime)(exe);
  if (answer.kind === "failed" && !opts.markedShared) {
    // Not marked shared (a bundled package, a plain binary, or an AppImage,
    // whose inside is not looked at): it carries its own Electron, or opens
    // its progress window and fetches it at its first start.
    opts.log(
      `the new version did not say which Electron it needs (${answer.why}) — ` +
        `none is fetched before the swap`,
    );
    return;
  }
  if (answer.kind === "failed") {
    throw new Error(
      `could not ask the new version which Electron it needs (${answer.why}). ` +
        NOT_INSTALLED,
    );
  }
  const shared = answer.kind === "answer" && answer.runtime === "shared";
  if (!shared) {
    if (opts.markedShared) {
      throw new Error(
        `the new version is a shared-runtime package, but it ${
          answer.kind === "old"
            ? "does not know the question"
            : `answered "${answer.runtime}"`
        } when asked which Electron it needs. ` + NOT_INSTALLED,
      );
    }
    return;
  }
  if (!opts.markedShared && answer.client && answer.client !== "electron") {
    // A plain binary whose default client is the browser (or a server): it
    // may never open a window, so ~100 MB is not fetched on its behalf. Its
    // first `--client=electron` start downloads with the progress window,
    // as any online start does.
    opts.log(
      `the new version opens as "${answer.client}" by default — no Electron ` +
        `is fetched before the swap (a --client=electron start fetches its own)`,
    );
    return;
  }
  if (!answer.version) {
    throw new Error(
      `the new version starts from a shared Electron but did not say which ` +
        `version. ` + NOT_INSTALLED,
    );
  }
  const version = answer.version;
  const slug = opts.slug ?? electronSlug();
  if (!answer.sha256) {
    throw new Error(
      `the new version carries no checksum for Electron ${version} on ` +
        `${slug}, so its download could not be told from a forgery. ` +
        NOT_INSTALLED,
    );
  }
  if (await (opts.ready ?? sharedElectronReady)(version, slug)) {
    opts.log(
      `the new version starts from Electron ${version}, already in ` +
        `the shared store`,
    );
  } else {
    opts.log(
      `the new version needs Electron ${version} — downloading it into ` +
        `the shared store before the update is installed`,
    );
    // Whole percents only, as the app's own download reports: per chunk it was
    // a dispatch into the updates cell ~440 times a second (measured on
    // Windows, a DISPATCH_STORM for the whole 158 MB download).
    let reported = -1;
    opts.onDownload?.();
    try {
      await (opts.ensure ?? ensureSharedElectron)(version, slug, {
        log: opts.log,
        warn: opts.log,
        sha256: answer.sha256,
        onBytes: (got, total) => {
          if (total <= 0) return;
          if (reported < 0) opts.onTotal?.(total);
          const pct = Math.min(100, Math.floor((got / total) * 100));
          if (pct > reported) {
            reported = pct;
            opts.onProgress?.(pct / 100);
          }
        },
      });
    } catch (e) {
      throw new Error(
        `the new version needs Electron ${version}, and it could not ` +
          `be downloaded: ${e instanceof Error ? e.message : e}. ` +
          NOT_INSTALLED,
      );
    }
  }
  await (opts.record ?? recordSharedUse)(
    { exe: opts.installed, version, slug, pending: true },
    { warn: opts.log },
  );
}
