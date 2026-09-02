// `am report` — the maintainer's side of problem reports, at 7% covered.
//
// It is deliberately thin (a report is plain JSON, so `cat` works too), which
// is exactly why nobody had tested it: there is not much to it, and the little
// there is decides whether a crash bundle can be found and read at all.
//
// Two things here are not cosmetic. `show` matches an id by PREFIX, so an
// ambiguous prefix must refuse rather than pick — silently showing the wrong
// crash is worse than saying "use more of the id". And `show` prints the WHOLE
// document, because a summarized bug report is one that has to be collected
// again.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdReport } from "../src/am/am-cmd-report.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Run = { logs: string[]; errors: string[]; code: number | null };

async function run(
  args: string[],
  app: string,
  opts: { tty?: boolean } = {},
): Promise<Run> {
  const logs: string[] = [], errors: string[] = [];
  const l = console.log, e = console.error, realExit = Deno.exit;
  const realTty = Deno.stdout.isTerminal;
  if (opts.tty) Deno.stdout.isTerminal = () => true;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code: number | null = null;
  try {
    await cmdReport(args, { app } as unknown as GlobalFlags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = realExit;
    Deno.stdout.isTerminal = realTty;
  }
  return { logs, errors, code };
}

const said = (r: Run) => r.logs.join("\n") + "\n" + r.errors.join("\n");

function reportJson(id: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    createdAt: `2026-09-0${
      (id.charCodeAt(id.length - 1) % 9) + 1
    }T10:00:00.000Z`,
    kind: "crash",
    title: "TypeError: x is not a function",
    body: "it fell over when I clicked save",
    app: {
      id: "notes",
      version: "1.2.3",
      aio: "1.0.0",
      build: {},
      target: "browser",
      artifact: "notes-1.2.3",
    },
    ...over,
  });
}

async function withReports(
  ids: string[],
  fn: (app: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "am-report-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", home);
  const app = "notes";
  try {
    const dir = join(appDirs(app).data, "reports");
    await Deno.mkdir(dir, { recursive: true });
    for (const id of ids) {
      await Deno.writeTextFile(join(dir, `${id}.json`), reportJson(id));
    }
    await fn(app);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

Deno.test("am report path: answers where, without needing any to exist", async () => {
  await withReports([], async (app) => {
    const r = await run(["path"], app, { tty: true });
    assertEquals(r.code, null);
    assertStringIncludes(r.logs.join("\n"), "/reports");
  });
});

Deno.test("am report list: nothing yet says how reports get there", async () => {
  await withReports([], async (app) => {
    const human = await run([], app, { tty: true });
    assertStringIncludes(human.logs.join("\n"), "no reports");
    // The reason there are none is the useful part.
    assertStringIncludes(human.logs.join("\n"), "feedback: true");

    const j = JSON.parse((await run([], app)).logs.join("\n")) as {
      count: number;
      reports: unknown[];
    };
    assertEquals(j.count, 0);
    assertEquals(j.reports, []);
  });
});

Deno.test("am report list: newest first, and the id is enough to act on", async () => {
  await withReports(
    ["20260901T100000-aaa", "20260903T100000-bbb"],
    async (app) => {
      const j = JSON.parse((await run(["list"], app)).logs.join("\n")) as {
        count: number;
        reports: { id: string; createdAt: string }[];
      };
      assertEquals(j.count, 2);
      // Sorted by createdAt descending — the one you just got is the one you want.
      assert(
        j.reports[0]!.createdAt > j.reports[1]!.createdAt,
        `not newest-first: ${j.reports.map((r) => r.createdAt).join(", ")}`,
      );

      const human = await run(["list"], app, { tty: true });
      const text = human.logs.join("\n");
      assertStringIncludes(text, "2 reports");
      assertStringIncludes(text, "am report show <id>");
    },
  );
});

Deno.test("am report show: a prefix is enough, and the WHOLE bundle comes back", async () => {
  await withReports(["20260901T100000-aaa"], async (app) => {
    const r = await run(["show", "20260901"], app);
    assertEquals(r.code, null);
    const doc = JSON.parse(r.logs.join("\n")) as Record<string, unknown>;
    // Everything an issue needs, not a summary — a summarized bug report is
    // one that has to be collected again.
    assertEquals(doc.id, "20260901T100000-aaa");
    assertEquals(doc.kind, "crash");
    assertEquals(doc.body, "it fell over when I clicked save");
    assert(doc.app, "the running-version block was dropped");
  });
});

Deno.test("am report show: an ambiguous prefix refuses instead of picking", async () => {
  // Showing the wrong crash silently is worse than asking for more of the id.
  await withReports(
    ["20260901T100000-aaa", "20260901T100000-bbb"],
    async (app) => {
      const r = await run(["show", "20260901"], app);
      assertEquals(r.code, 1);
      const msg = said(r);
      assertStringIncludes(msg, "matches 2");
      assertStringIncludes(msg, "more of the id");
    },
  );
});

Deno.test("am report show: an id that matches nothing names the way to look", async () => {
  await withReports(["20260901T100000-aaa"], async (app) => {
    const r = await run(["show", "nope"], app);
    assertEquals(r.code, 1);
    assertStringIncludes(said(r), "am report list");
  });
});

Deno.test("am report show: with no id at all, it asks for one", async () => {
  await withReports(["20260901T100000-aaa"], async (app) => {
    const r = await run(["show"], app);
    assertEquals(r.code, 1);
    assertStringIncludes(said(r), "needs a report id");
  });
});

Deno.test("am report: an unknown subcommand lists the three that exist", async () => {
  await withReports([], async (app) => {
    const r = await run(["delete", "x"], app);
    assertEquals(r.code, 1);
    const msg = said(r);
    assertStringIncludes(msg, "delete");
    assertStringIncludes(msg, "list");
    assertStringIncludes(msg, "show <id>");
    assertStringIncludes(msg, "path");
  });
});

Deno.test("am report: a half-written report does not hide the others", async () => {
  // A crash mid-write is exactly when a report file gets truncated, and that is
  // exactly the moment the other reports matter most.
  await withReports(["20260901T100000-aaa"], async (app) => {
    const dir = join(appDirs(app).data, "reports");
    await Deno.writeTextFile(join(dir, "truncated.json"), '{"id":"trunc');
    const j = JSON.parse((await run(["list"], app)).logs.join("\n")) as {
      count: number;
    };
    assertEquals(j.count, 1, "a corrupt file took the readable ones with it");
  });
});
