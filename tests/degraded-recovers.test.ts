// A `degraded()` tracker that can only ever fail is a false alarm with no end.
//
// `degraded(name)` counts CONSECUTIVE failures and escalates to
// `/__aio/health` on the fifth. Its own contract says so in the type:
// "Record a success — ends the episode (and reports recovery if it had
// escalated). Call it on every success, not only the first."
//
// Four call sites in src/ called `fail()` and never `ok()`. Measured on one of
// them: five dropped log lines spread across a session, each followed by a
// hundred successful sends and ten thousand more afterwards, left the client
// reporting degraded for the life of the page. Another let six unauthenticated
// WebSocket frames mark the whole app degraded permanently — the endpoint a
// readiness probe, a load balancer, `am` and amui all read. And the UDS
// broadcaster had always got it right (`if (failed.length === 0)
// _broadcastRound.ok()`) while the WebSocket one beside it had no `ok()` at
// all, which is precisely the two-transports-two-answers drift that
// `uds.ts`'s own header warns about.
//
// So this is the pair rule, checked structurally: every tracker that can fail
// must be able to recover. It reads source, because the alternative is
// booting every subsystem and provoking each failure.
import { assertEquals } from "@std/assert";

const ROOT = new URL("../src/", import.meta.url).pathname;

/** Every `.ts` under src/. */
async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory) await sources(`${p}/`, out);
    else if (e.isFile && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Blank out comments and string bodies.
 *
 *  Without this the scan reads its own PROSE: the comment beside the fix in
 *  `server-broadcast.ts` names `_broadcastRound.ok()`, and that alone was
 *  enough to make the gate report the tracker as recovering when the call had
 *  been deleted. Which is the very bug class this round has been closing —
 *  `check:vacuous`'s typeof rule and two aiol rules all ran a predicate over
 *  the wrong copy of the text. A gate that reads comments cannot fail. */
function code(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const skipped = src.slice(i, end === -1 ? src.length : end + 2);
      out += skipped.replace(/[^\n]/g, " ");
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

/** The tracker names this file fails, and the ones it recovers.
 *
 *  Both spellings count: `degraded("x").fail(e)` inline, and the captured
 *  handle (`const _round = degraded("x")` … `_round.fail(e)`), which is what
 *  the broadcasters use. */
function trackers(raw: string): { fails: Set<string>; oks: Set<string> } {
  // Names live INSIDE string literals, so the var map reads the raw text; the
  // call sites are code, so they read the stripped copy.
  const src = raw;
  const calls = code(raw);
  const byVar = new Map<string, string>();
  for (
    const m of src.matchAll(
      /\b(?:const|let)\s+(\w+)\s*=\s*degraded\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) byVar.set(m[1]!, m[2]!);

  const fails = new Set<string>();
  const oks = new Set<string>();
  const add = (set: Set<string>, name: string | undefined) => {
    if (name) set.add(name);
  };
  for (
    const m of src.matchAll(
      /\bdegraded\(\s*["'`]([^"'`]+)["'`]\s*(?:,[^)]*)?\)\s*\.\s*(fail|ok)\b/g,
    )
  ) add(m[2] === "ok" ? oks : fails, m[1]);
  for (const m of calls.matchAll(/\b(\w+)\s*\.\s*(fail|ok)\s*\(/g)) {
    const name = byVar.get(m[1]!);
    if (name) add(m[2] === "ok" ? oks : fails, name);
  }
  return { fails, oks };
}

Deno.test("every degraded() tracker that can fail can also recover", async () => {
  const files = await sources(ROOT);
  // Across the WHOLE of src/, not per file: a tracker may legitimately fail in
  // one module and recover in another (the name is the identity, not the
  // file).
  const fails = new Map<string, string>(); // name → first file that fails it
  const oks = new Set<string>();
  for (const f of files) {
    const src = await Deno.readTextFile(f);
    const t = trackers(src);
    for (const n of t.fails) {
      if (!fails.has(n)) fails.set(n, f.slice(ROOT.length));
    }
    for (const n of t.oks) oks.add(n);
  }
  const stuck = [...fails].filter(([n]) => !oks.has(n)).map(([n, f]) =>
    `  degraded(${JSON.stringify(n)}) — fails in src/${f}, recovers nowhere`
  );
  assertEquals(
    stuck,
    [],
    `a tracker that never calls ok() escalates once and stays escalated for ` +
      `the life of the process, however much works afterwards:\n` +
      `${stuck.join("\n")}\n` +
      `  fix: call .ok() on the success path, as degraded()'s own contract ` +
      `says ("call it on every success, not only the first").`,
  );
});

Deno.test("the scan finds the trackers it is supposed to find", async () => {
  // The gate above is only worth having if it can SEE a tracker. A scan that
  // matched nothing would be green for the same reason a broken regex is.
  const files = await sources(ROOT);
  let names = 0;
  for (const f of files) {
    const t = trackers(await Deno.readTextFile(f));
    names += t.fails.size;
  }
  assertEquals(
    names > 5,
    true,
    `the scan found only ${names} failing trackers — it has stopped matching ` +
      `the call shapes in src/, so the gate above proves nothing`,
  );
});
