// The lock dir of an apps root is named after the root — and the name is a
// contract between builds.
//
// The name is `aio-` plus the last 48 of the root's ASCII letters and digits.
// An app pinned to an older aio and an `am` (or a second start) on a newer one
// must compute the SAME directory for one root: with two names the lock no
// longer refuses the second start, and `am` says "not running" about a live
// app. A build after 1.0.19 gave a root with a letter of another script
// `<slug>-<hash8>` (and one with no ASCII letter at all `<hash8>`), which is
// exactly that split for every such root. The names below are what 1.0.19
// computes — measured by running its `_lockDirParts` over this table — and
// they are literals so that no build changes them again.
//
// What the name cannot tell apart — two roots that differ only in letters it
// drops, or only before their last 48 characters — is one lock dir. That is
// not silent: the start that loses is told the OTHER root by path, and that
// the two map to one lock folder, instead of "set AIO_APPS_DIR" (which it
// had).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _lockDirParts, lockDir } from "../src/server/single-instance-lock.ts";
import { join, resolve } from "@std/path";
import { _alreadyRunningMessage } from "../src/server/aio-run-helpers.ts";

const scope = (root: string) => _lockDirParts(root).scope;

// root → the scope 1.0.19 gives it.
const V1_0_19: [string, string][] = [
  ["", ""],
  // ASCII
  ["/srv/My Apps/data_1", "-srv-My-Apps-data-1"],
  ["C:\\Users\\dev\\apps", "-C-Users-dev-apps"],
  ["/tmp/aio-test-9f3a/apps", "-tmp-aio-test-9f3a-apps"],
  // long: the last 48 characters
  [
    "/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "-aaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ],
  // mixed scripts: the other script's letters are dropped
  ["/srv/rooté1", "-srv-root-1"],
  ["/srv/rootü1", "-srv-root-1"],
  ["/данные/app1", "-app1"],
  ["/home/josé/приложения/x", "-home-jos-x"],
  ["C:\\Users\\José\\apps", "-C-Users-Jos-apps"],
  [
    "/" + "a".repeat(30) + "/" + "b".repeat(29) + "é",
    "-aaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ],
  // no ASCII letter or digit at all
  ["/данные/один", "-"],
  ["/данные/два", "-"],
  ["/日本語", "-"],
  ["\\\\сервер\\общий", "-"],
  ["/---/", "-"],
];

Deno.test("lock dir scope: every root has the name 1.0.19 gave it", () => {
  for (const [root, want] of V1_0_19) assertEquals(scope(root), want, root);
});

Deno.test("lock dir scope: a start refused by ANOTHER apps root's app is told so, by path", () => {
  // `resolve`: the message names real paths, and on Windows `/srv/…` is one
  // on the current drive.
  const [mine, other] = [resolve("/srv/rootü1"), resolve("/srv/rooté1")];
  assertEquals(scope(mine), scope(other), "one lock dir — the case at hand");
  const msg = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: join(mine, "todo"),
    otherHome: join(other, "todo"),
    appsDir: mine,
    takeover: false,
  });
  assertStringIncludes(
    msg,
    `another AIO_APPS_DIR, ${other}, maps to the same lock folder name`,
  );
  assertStringIncludes(msg, `(${mine})`);
  assertStringIncludes(msg, lockDir());
  assertStringIncludes(msg, "am stop --app=todo");
  assert(
    !msg.includes("AIO_APPS_DIR=<dir>"),
    `it SET the variable — do not tell it to. Got: ${msg}`,
  );
  // The same root on both sides is not this case (a `$HOME`-only split of
  // an app whose root is shared keeps the advice it had).
  const same = _alreadyRunningMessage({
    appId: "todo",
    port: 9010,
    pid: 4242,
    home: "/tmp/sandbox/.todo",
    otherHome: "/home/u/.todo",
    takeover: false,
  });
  assertStringIncludes(same, "AIO_APPS_DIR=<dir>");
});
