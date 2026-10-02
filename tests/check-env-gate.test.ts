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

Deno.test("check:env sees an identifier read through a WRAPPER", () => {
  // `env(CHILD_ENV)` is as much a read as `Deno.env.get(CHILD_ENV)`, but only
  // the accessor form used to be resolved — so `AIO_DEV_SUPERVISED` and
  // `AIO_NO_DEV_RESTART` were read by src/ while the page that promises "every
  // AIO_* variable" omitted them and the gate reported "all named".
  const consts = envConstants(
    new Map([
      [
        "dev.ts",
        `const CHILD_ENV = "AIO_DEV_SUPERVISED";\nconst OPT_OUT_ENV = "AIO_NO_DEV_RESTART";`,
      ],
    ]),
  );
  assertEquals(
    envNamesIn(
      `function env(n: string) { return Deno.env.get(n); }\n` +
        `export const isChild = () => env(CHILD_ENV) === "1";\n` +
        `if (env(OPT_OUT_ENV) === "1") return;`,
      consts,
    ),
    ["AIO_DEV_SUPERVISED", "AIO_NO_DEV_RESTART"],
  );
  // An identifier that resolves to NOTHING stays invisible — it is a dynamic
  // read whose callers pass literals, which rule (a) catches.
  assertEquals(envNamesIn("env(someName)", consts), []);
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

Deno.test("check:env sees a variable named in ANY argument position", () => {
  // `pick("--video", "AIO_VIDEO")` names its variable second. "The first
  // argument only" left `AIO_VIDEO`, `AIO_VIDEO_PACE` and `AIO_VIDEO_SCHEME`
  // (src/testing/ui-video.ts) undocumented while the gate printed ✓.
  assertEquals(envNamesIn(`const path = pick("--video", "AIO_VIDEO");`), [
    "AIO_VIDEO",
  ]);
  assertEquals(envNamesIn(`read(a, b, 'AIO_VIDEO_PACE', c)`), [
    "AIO_VIDEO_PACE",
  ]);
  // Literal after literal: the comma between two is the end of one and the
  // start of the next, and reading it as the first's skipped every other.
  assertEquals(envNamesIn(`f("AIO_A", "AIO_B", "AIO_C")`), [
    "AIO_A",
    "AIO_B",
    "AIO_C",
  ]);
  assertEquals(envNamesIn(`f(x, 'AIO_B', "AIO_C" , "AIO_D",\n  "AIO_E")`), [
    "AIO_B",
    "AIO_C",
    "AIO_D",
    "AIO_E",
  ]);
  // An array of names is read whole — not just what sits between two commas.
  assertEquals(envNamesIn(`const l = ["AIO_X", "AIO_Y", "AIO_Z"];`), [
    "AIO_X",
    "AIO_Y",
    "AIO_Z",
  ]);
  assertEquals(envNamesIn(`for (const k of ['AIO_X', "AIO_Y"]) get(k);`), [
    "AIO_X",
    "AIO_Y",
  ]);
  assertEquals(envNamesIn(`const l = [\n  "AIO_X",\n  "AIO_Y",\n];`), [
    "AIO_X",
    "AIO_Y",
  ]);
  // Still a whole argument only: a message is not a name.
  assertEquals(envNamesIn(`log(a, "AIO_X" + b, "AIO_Y is not set")`), []);
  // …and so is a constant, typed or not.
  const consts = envConstants(
    new Map([
      ["a.ts", `const SCHEME_ENV: string = "AIO_VIDEO_SCHEME";`],
      ["b.ts", `export const PACE_ENV = "AIO_VIDEO_PACE" as const;`],
    ]),
  );
  assertEquals(envNamesIn(`pick("--video-scheme", SCHEME_ENV)`, consts), [
    "AIO_VIDEO_SCHEME",
  ]);
  assertEquals(envNamesIn(`pick(flag, PACE_ENV, fallback)`, consts), [
    "AIO_VIDEO_PACE",
  ]);
  // The whole environment as an object is the same read.
  assertEquals(envNamesIn(`const v = Deno.env.toObject().AIO_VIDEO;`), [
    "AIO_VIDEO",
  ]);
  assertEquals(envNamesIn(`Deno.env.toObject()["AIO_VIDEO"]`), ["AIO_VIDEO"]);
  // Still not prose, and still not a SET: an env object's own key.
  assertEquals(envNamesIn(`spawn(cmd, { env: { AIO_NO_OPEN: "1" } })`), []);
});

Deno.test("check:env: a FIRST argument is a read whatever follows the literal", () => {
  // Seeing later positions must not cost the first one: requiring `,` or `)`
  // right after the literal lost every read that goes on past it.
  assertEquals(envNamesIn(`Deno.env.get("AIO_A" + suffix)`), ["AIO_A"]);
  assertEquals(envNamesIn(`read("AIO_B" as const)`), ["AIO_B"]);
  assertEquals(envNamesIn(`read("AIO_H" ?? fallback)`), ["AIO_H"]);
  assertEquals(envNamesIn(`read( 'AIO_I'\n  , fallback)`), ["AIO_I"]);
  // A LATER position counts only as a whole argument or a whole array
  // element: a comma before a literal is also every list in a message.
  assertEquals(envNamesIn(`const all = [x, "AIO_J" + y, "AIO_K"];`), [
    "AIO_K",
  ]);
  assertEquals(envNamesIn(`pick(flag, "AIO_L" + y)`), []);
  assertEquals(envNamesIn(`pick(flag, "AIO_M")`), ["AIO_M"]);
});

Deno.test("check:env: the video variables are read, and a row deleted from the page is missed", async () => {
  const vars = await readVars();
  for (const name of ["AIO_VIDEO", "AIO_VIDEO_PACE", "AIO_VIDEO_SCHEME"]) {
    assert(vars.has(name), `${name} is read by src/ and was not seen`);
  }
  const page = await Deno.readTextFile(
    new URL("../docs/build/environment.md", import.meta.url),
  );
  assertEquals(missingFrom(vars, page), []);
  // `AIO_VIDEO` must be named as itself: the rows for `AIO_VIDEO_PACE` and
  // `AIO_VIDEO_SCHEME` do not excuse it.
  const without = page.split("\n").filter((l) => !l.startsWith("| `AIO_VIDEO`"))
    .join("\n");
  assertEquals(missingFrom(vars, without).map(([n]) => n), ["AIO_VIDEO"]);
});
