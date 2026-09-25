// The framework's most-seen refusal told you to run a command that fails.
//
// Two apps colliding on an appId print "Already running: <id> … Stop it:
// `am stop <id>`". But `stop`'s positional argument is a COMPONENT label
// (deno.json → build.targets), so in the ordinary single-app project that
// command answers
//
//   this project declares no components, so "<id>" names nothing
//
// and the app keeps running. MEASURED against a live example app: exit 1, the
// process still up. `--app=` is the flag that targets an app by id, and it
// works from ANY directory — measured from /tmp: exit 0, stopped.
//
// An error message is a promise; this one could not be kept.
import { assert, assertStringIncludes } from "@std/assert";
import { _alreadyRunningMessage } from "../src/server/aio-run-helpers.ts";

Deno.test("the already-running refusal names a stop command that works", () => {
  const msg = _alreadyRunningMessage({
    appId: "ex-counter",
    port: 64529,
    pid: 4162334,
    home: "/home/u/.ex-counter",
    takeover: false,
  });
  assertStringIncludes(msg, "am stop --app=ex-counter");
  // …and NOT the positional form, which names a component, not an app
  assert(
    !/am stop ex-counter/.test(msg),
    `the refusal still advises the positional form:\n${msg}`,
  );
});

// …and nowhere else in the source may advise it either. `am stop <label>` with
// a REAL component label is legitimate; interpolating an APP ID into that slot
// is the mistake, and it is mechanically visible.
Deno.test("no source advises `am stop <appId>` with an app id", async () => {
  const roots = ["src", "docs"];
  const offenders: string[] = [];
  let scanned = 0;
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        await walk(p);
        continue;
      }
      if (!/\.(ts|tsx|md)$/.test(e.name)) continue;
      scanned++;
      const text = await Deno.readTextFile(p);
      text.split("\n").forEach((l, i) => {
        // `am stop ${…}` — an interpolated value in the component slot is an
        // app id every time; a literal label (am stop web) is fine.
        // `targetArgs(…)` (src/am/am-cmd-data.ts) always starts with `--app=`.
        if (
          /am stop \$\{/.test(l) && !/--app=/.test(l) &&
          !/am stop \$\{targetArgs\(/.test(l)
        ) {
          offenders.push(`${p}:${i + 1}  ${l.trim().slice(0, 100)}`);
        }
      });
    }
  }
  for (const r of roots) await walk(r);
  // VERIFY THE INSTRUMENT: a walk that read nothing would pass vacuously.
  assert(scanned > 100, `only ${scanned} files scanned — the walk broke`);
  assert(
    offenders.length === 0,
    `these advise \`am stop <appId>\`, which names a COMPONENT and fails in a ` +
      `single-app project — use \`am stop --app=<id>\`:\n${
        offenders.join("\n")
      }`,
  );
});
