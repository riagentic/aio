// durable.ts — fsync a file's bytes, and a directory's entries.
//
// A rename is atomic, not durable: after a power cut the new NAME can be on
// disk while the bytes it names are not (a zero-length file that SQLite opens
// as an empty, perfectly valid database), or the rename itself can be undone
// (the previous file back under the name). The file is synced BEFORE the
// rename, its directory AFTER it.

/** fsync a file's data (`fdatasync`). Throws what the platform throws. */
export async function syncFile(path: string): Promise<void> {
  using f = await Deno.open(path, { read: true, write: true });
  await f.syncData();
}

/** Errors that mean "this filesystem cannot fsync a directory", not "the
 *  data did not reach the disk" — there is nothing more durable to do. */
const NO_DIR_SYNC = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

/** fsync a directory, so a rename or create inside it survives a power cut.
 *
 *  Windows cannot open a directory as a file at all (and NTFS journals the
 *  rename itself), so it is a no-op there; a filesystem that refuses a
 *  directory fsync (`EINVAL`, some network and FUSE mounts) likewise has no
 *  stronger guarantee to give. Any other failure throws. */
export async function syncDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  let f: Deno.FsFile;
  try {
    f = await Deno.open(dir, { read: true });
  } catch (e) {
    if (NO_DIR_SYNC.has((e as { code?: string }).code ?? "")) return;
    throw e;
  }
  try {
    await f.sync();
  } catch (e) {
    if (!NO_DIR_SYNC.has((e as { code?: string }).code ?? "")) throw e;
  } finally {
    f.close();
  }
}
