// `am create` as a first-hour user meets it — the scaffold's own commands
// must be commands that work, and its report must say what it did.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  cmdCreate,
  type GitInit,
  gitSentence,
  parseCreateArgs,
  scaffold,
} from "../src/am/am-cmd-create.ts";
import { entryTaskWords } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { AIO_ENTRY_PATHS } from "../src/entries.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";
import { h } from "../src/air/vdom.ts";
import type { ComponentFn } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const files = scaffold("demo", "counter", true);

/** This machine's REAL module cache, resolved BEFORE any child is handed a
 *  fake `$HOME`.
 *
 *  `DENO_DIR` defaults to `$HOME/.cache/deno`, so a child given an isolated
 *  HOME (which the two scaffold-boot cases below need, to keep the lock dir
 *  and `~/.<appId>` off the real one) silently gets an isolated MODULE cache
 *  as well — and re-downloads the whole JSR graph from the network on every
 *  run. It cost `am start` its ten-second boot window under load:
 *
 *    {"error":"still starting after 10s (pid … alive, no port yet)"}
 *    Download https://jsr.io/@std/path/1.1.3/mod.ts
 *    … 60 more
 *
 *  which reads as "the cli scaffold does not boot" and is nothing of the
 *  kind. The app under test is the one on disk, never the network — same
 *  reasoning, same spelling as `REAL_DENO_DIR` in tests/seam-paths.test.ts
 *  and `denoDir()` in tests/version-query.test.ts. */
const REAL_DENO_DIR = Deno.env.get("DENO_DIR") ??
  join(Deno.env.get("HOME") ?? "/tmp", ".cache", "deno");

Deno.test("scaffold .gitignore ignores .env (the README promises it) but not .env.example", () => {
  const lines = files[".gitignore"]!.split("\n");
  assert(lines.includes(".env"), ".env must be ignored");
  assert(lines.includes("!.env.example"), ".env.example stays committed");
  assertStringIncludes(files["README.md"]!, "`.env`");
});

// The name of this test used to say the buttons surface as
// "MinusButton"/"PlusButton", and it asserted only that the TSX contains the
// `t=` attributes — so the sentence a reader trusted was never checked, and it
// was FALSE: a `t=` name is taken VERBATIM (docs/testing/ui-testing.md), which
// is the whole point of writing one. MEASURED against a scaffolded app running
// under `am surface`: minus, ResetButton, plus. Those three strings are what a
// user types into `am trigger` and `ui.App.*`, so they are what this pins —
// through a real render, not a substring.
Deno.test("counter buttons surface as minus/ResetButton/plus", async () => {
  const ui = files["src/App.tsx"]!;
  assertStringIncludes(ui, 't="minus"');
  assertStringIncludes(ui, 't="plus"');

  const clicked: string[] = [];
  // the scaffold's own three buttons: two named by `t=`, one left to LABEL+ROLE
  function App() {
    return h("div", null, [
      h("button", {
        type: "button",
        t: "minus",
        onClick: () => clicked.push("minus"),
      }, "−"),
      h("button", {
        type: "button",
        class: "ghost",
        onClick: () => clicked.push("reset"),
      }, "Reset"),
      h("button", {
        type: "button",
        t: "plus",
        class: "primary",
        onClick: () => clicked.push("plus"),
      }, "+"),
    ]);
  }
  await using surface = await testUI(App as ComponentFn);
  await surface.App.minus.click();
  await surface.App.ResetButton.click();
  await surface.App.plus.click();
  assertEquals(clicked, ["minus", "reset", "plus"]);
});

