// Remove a FIXTURE lock a test wrote with `writePid`/`writeLock` — by key,
// unconditionally. Product code never does this: `removePid` removes only the
// record a command read and judged (compare-and-delete), and with none it
// removes nothing. A test cleaning up its own fixture is the one caller that
// may say "this lock goes", so it says it here, by name.
import { amLockKey, resolveAmAppId } from "../src/am/am-utils.ts";
import { removeLock } from "../src/server/single-instance-lock.ts";

export function dropFixtureLock(appId?: string): void {
  removeLock(amLockKey(appId ?? resolveAmAppId()));
}
