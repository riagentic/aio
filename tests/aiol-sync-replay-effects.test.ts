// aiol rule 25b — a side effect in a reducer that REPLAYS, so it happens twice.
//
// A sync method IS the reducer, and under `sync:` / `localFirst` /
// `scope: "client"` the same function also runs in the browser as an optimistic
// replay. Mutating `s` is the point — the server's answer supersedes it.
// Anything else in that body runs once on the client and once on the server.
//
// Field report: "do not `sync:` a cell whose reducer has an observer or
// dispatch side effect — ours would have double-logged every toast into the
// event log". Statically decidable from the cell definition, which is why it is
// a rule and not a paragraph.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSyncReplayEffects } from "../aiol/checks.ts";

async function issues(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkSyncReplayEffects(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const TOASTS = `import { cell } from "aio";
export const toasts = cell("toasts", {
  state: { items: [] as string[] },
  methods: { add(s: { items: string[] }, t: string) { s.items = [...s.items, t]; } },
});
`;

Deno.test("aiol: a replaying reducer dispatching to ANOTHER cell is an error", async () => {
  const found = await issues({
    "src/toasts.ts": TOASTS,
    "src/notes.ts": `import { cell } from "aio";
import { toasts } from "./toasts.ts";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  sync: true,
  methods: {
    add(s: { items: string[] }, t: string) {
      s.items = [...s.items, t];
      toasts.add("added");
    },
  },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assert(i.message.includes("toasts.add()"), i.message);
  assert(i.message.includes("REPLAYS on the client"), i.message);
  assert(i.message.includes("happens twice"), i.message);
  assert(i.message.includes("$do"), "names the fix");
});

Deno.test("aiol: an observer in a replaying reducer is flagged too", async () => {
  const found = await issues({
    "src/notes.ts": `import { cell, log } from "aio";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  sync: true,
  methods: {
    add(s: { items: string[] }, t: string) {
      log.info("added " + t);
      s.items = [...s.items, t];
    },
  },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  assert(
    found[0]!.message.includes("two entries per action"),
    found[0]!.message,
  );
});

Deno.test("aiol: the same reducer on a NON-replaying cell is fine", async () => {
  // The rule is about replay, not about reducers. A server-only cell's reducer
  // runs exactly once, and flagging it would be flagging ordinary code — which
  // is how a rule teaches people to ignore it.
  assertEquals(
    await issues({
      "src/toasts.ts": TOASTS,
      "src/notes.ts": `import { cell } from "aio";
import { toasts } from "./toasts.ts";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  methods: {
    add(s: { items: string[] }, t: string) {
      s.items = [...s.items, t];
      toasts.add("added");
    },
  },
});
`,
    }),
    [],
  );
});

Deno.test("aiol: `$do` and nested callbacks are exempt — a replay swallows them", async () => {
  // The exemptions are what make an ERROR safe here. An effect handed to $do
  // already runs only on the server, and a callback given to a scheduler is not
  // this method's body.
  assertEquals(
    await issues({
      "src/toasts.ts": TOASTS,
      "src/notes.ts": `import { cell } from "aio";
import { toasts } from "./toasts.ts";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  sync: true,
  methods: {
    add(s: { items: string[]; $do: (f: () => void) => void }, t: string) {
      s.items = [...s.items, t];
      s.$do(() => toasts.add("added"));
    },
  },
});
`,
    }),
    [],
  );
});

Deno.test("aiol: a SELF call is checkSelfMethodCall's subject, not this rule's", async () => {
  // Two rules reporting one line is how a lint run becomes noise. This one
  // owns cross-cell dispatch; the self-call trap has its own rule and its own
  // (different) explanation.
  assertEquals(
    await issues({
      "src/notes.ts": `import { cell } from "aio";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  sync: true,
  methods: {
    add(s: { items: string[] }, t: string) { s.items = [...s.items, t]; },
    addTwo(s: { items: string[] }) { notes.add("a"); notes.add("b"); },
  },
});
`,
    }),
    [],
  );
});

Deno.test("aiol: an ASYNC method of a sync cell never replays", async () => {
  // Async methods do not replay — their outcome arrives from the server. So
  // the same call in an async body is correct code.
  assertEquals(
    await issues({
      "src/toasts.ts": TOASTS,
      "src/notes.ts": `import { cell } from "aio";
import { toasts } from "./toasts.ts";
export const notes = cell("notes", {
  state: { items: [] as string[] },
  sync: true,
  methods: {
    async add(s: { items: string[] }, t: string) {
      s.items = [...s.items, t];
      await toasts.add("added");
    },
  },
});
`,
    }),
    [],
  );
});
