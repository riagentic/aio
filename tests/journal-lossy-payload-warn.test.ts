// A journalled action whose arguments JSON cannot round-trip is SAID, once
// per action type (src/server/journal.ts).
//
// Replay re-reduces the payload parsed back from JSON. A server-side call
// `m.setDefault(undefined, 1)` ran with the parameter default ("dflt") but
// replayed with `null`; a Date replayed as a string, NaN as null, `{k:
// undefined}` as `{}` — a DIFFERENT state rebuilt after a crash, reported only
// as "journal: recovered 6 actions". The line format is unchanged: this is a
// warning, identical in dev and prod, never a refusal.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { makeRedactor } from "../src/diagnostics/redact.ts";
import { createJournal, parseJournal } from "../src/server/journal.ts";

async function capture(fn: () => void | Promise<void>): Promise<string[]> {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  const cap = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.warn = cap;
  console.error = cap;
  console.log = cap;
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return out.filter((l) => l.includes("JSON cannot round-trip"));
}

const uniq = () => crypto.randomUUID().slice(0, 8);

Deno.test("journal: lossy arguments are named — undefined (defaults), Date, NaN, undefined keys", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-lossy-" });
  try {
    const j = createJournal(join(dir, "journal"));
    const t = `jr${uniq()}`;
    const warned = await capture(() => {
      j.append({
        type: `${t}:setDefault`,
        payload: { args: [undefined, 1] },
      }, 1);
      j.append({ type: `${t}:setWhen`, payload: { args: [new Date(0)] } }, 1);
      j.append({ type: `${t}:setNan`, payload: { args: [NaN] } }, 1);
      j.append(
        { type: `${t}:setKey`, payload: { args: [{ k: undefined }] } },
        1,
      );
    });
    assertEquals(warned.length, 4, warned.join("\n---\n"));
    const all = warned.join("\n");
    assert(all.includes(`"${t}:setDefault"`), all);
    assert(
      all.includes(
        "argument 1: undefined — on replay: null — so the parameter's default does NOT apply",
      ),
      all,
    );
    assert(all.includes("argument 1: Date — on replay: an ISO string"), all);
    assert(all.includes("argument 1: NaN — on replay: null"), all);
    assert(all.includes("argument 1 (k): undefined"), all);

    // …and the file still holds exactly what it always held.
    const entries = parseJournal(await Deno.readTextFile(join(dir, "journal")));
    assertEquals(entries.map((e) => e.payload), [
      { args: [null, 1] },
      { args: ["1970-01-01T00:00:00.000Z"] },
      { args: [null] },
      { args: [{}] },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: said once per action type; JSON-shaped and redacted payloads say nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-lossy-" });
  try {
    const t = `jr${uniq()}`;
    const j = createJournal(join(dir, "journal"), {
      redact: makeRedactor([`${t}:secret`]),
    });
    const warned = await capture(() => {
      j.append({ type: `${t}:when`, payload: { args: [new Date(1)] } }, 1);
      j.append({ type: `${t}:when`, payload: { args: [new Date(2)] } }, 1);
      j.append({ type: `${t}:plain`, payload: { args: ["a", 1, null] } }, 1);
      j.append({ type: `${t}:none`, payload: { args: [] } }, 1);
      // redacted: the payload never reaches the file, so nothing to replay
      j.append({ type: `${t}:secret`, payload: { args: [new Date(3)] } }, 1);
    });
    assertEquals(warned.length, 1, warned.join("\n---\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: undefined that replays as the same value says nothing — a delete's record, a missing payload", async () => {
  // field report §7: aio's own record of `delete s.optimistic[k]` and a no-argument
  // call were each reported as "rebuild a different state".
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-lossy-" });
  try {
    const t = `jr${uniq()}`;
    const j = createJournal(join(dir, "journal"));
    const warned = await capture(() => {
      j.append({
        type: `${t}:__setRefresh`,
        payload: {
          mutations: [
            { path: ["optimistic", "a"], value: undefined, op: "delete" },
            { path: ["x"], value: undefined },
          ],
        },
      }, 1);
      j.append({ type: `${t}:checkAvailability`, payload: undefined }, 1);
      // …while an undefined PROPERTY inside a written value still is lossy
      // (`in`, Object.keys and a spread over defaults all see the difference).
      j.append({
        type: `${t}:__setOther`,
        payload: { mutations: [{ path: ["o"], value: { k: undefined } }] },
      }, 1);
    });
    assertEquals(warned.length, 1, warned.join("\n---\n"));
    assert(warned[0]!.includes(`"${t}:__setOther"`), warned[0]);
    assert(warned[0]!.includes("payload.mutations.0.value.k"), warned[0]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
