// The mutation ledger cannot rot between runs of the gate that uses it.
//
// `deno task check:mutations` breaks each load-bearing invariant on purpose
// and requires a named test to notice. It takes ~30 s, so it is a gate rather
// than a suite member — which leaves a gap: an entry whose enforcing line was
// reworded, or whose test was renamed, quietly stops mutating anything, and
// the gate keeps reporting a kill it never performed.
//
// So the STRUCTURE of the ledger is checked here, in milliseconds, on every
// `deno task test`:
//
//   • the enforcing line still exists, verbatim, exactly once in its file
//   • the mutation actually changes something
//   • the named test file exists and still declares a test by that name
//
// The behaviour — does the test go RED — stays with the gate. This is the
// tripwire that says the gate's questions are still being asked.
import { assertEquals } from "@std/assert";
import {
  LEDGER,
  type Mutation,
  rowOses,
  rowsForHost,
} from "../scripts/check-mutations.ts";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every test name declared in a file: `Deno.test("…"`, the object form's
 *  `name: "…"`, and template literals — a name built as
 *  `` `persist (${mode}): …` `` is one `--filter` can still match, so a
 *  `${…}` hole is treated as "anything". */
function declares(src: string, filter: string): boolean {
  const decls = [
    ...src.matchAll(/Deno\.test\(\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
    ...src.matchAll(/\bname:\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
    // `testCell(cell, "name", …)` — the runtime name is `[cellId] name`, and
    // `--filter` matches substrings, so the literal is what a row names.
    ...src.matchAll(/\btestCell\([^,]+,\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
    // `testUI(Component, "name", …)` — same shape, same substring match.
    ...src.matchAll(/\btestUI\(\s*[^,]+,\s*(["'`])((?:[^\\]|\\.)*?)\1/g),
  ];
  return decls.some(([, , name]) => {
    const re = "^" + (name ?? "").split(/\$\{[^}]*\}/)
      .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^`]*") +
      "$";
    return new RegExp(re).test(filter);
  });
}

Deno.test("mutation ledger: every enforcing line still exists, exactly once", async () => {
  const bad: string[] = [];
  for (const m of LEDGER) {
    let src: string;
    try {
      src = await Deno.readTextFile(`${ROOT}${m.file}`);
    } catch {
      bad.push(`${m.what}\n     ${m.file} does not exist any more`);
      continue;
    }
    const n = src.split(m.find).length - 1;
    if (n !== 1) {
      bad.push(
        `${m.what}\n     ${m.file}: the enforcing line occurs ${n} times ` +
          `(must be exactly 1) — it moved or was reworded, so the gate has ` +
          `been mutating nothing. Re-copy it verbatim:\n       ${
            m.find.trim().slice(0, 90)
          }`,
      );
    }
    if (m.replace === m.find) {
      bad.push(
        `${m.what}\n     ${m.file}: \`replace\` is identical to \`find\``,
      );
    }
  }
  assertEquals(bad, [], `\n  ${bad.join("\n\n  ")}\n`);
});

Deno.test("mutation ledger: every named test still exists", async () => {
  const bad: string[] = [];
  const cache = new Map<string, string | null>();
  for (const m of LEDGER) {
    if (!cache.has(m.test)) {
      cache.set(
        m.test,
        await Deno.readTextFile(`${ROOT}${m.test}`).catch(() => null),
      );
    }
    const src = cache.get(m.test);
    if (src === null) {
      bad.push(`${m.what}\n     ${m.test} does not exist any more`);
      continue;
    }
    if (!declares(src!, m.filter)) {
      bad.push(
        `${m.what}\n     ${m.test} no longer declares a test named ` +
          `"${m.filter}" — \`--filter\` would match nothing and the gate ` +
          `would report a kill it never made.`,
      );
    }
  }
  assertEquals(bad, [], `\n  ${bad.join("\n\n  ")}\n`);
});

Deno.test("mutation ledger: an invariant is described by what it costs", () => {
  // The `what` is the whole output of a failure: the reviewer reads it and
  // decides how alarmed to be. "sha256 check" is not a cost; "a tampered zip
  // runs as the user's desktop app" is.
  const thin = LEDGER.filter((m) => m.what.trim().split(/\s+/).length < 8);
  assertEquals(
    thin.map((m) => `${m.file}: ${m.what}`),
    [],
    "each entry's `what` must say what a silent regression COSTS, in a " +
      "sentence — not name the mechanism",
  );
});

// A row tagged with an OS guards an invariant only that OS's build has: its
// test is `ignore`d anywhere else, where the baseline would say "did not
// run". Every other host leaves the row out and COUNTS it — a skipped row is
// never a guarded one — and `--os-only` runs exactly the tagged rows there.
Deno.test("mutation ledger: a row for another OS is left out and counted; --os-only keeps this OS's rows", () => {
  const row = (what: string, os?: Mutation["os"]) =>
    ({ what, os }) as unknown as Mutation;
  const ledger = [row("any"), row("win", "windows"), row("mac", "darwin")];
  const names = (r: { rows: Mutation[] }) => r.rows.map((m) => m.what);
  const linux = rowsForHost(ledger, "linux", false);
  assertEquals([names(linux), linux.elsewhere], [["any"], 2]);
  const win = rowsForHost(ledger, "windows", false);
  assertEquals([names(win), win.elsewhere], [["any", "win"], 1]);
  const only = rowsForHost(ledger, "windows", true);
  assertEquals([names(only), only.elsewhere], [["win"], 1]);
  assertEquals(rowsForHost(ledger, "linux", true).rows, []);
  // A row several OSes check: run by each of them, left out by the rest, and
  // never an `--os-only` row — another host checks it too.
  const posix = [row("posix", ["linux", "darwin"]), row("win", "windows")];
  assertEquals(names(rowsForHost(posix, "darwin", false)), ["posix"]);
  assertEquals(rowsForHost(posix, "windows", false).elsewhere, 1);
  assertEquals(rowsForHost(posix, "linux", true).rows, []);
});

// WHERE a row's test runs is not written by hand, and not read off the source
// either: an `ignore` is an expression over constants, helpers and row tables
// (`!LINUX`, `noPty`, a loop over specs). Each gated test file is LOADED as
// each OS would load it (scripts/mutations/record-tests.ts registers, runs
// nothing), and a row whose test some OS ignores must be tagged — for none of
// the OSes that ignore it.
//
// Untagged, such a row cannot be checked there: the ledger on Windows named
// 15 rows in 58 as "did not run".
const OSES = ["darwin", "linux", "windows"] as const;
/** Files that cannot be LOADED as another OS, and why — their rows are taken
 *  to run there. A file not listed that fails to load is a failure. */
const LOADS_ONLY_AT_HOME: Record<string, string> = {
  "tests/local-peer.test.ts":
    "opens the C library of the OS it is told it runs on, at load",
  "tests/windows-sfx-stub-run.test.ts":
    "asks Windows PowerShell, at load, whether anybody can see a window",
};

/** `if (Deno.build.os === "windows") return;` as the first statement of the
 *  test a name declares (behind comments, or the umask wrapper). */
const EARLY_RETURN =
  /^[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*(?:permissiveUmask\(async \(\) => \{\n\s*)?if \(Deno\.build\.os (===|!==) "(\w+)"\) return;/;

type Registered = { file: string; name: string; ignore: boolean };
async function registered(
  os: (typeof OSES)[number],
  files: string[],
  env: Record<string, string>,
  scratch: string,
): Promise<Registered[]> {
  await Deno.mkdir(scratch, { recursive: true });
  const out = join(scratch, `${os}.jsonl`);
  await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "-A",
      "--no-check",
      "--parallel",
      "--preload=scripts/mutations/record-tests.ts",
      ...files,
    ],
    cwd: ROOT,
    env: {
      ...env,
      AIO_RECORD_TESTS: out,
      // Its own OS is read as it is: a faked one answers the same.
      ...(os === Deno.build.os ? {} : { AIO_RECORD_OS: os }),
      AIO_TEST_ROOT: join(scratch, os),
    },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  const text = await Deno.readTextFile(out).catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

Deno.test("mutation ledger: no row is run on an OS that ignores its test — the row's tag says where it runs", async () => {
  const src = (f: string) => {
    try {
      return Deno.readTextFileSync(`${ROOT}${f}`);
    } catch {
      return ""; // aio-ok: a missing file is the test above's to name
    }
  };
  // No `ignore` in the file: nothing in it can be gated. A row's `env` opens
  // its lane (a packaged AppImage is ignored without it, and Linux's with).
  const gated = LEDGER.filter((m) =>
    /\bignore\b|Deno\.build\.os [!=]== "\w+"\) return;/.test(src(m.test))
  );
  const lanes = Map.groupBy(gated, (m) => JSON.stringify(m.env ?? {}));
  const bad: string[] = [];
  const scratch = await tempDir("ledger-os-");
  try {
    await Promise.all([...lanes].map(async ([env, rows], lane) => {
      const files = [...new Set(rows.map((m) => m.test))];
      const seen = await Promise.all(
        OSES.map((os) =>
          registered(os, files, JSON.parse(env), join(scratch, String(lane)))
        ),
      );
      for (const m of rows) {
        const url = toFileUrl(`${ROOT}${m.test}`).href;
        const runs: string[] = [];
        const ignored: string[] = [];
        OSES.forEach((os, i) => {
          const mine = seen[i]!.filter((r) =>
            r.file === url && r.name.includes(m.filter)
          );
          if (mine.length === 0) {
            if (os !== Deno.build.os && LOADS_ONLY_AT_HOME[m.test]) {
              runs.push(os);
            } else {
              bad.push(`${m.test} :: ${m.filter} — not registered as ${os}`);
            }
          } else (mine.every((r) => r.ignore) ? ignored : runs).push(os);
        });
        // …and a test whose first statement returns on an OS does not run
        // there either, whatever its `ok` says.
        const early = EARLY_RETURN.exec(
          src(m.test).slice(src(m.test).indexOf(m.filter)),
        );
        for (const os of early ? OSES : []) {
          if ((os === early![2]) !== (early![1] === "===")) continue;
          if (runs.includes(os)) {
            ignored.push(runs.splice(runs.indexOf(os), 1)[0]!);
          }
        }
        // Ignored everywhere: a tool this host lacks — no OS's matter.
        if (runs.length === 0 || ignored.length === 0) continue;
        // Tagged, and for no OS that ignores the test. (Narrower than where
        // the test runs is the row's to say: an invariant about POSIX mode
        // bits has nothing to break on Windows, though its test runs there.)
        const tag = rowOses(m);
        if (tag.length > 0 && !tag.some((os) => ignored.includes(os))) continue;
        bad.push(
          `${m.test} :: ${m.filter}\n     runs on ${runs.join(", ")}, ` +
            `ignored on ${ignored.join(", ")}: the row needs \`os: ${
              JSON.stringify(runs.length === 1 ? runs[0] : runs)
            }\``,
        );
      }
    }));
  } finally {
    await dropTempDir(scratch);
  }
  assertEquals(bad, [], `\n  ${bad.join("\n\n  ")}\n`);
});
