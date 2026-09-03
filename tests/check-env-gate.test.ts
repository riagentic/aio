// The gate that documents environment variables, pointed at its own blind spot.
//
// `check:env` exists because `AIO_BUILD_VERSION` shipped documented nowhere.
// It then matched exactly one spelling — `Deno.env.get("LITERAL")` — while its
// own motivating case is read as `Deno.env.get(BUILD_VERSION_ENV)` in three
// files and `AIO_DISCOVERY_PORT` is read through a `safeEnv(…)` wrapper: you
// could delete either row from the docs and the gate still printed "all
// documented". It also accepted the name on ANY page under `docs/`, while
// `docs/build/environment.md` promises to be the one table with all of them.
//
// A gate nobody verifies is a green light with no bulb, so these tests drive
// the detector directly.
import { assert, assertEquals } from "@std/assert";
import {
  envConstants,
  envNamesIn,
  missingFrom,
  readVars,
} from "../scripts/check-env.ts";

const consts = envConstants(
  new Map([["a.ts", `export const BUILD_VERSION_ENV = "AIO_BUILD_VERSION";`]]),
);

Deno.test("check:env sees a variable read through a constant", () => {
  // The constant is declared in ANOTHER file — which is the real shape.
  assertEquals(
    envNamesIn(`const x = Deno.env.get(BUILD_VERSION_ENV);`, consts),
    ["AIO_BUILD_VERSION"],
  );
  assertEquals(envNamesIn(`Deno.env.has(BUILD_VERSION_ENV)`, consts), [
    "AIO_BUILD_VERSION",
  ]);
});

Deno.test("check:env sees a variable read through a wrapper", () => {
  // Naming the accessors (`Deno.env.get`, `process.env`) is what let these
  // through; an AIO_* literal handed to ANY call is the read.
  assertEquals(envNamesIn(`const raw = safeEnv("AIO_DISCOVERY_PORT");`), [
    "AIO_DISCOVERY_PORT",
  ]);
  assertEquals(envNamesIn(`if (env("AIO_SUPERVISED") === "1") {}`), [
    "AIO_SUPERVISED",
  ]);
  assertEquals(envNamesIn(`Deno.env.get("AIO_PORT")`), ["AIO_PORT"]);
  assertEquals(envNamesIn(`process.env.AIO_PARENT_PID || 0`), [
    "AIO_PARENT_PID",
  ]);
});

Deno.test("check:env does not invent a read out of prose", () => {
  // A doc comment naming a variable in a backtick code span is not a read —
  // a gate that cries about one gets ignored, and then it guards nothing.
  assertEquals(
    envNamesIn(
      " * future move belongs on the versioned ladder (`AIO_DDL_STEPS`)",
    ),
    [],
  );
  assertEquals(envNamesIn(`const AIO_SYMBOLS = ["a"];`), []);
  // An identifier that resolves to nothing is a genuinely dynamic read inside
  // a wrapper — its callers pass the literal, which the rule above catches.
  assertEquals(envNamesIn(`return Deno.env.get(name);`), []);
});

Deno.test("check:env requires THE page, not any page", () => {
  const vars = new Map([["AIO_DISCOVERY_PORT", ["src/server/discovery.ts"]]]);
  assertEquals(
    missingFrom(vars, "…the Electron client discovers apps on 8099."),
    [["AIO_DISCOVERY_PORT", ["src/server/discovery.ts"]]],
    "a variable named on some other doc is still missing from the table",
  );
  assertEquals(missingFrom(vars, "| `AIO_DISCOVERY_PORT` | discovery |"), []);
  // A longer name must not document a shorter one that is its prefix.
  assertEquals(
    missingFrom(new Map([["AIO_DEV", []]]), "| `AIO_DEV_SUPERVISED` | dev |"),
    [["AIO_DEV", []]],
  );
});

Deno.test("check:env: the repo's own motivating case is actually seen", async () => {
  const vars = await readVars(new URL("../", import.meta.url).pathname);
  const at = vars.get("AIO_BUILD_VERSION");
  assert(
    at && at.length >= 2,
    `AIO_BUILD_VERSION is read through BUILD_VERSION_ENV in src/build.ts, ` +
      `src/build/build-say.ts and src/server/app-version.ts — the gate must ` +
      `see those reads, or deleting its row from the docs is invisible. ` +
      `Saw: ${JSON.stringify(at)}`,
  );
  assert(
    vars.get("AIO_DISCOVERY_PORT")?.includes("src/server/discovery.ts"),
    "the safeEnv() wrapper read must be seen too",
  );
});
