// Three ways the logger lied about what it had written.
//
// 1. `logging.level` gated debug.log ONLY. `level: "warn"` still printed every
//    info line to the console and appended it to app.log — a documented setting
//    (docs/debugging/errors.md lists the five levels) that did nothing a user
//    could observe.
// 2. `flush(timeoutMs)` raced a timer and returned when the timer won, saying
//    nothing. On a slow or wedged filesystem the tail of the log — including
//    the shutdown lines you are reading the log FOR — was simply absent.
// 3. A failed write reported to the console three times and then went silent
//    forever, while every subsequent batch was dropped. A full disk or a
//    revoked permission turned the app's log off with no signal at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { interceptConsole } from "./console-capture.ts";
import { AioLogger } from "../src/diagnostics/logger.ts";

const tmpDir = () => Deno.makeTempDirSync();

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  return { lines, restore: interceptConsole(lines) };
}

Deno.test("logger: level gates EVERY sink, not just debug.log", async () => {
  const dir = tmpDir();
  const l = new AioLogger({ dir, level: "warn", console: true, heartbeat: 0 });
  await l.init();
  const cap = capture();
  try {
    l.pub("info", "app", "chatty-info-line");
    l.pub("warn", "app", "real-warning-line");
    await l.flush();
  } finally {
    cap.restore();
  }

  const app = await Deno.readTextFile(`${dir}/app.log`).catch(() => "");
  assertStringIncludes(app, "real-warning-line");
  assertEquals(
    app.includes("chatty-info-line"),
    false,
    `level: "warn" must keep info OUT of app.log — it is the file the user ` +
      `reads. Got:\n${app}`,
  );
  assertEquals(
    cap.lines.some((x) => x.includes("chatty-info-line")),
    false,
    `…and out of the console: ${JSON.stringify(cap.lines)}`,
  );
  assert(
    cap.lines.some((x) => x.includes("real-warning-line")),
    "a warn line at level warn still prints",
  );
});

Deno.test("logger: the default level still routes info to app.log + console", async () => {
  const dir = tmpDir();
  const l = new AioLogger({ dir, console: true, heartbeat: 0 }); // level defaults to info
  await l.init();
  const cap = capture();
  try {
    l.pub("info", "app", "default-info-line");
    await l.flush();
  } finally {
    cap.restore();
  }
  assertStringIncludes(
    await Deno.readTextFile(`${dir}/app.log`),
    "default-info-line",
  );
  assert(cap.lines.some((x) => x.includes("default-info-line")));
});

Deno.test("logger: a flush that times out says the tail is missing", async () => {
  const dir = tmpDir();
  const l = new AioLogger({ dir, console: false, heartbeat: 0 });
  await l.init();

  const realWrite = Deno.writeTextFile;
  let release: (() => void) | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = () =>
    new Promise<void>((r) => {
      release = r;
    });
  const cap = capture();
  try {
    l.pub("error", "app", "the-line-that-never-lands");
    await l.flush(20);
  } finally {
    cap.restore();
    release?.();
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = realWrite;
  }

  assert(
    cap.lines.some((x) => /flush timed out/i.test(x)),
    `a deadline that drops the tail of the log must announce it — nothing ` +
      `else can tell the reader the file is incomplete. Saw: ${
        JSON.stringify(cap.lines)
      }`,
  );
});

Deno.test("logger: a permanently failing sink never goes silent", async () => {
  const dir = tmpDir();
  const l = new AioLogger({ dir, console: false, heartbeat: 0 });
  await l.init();

  const realWrite = Deno.writeTextFile;
  // Not NotFound — the recreate-and-retry path must not apply.
  // deno-lint-ignore no-explicit-any
  (Deno as any).writeTextFile = () =>
    Promise.reject(new Deno.errors.PermissionDenied("read-only filesystem"));
  const cap = capture();
  try {
    for (let i = 0; i < 250; i++) {
      l.pub("error", "app", `dropped-line-${i}`);
      await l.flush(50);
    }
  } finally {
    cap.restore();
    // deno-lint-ignore no-explicit-any
    (Deno as any).writeTextFile = realWrite;
  }

  const failures = cap.lines.filter((x) => /write failed/i.test(x));
  assert(
    failures.length > 3,
    `after the first few reports the logger went silent for the life of the ` +
      `process while still dropping every line — a log that stops with no ` +
      `signal is the worst outcome. Reports seen: ${failures.length}`,
  );
  assert(
    failures.some((x) => /line\(s\) lost/i.test(x)),
    `the report must say what the failure COST: ${JSON.stringify(failures)}`,
  );

  // …and when the sink comes back, the outage is accounted for.
  const cap2 = capture();
  try {
    l.pub("error", "app", "back-online");
    await l.flush(500);
  } finally {
    cap2.restore();
  }
  assert(
    cap2.lines.some((x) => /recovered after/i.test(x)),
    `recovery must state the hole it left: ${JSON.stringify(cap2.lines)}`,
  );
});
