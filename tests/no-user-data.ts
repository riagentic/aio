/** A user-data folder no OS can create: it sits UNDER this file. A fake
 *  Electron's `app.getPath()` answered `/nonexistent-aio-client-test`, which
 *  Linux refuses (root is not writable) and Windows creates — `C:\…` at the
 *  drive root, left behind by every run. Under a file, mkdir fails on both. */
import { fromFileUrl } from "@std/path";

export const NO_USER_DATA = fromFileUrl(
  new URL("./no-user-data.ts/user-data", import.meta.url),
);