Deno.test("src/client.ts: no default URL, usage + exit 2 without one, bounded ready", async () => {
  const client = files["src/client.ts"]!;
  assert(!client.includes("localhost:8000"), "dev picks a free port");
  assertStringIncludes(client, "readyTimeoutMs");
  const dir = await Deno.makeTempDir({ prefix: "aio-client-ts-" });
  try {
    await Deno.writeTextFile(join(dir, "client.ts"), client);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio/server": `${ROOT}/src/server-entry.ts` },
      }),
    );
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          join(dir, "deno.json"),
          "client.ts",
          ...args,
        ],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
    const none = await run([]);
    assertEquals(none.code, 2);
    const usage = new TextDecoder().decode(none.stderr);
    assertStringIncludes(usage, "usage: client <ws://host:port/ws>");
    assertStringIncludes(usage, "am instances");
    // A dead URL fails with the framework's message instead of hanging.
    const t0 = Date.now();
    const dead = await run(["ws://127.0.0.1:1/ws"]);
    assert(dead.code !== 0, "a dead URL is a failure");
    assert(Date.now() - t0 < 30_000, "bounded by readyTimeoutMs");
    assertStringIncludes(
      new TextDecoder().decode(dead.stderr),
      "no connection to ws://127.0.0.1:1/ws",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--template=cli: a CLI with no UI — defaults to target cli, mirrors examples/cli-tool, and its test RUNS", async () => {
  // No `--target` → `cli`; an explicit target still wins.
  assertEquals(parseCreateArgs(["t", "--template=cli"]).target, "cli");
  assertEquals(
    parseCreateArgs(["t", "--template=cli", "--target=server"]).target,
    "server",
  );
  assertEquals(parseCreateArgs(["t"]).target, "browser");
  const cli = scaffold("tool", "cli", true, "cli");
  assertEquals(cli["src/App.tsx"], undefined, "a CLI has no UI file");
  assertEquals(cli["src/client.ts"], undefined, "app.ts IS the client");
  // Byte-for-byte the documented example, with the cell beside the entry.
  assertEquals(
    cli["src/cell.ts"],
    await Deno.readTextFile(`${ROOT}/examples/cli-tool/src/cell/todos.ts`),
  );
  assertEquals(
    cli["src/app.ts"],
    (await Deno.readTextFile(`${ROOT}/examples/cli-tool/src/app.ts`))
      .replace("./cell/todos.ts", "./cell.ts"),
  );
  // The starter test is a real test: write the scaffold out and run it
  // against THIS checkout's framework.
  const dir = await Deno.makeTempDir({ prefix: "aio-create-cli-" });
  try {
    for (const [rel, content] of Object.entries(cli)) {
      if (rel === "deno.json") continue;
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: Object.fromEntries(
          Object.entries(AIO_ENTRY_PATHS).map((
            [k, v],
          ) => [k, `${ROOT}/${v}`]),
        ),
      }),
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["test", "-A", "--no-check", "tests/cell.test.ts"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, `the cli starter test must pass:\n${text}`);
    assertStringIncludes(text, "adds, marks done, and clears");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitSentence: one sentence per GitInit", () => {
  const cases: [GitInit, string][] = [
    ["initialized", "git initialized"],
    ["skipped: inside /r", "already inside /r"],
    ["skipped: git not found", "git is not installed"],
    ["skipped: git init failed", "git init failed"],
  ];
  for (const [g, s] of cases) assertStringIncludes(gitSentence(g), s);
});

async function createJson(cwd: string): Promise<Record<string, unknown>> {
  const orig = Deno.cwd();
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    Deno.chdir(cwd);
    await cmdCreate(
      ["demo", `--mirror=${ROOT}`],
      { json: true } as GlobalFlags,
    );
  } finally {
    console.log = real;
    Deno.chdir(orig);
  }
  return JSON.parse(lines.at(-1)!);
}

