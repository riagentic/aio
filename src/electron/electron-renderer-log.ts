// What the Electron child says on stderr, sorted into what the framework log
// must carry — PURE, so "which lines are dropped and which are forwarded" is
// a unit test rather than a claim.
//
// Two facts this file answers, one per direction:
//
//   1. RENDERER → LOG. A page that throws before it paints used to be invisible.
//      A field report (a desktop wallet, 35 cells, packaged as an AppImage)
//      started, served, logged `errors=0`, and showed NOTHING — the renderer had
//      thrown `ReferenceError: Buffer is not defined` at module scope, and not
//      one line reached stdout, `am logs`, or the app log. The generated shell
//      (`tmplRendererDiagnostics`) now writes every renderer error, warning,
//      crash and the page's own mount signal to its stderr as
//      `[aio:renderer:<level>] …`; the Deno parent reads that stream (it
//      already did, to drop GPU-probe noise) and routes each line to the
//      framework logger at the matching level. `am logs` then shows the throw.
//
//   2. NOISE → DROPPED, NARROWLY. On a multi-GPU Linux box Mesa walks every
//      DRM device; a card without a Mesa driver reports `driver (null)` and a
//      KMS dumb-buffer ioctl that only the DRM master (the X server) may make.
//      Chromium moves on to a GPU that works and the app renders — but the
//      wallet's log filled with "Permission denied", which reads like
//      something is wrong with the wallet. Only these exact probe shapes are
//      dropped; anything else Electron writes passes through untouched.

/** Level tag the generated shell puts on a renderer line. */
export type RendererLevel = "info" | "warn" | "error";

/** Where one stderr line from the Electron child goes. */
export type ElectronLineRoute =
  /** GPU device-probe chatter: dropped, counted, reported once. */
  | { route: "drop" }
  /** Anything Electron/Chromium wrote on its own: passed through to stderr. */
  | { route: "raw"; text: string }
  /** A renderer line the shell tagged: framework log at this level. */
  | { route: RendererLevel; text: string };

/** The tag the generated shell writes — ONE spelling, read by `classify`. */
export const RENDERER_TAG = "[aio:renderer:";

const RENDERER_LINE = /^\[aio:renderer:(info|warn|error)\] (.*)$/s;

/** Lines Electron's graphics stack emits while ENUMERATING devices, which say
 *  nothing about the app. Exact shapes only — see the file comment. */
export const GPU_PROBE_NOISE: readonly RegExp[] = [
  /^KMS: DRM_IOCTL_MODE_CREATE_DUMB failed/,
  /^pci id for fd \d+:/,
  /^MESA-LOADER: failed to (open|retrieve)/,
  /^failed to load driver: \w+$/,
];

/** Sort one line of the Electron child's stderr. Pure. */
export function classifyElectronLine(line: string): ElectronLineRoute {
  const m = RENDERER_LINE.exec(line);
  if (m) return { route: m[1] as RendererLevel, text: m[2]! };
  const t = line.trim();
  if (GPU_PROBE_NOISE.some((re) => re.test(t))) return { route: "drop" };
  return { route: "raw", text: line };
}

/** The one place a renderer line is FORMATTED — the shell's `_rlog` emits
 *  exactly this, so the encoder and the decoder cannot drift. Newlines inside
 *  the message are folded: the parent reads one line at a time. */
// aio-ok: test seam — tests/electron-renderer-log.test.ts pins the exact line shape
export function formatRendererLine(level: RendererLevel, msg: string): string {
  return `${RENDERER_TAG}${level}] ${msg.replace(/\r?\n/g, " ⏎ ")}`;
}

/** The mount line the renderer produces once `#root` has content — the
 *  positive proof a packaged window painted, asserted by the artifact e2e and
 *  the onboarding lab. `n` is the element count under `#root`. */
export const MOUNT_LINE = ["ui mounted ", " element(s)"] as const;
export function mountLine(n: number): string {
  return `${MOUNT_LINE[0]}${n}${MOUNT_LINE[1]}`;
}

/** How long a loaded page may sit with an empty `#root` before the shell says
 *  so at error level. Generous: a large bundle on a slow disk still parses in
 *  well under this; a page that threw at module scope never gets there. */
export const MOUNT_DEADLINE_MS = 15_000;
