/** Electron fuses: switches compiled into the Electron binary that turn a
 *  feature off for good, whatever the environment or the command line says.
 *
 *  aio already scrubs `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` and refuses
 *  `--inspect` when IT launches Electron (electron-spawn.ts). The shipped
 *  runtime could still be started directly, around aio: as plain Node, with
 *  code injected through `NODE_OPTIONS`, or with a debugger on the main
 *  process. The fuses close those doors inside the binary itself.
 *
 *  The wire (Electron's `FuseV1`, measured on 44.x for linux, win32 and
 *  darwin): the sentinel below, one version byte (1), one count byte, then one
 *  ASCII byte per fuse — `0` off, `1` on, `r` removed. The binary that carries
 *  it is `electron` / `electron.exe`, and on macOS the `Electron Framework`
 *  (NOT `Contents/MacOS/Electron`). Changing it invalidates a macOS code
 *  signature; the `.app` is re-signed after assembly anyway. */
import { join } from "@std/path";

export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";

/** FuseV1Options index → the Electron name of each fuse aio turns OFF. */
export const FUSES_OFF: Readonly<Record<number, string>> = {
  0: "RunAsNode",
  2: "EnableNodeOptionsEnvironmentVariable",
  3: "EnableNodeCliInspectArguments",
};

const SENTINEL = new TextEncoder().encode(FUSE_SENTINEL);
const OFF = 0x30; // "0"

function find(bytes: Uint8Array, from: number): number {
  outer: for (
    let i = bytes.indexOf(SENTINEL[0]!, from);
    i >= 0;
    i = bytes.indexOf(SENTINEL[0]!, i + 1)
  ) {
    for (let j = 1; j < SENTINEL.length; j++) {
      if (bytes[i + j] !== SENTINEL[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Offset of the first fuse byte. Throws — never guesses — when the wire is
 *  missing, doubled, of another version, or too short to hold aio's fuses. */
export function fuseOffset(bytes: Uint8Array, what = "the binary"): number {
  const at = find(bytes, 0);
  if (at < 0) throw new Error(`${what} has no Electron fuse wire`);
  if (find(bytes, at + 1) >= 0) {
    throw new Error(`${what} has two Electron fuse wires — refusing to guess`);
  }
  const version = bytes[at + SENTINEL.length];
  const count = bytes[at + SENTINEL.length + 1] ?? 0;
  if (version !== 1) {
    throw new Error(`${what}: Electron fuse wire version ${version}, not 1`);
  }
  const need = Math.max(...Object.keys(FUSES_OFF).map(Number)) + 1;
  if (count < need) {
    throw new Error(`${what}: ${count} Electron fuses, aio needs ${need}`);
  }
  return at + SENTINEL.length + 2;
}

/** Are all of aio's fuses off? */
export function fusesAreOff(bytes: Uint8Array, what?: string): boolean {
  const at = fuseOffset(bytes, what);
  return Object.keys(FUSES_OFF).every((i) => bytes[at + Number(i)] === OFF);
}

/** Turn aio's fuses off in `bytes`, in place. Pure but for the buffer. */
export function turnFusesOff(bytes: Uint8Array, what?: string): void {
  const at = fuseOffset(bytes, what);
  for (const i of Object.keys(FUSES_OFF)) bytes[at + Number(i)] = OFF;
}

/** The file that carries the fuse wire in an Electron dist directory. */
export function electronFuseBinary(dir: string, os: string): string {
  switch (os) {
    case "darwin":
      return join(
        dir,
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "A",
        "Electron Framework",
      );
    case "windows":
      return join(dir, "electron.exe");
    default:
      return join(dir, "electron");
  }
}

/** Turn aio's fuses off in the file at `path`. Written beside it and renamed
 *  over it, so a link to a shared copy is replaced rather than written
 *  through, and a crash never leaves half a binary. Keeps the file's mode. */
export async function fuseElectronFile(path: string): Promise<void> {
  const bytes = await Deno.readFile(path);
  if (fusesAreOff(bytes, path)) return;
  turnFusesOff(bytes, path);
  const { mode } = await Deno.stat(path);
  const tmp = `${path}.fusing`;
  await Deno.writeFile(tmp, bytes, mode === null ? {} : { mode });
  await Deno.rename(tmp, path);
}