Deno.test("am create --json: absolute dir, and git as a reason — never a bare false", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-create-git-" });
  try {
    // Inside a repo: the reason names the repo.
    const inside = join(tmp, "repo");
    await Deno.mkdir(inside);
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: inside,
      stdout: "null",
      stderr: "null",
    }).output().catch(() => null);
    if (init?.success) {
      const doc = await createJson(inside);
      assertEquals(doc.dir, join(inside, "demo"));
      assertEquals(
        doc.git,
        `skipped: inside ${await Deno.realPath(inside)}`,
      );
      assert(!("git" in doc && doc.git === false), "never a bare false");
    }
    // Outside one: initialized (or the reason git is unavailable).
    const doc = await createJson(tmp);
    assert(
      typeof doc.dir === "string" && doc.dir.startsWith("/"),
      `dir is absolute: ${doc.dir}`,
    );
    assert(
      doc.git === "initialized" || doc.git === "skipped: git not found",
      `git: ${doc.git}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ── the cli scaffold BOOTS ──────────────────────────────────────────
//
// `--template=cli` was dead on arrival on three counts, none of which any
// test could see because none of them started it:
//   • `deno task dev` ran `src/app.ts --client=cli`, and app.ts routes on a
//     command word — it exited with "missing command — run `todo --help`";
//   • every command defaulted to `ws://localhost:8000/ws` while `serve` binds
//     a FREE port, so `todo list` reported "no server" against a running one;
//   • the README documented both.
// This scaffolds it, starts the server, and runs a command against it.
Deno.test({
  name: "--template=cli: `dev` starts the server and a command finds it",
  ignore: Deno.build.os === "windows",
  async fn() {
    const cli = scaffold("clitool", "cli", true, "cli");
    // The dev task must BE the server. `--client=cli` is not a command word.
    const tasks = JSON.parse(cli["deno.json"]!).tasks as Record<string, string>;
    assertStringIncludes(tasks.dev!, "src/app.ts serve");
    assert(
      !tasks.dev!.includes("--client=cli"),
      `app.ts demands a command word. Got: ${tasks.dev}`,
    );
    // …and no hard-coded port anywhere in the scaffold. Name what must BE
    // there first: an empty map would otherwise satisfy the loop below while
    // proving nothing about the template this test exists to keep alive.
    assertEquals(
      Object.keys(cli).sort(),
      [
        ".gitignore",
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "deno.json",
        "src/app.ts",
        "src/cell.ts",
        "tests/cell.test.ts",
      ],
      "the cli scaffold's files",
    );
    // Commands resolve the RUNNING instance (the lock am reads), not a port —
    // under the identity the tool's OWN deno.json names, never the cwd's.
    assertStringIncludes(cli["src/app.ts"]!, "resolveAppId(config.title)");
    assertStringIncludes(cli["src/app.ts"]!, "instances(APP_ID)");
    for (const [rel, content] of Object.entries(cli)) {
      assert(
        !/["'`]ws:\/\/localhost:8000/.test(content),
        `${rel}: serve picks a free port — a hard-coded 8000 URL is a lie`,
      );
    }

    const dir = await Deno.makeTempDir({ prefix: "aio-cli-boot-" });
    const home = join(dir, "home");
    await Deno.mkdir(home);
    for (const [rel, content] of Object.entries(cli)) {
      if (rel === "deno.json") continue;
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        // the scaffold's own identity keys, so resolveAppId() finds the lock
        ...JSON.parse(cli["deno.json"]!),
        imports: Object.fromEntries(
          Object.entries(AIO_ENTRY_PATHS).map(([k, v]) => [k, `${ROOT}/${v}`]),
        ),
      }),
    );
    // An isolated HOME: the lock dir and ~/.<appId> must not touch the real
    // one. DENO_DIR is pinned to the real cache alongside it — see
    // REAL_DENO_DIR: an isolated HOME would otherwise take the module cache
    // with it and send the child to the network.
    const env = { HOME: home, XDG_RUNTIME_DIR: home, DENO_DIR: REAL_DENO_DIR };
    const serve = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", "src/app.ts", "serve"],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-check", "src/app.ts", ...args],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();

    let out = { code: 1, text: "" };
    try {
      // Wait for the server to be reachable THROUGH the discovery the
      // scaffold ships — no port passed anywhere.
      for (let i = 0; i < 120; i++) {
        const r = await run(["add", "buy milk"]);
        out = {
          code: r.code,
          text: new TextDecoder().decode(r.stdout) +
            new TextDecoder().decode(r.stderr),
        };
        if (r.code === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assertEquals(
        out.code,
        0,
        `\`todo add\` must reach the server:\n${out.text}`,
      );
      const list = await run(["list", "--json"]);
      const listed = new TextDecoder().decode(list.stdout);
      assertEquals(list.code, 0, listed);
      assertStringIncludes(listed, "buy milk");
    } finally {
      try {
        serve.kill("SIGTERM");
      } catch { /* gone */ }
      await serve.output();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// …and the form the scaffold's own README tells an AGENT to use.
//
// `deno task dev` was taught the command word and nothing else was: `am start`
// ran `deno run -A src/app.ts` with no word, so the very first supervised
// launch of a `--template=cli` app died instantly with
//
//   r5a-cli did not start — the child (pid …) exited immediately.
//     it said:  error: missing command — run `todo --help`
//
// while `deno task dev` in the same directory worked. One fact ("this app's
// entry takes a command word"), two launchers, one of them fixed — so `am
// start`, `am restart`, `am status`, `am stop` and every verb that needs a
// running app were unreachable for that template. am now reads the word out of
// the app's OWN dev task, which is the only place it is ever declared.
Deno.test({
  name: "--template=cli: `am start` boots the server `deno task dev` declares",
  ignore: Deno.build.os === "windows",
  async fn() {
    const cli = scaffold("clistart", "cli", true, "cli");
    const dir = await tempDir("aio-cli-amstart-");
    const home = join(dir, "home");
    await Deno.mkdir(home);
    for (const [rel, content] of Object.entries(cli)) {
      if (rel === "deno.json") continue;
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        ...JSON.parse(cli["deno.json"]!),
        imports: Object.fromEntries(
          Object.entries(AIO_ENTRY_PATHS).map(([k, v]) => [k, `${ROOT}/${v}`]),
        ),
      }),
    );
    // An isolated HOME (the am registry and the lock dir must not touch the
    // real one), with DENO_DIR pinned to the real cache beside it — see
    // REAL_DENO_DIR. `am start` gives the child ten seconds to bind a port,
    // and a child re-downloading the JSR graph does not make it.
    const env = { HOME: home, XDG_RUNTIME_DIR: home, DENO_DIR: REAL_DENO_DIR };
    const am = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-check", `${ROOT}/src/am.ts`, ...args],
        cwd: dir,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
    const text = (r: { stdout: Uint8Array; stderr: Uint8Array }) =>
      new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    try {
      const started = await am(["start", "--json"]);
      assertEquals(
        started.code,
        0,
        `am start must boot the cli scaffold:\n${text(started)}`,
      );
      assertStringIncludes(text(started), '"status":"started"');
      // It is the SERVER that came up, not some process that merely survived:
      // the cell the template owns answers.
      const state = await am(["state", "--json"]);
      assertEquals(state.code, 0, text(state));
      assertStringIncludes(text(state), "todos");
    } finally {
      await am(["stop", "--json"]).catch(() => {});
      await dropTempDir(dir);
    }
  },
});

Deno.test("am start: a dev task with no command word adds nothing", () => {
  const root = "/p";
  const entry = "/p/src/app.ts";
  assertEquals(entryTaskWords("deno run -A src/app.ts serve", entry, root), [
    "serve",
  ]);
  // The browser scaffold's own dev task: a flag is am's business, never a word.
  assertEquals(entryTaskWords("deno run -A src/app.ts", entry, root), []);
  assertEquals(
    entryTaskWords("deno run -A src/app.ts --client=electron", entry, root),
    [],
  );
  // A task that launches something else entirely (the android orchestrator)
  // says nothing about this entry.
  assertEquals(
    entryTaskWords("deno run -A dep/aio/src/build/android-dev.ts", entry, root),
    [],
  );
  assertEquals(entryTaskWords(undefined, entry, root), []);
});
