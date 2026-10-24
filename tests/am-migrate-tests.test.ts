// `am migrate --tests`: the machine-readable index of test shapes an upgrade
// turns red, grepped in a real app and listed in the order they would fail
// (field report: 73 tests went red across 1.0.9 → 1.0.20, one cascade at a
// time, with nothing to say which release moved which semantic).
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  breakagesAfter,
  breakagesInText,
  TEST_BREAKAGES,
} from "../src/am/am-test-breakage.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));
const ROOT = fromFileUrl(new URL("../", import.meta.url));
const ids = (rel: string, text: string) =>
  breakagesInText(rel, text, TEST_BREAKAGES).map((f) => f.id);

Deno.test("test-breakage index: every row is dated, guided and matches its own shape", async () => {
  assert(TEST_BREAKAGES.length >= 5, "the index is empty");
  for (const b of TEST_BREAKAGES) {
    await Deno.stat(join(ROOT, b.guide)); // the guide exists
    assert(b.pattern.flags.includes("g"), b.id);
  }
  assertEquals(ids("tests/a.test.ts", "await ui.waitFor(async () => x)"), [
    "async-predicate",
  ]);
  assertEquals(ids("tests/a.test.ts", "ui.Go.click();\nawait ui.advance(50)"), [
    "advance-after-click",
  ]);
  assertEquals(ids("tests/a.test.ts", "ui.T.type(new Date())"), [
    "testui-non-json-arg",
  ]);
  assertEquals(ids("tests/a.test.ts", "ui.AioRadioRc1Radio.click()"), [
    "surface-renumbered-name",
  ]);
  assertEquals(
    ids("src/c.ts", "onInit() {\n  setTimeout(() => c.go(), 0);\n}"),
    ["oninit-timer-dispatch"],
  );
  // Scope: a test shape in app source, or an app shape in a test, is not one.
  assertEquals(ids("src/c.ts", "await waitFor(async () => x)"), []);
  assertEquals(ids("tests/a_test.ts", "onInit() { setTimeout(f) }"), []);
  // Synchronous predicates and a plain advance are fine.
  assertEquals(ids("tests/a.test.ts", "await ui.waitFor(() => x)"), []);
  // `--from` keeps only what fails AFTER it.
  assert(breakagesAfter("1.0.24-beta").length === 0);
  assertEquals(
    breakagesAfter("1.0.23-beta").every((b) => b.since === "1.0.24-beta"),
    true,
  );
});

Deno.test("am migrate --tests lists an app's shapes oldest release first, exit 0", async () => {
  const dir = await tempDir("am-migrate-tests-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "tests"));
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(
      join(dir, "tests", "app.test.ts"),
      "await ui.waitFor(async () => ok);\n",
    );
    await Deno.writeTextFile(
      join(dir, "src", "c.ts"),
      "export const c = { onInit() { setTimeout(() => c.go(), 0); } };\n",
    );
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        AM,
        "migrate",
        "--tests",
        "--from=1.0.9-beta",
        "--json",
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(o.stdout);
    assertEquals(o.code, 0, text + new TextDecoder().decode(o.stderr));
    const r = JSON.parse(text) as { from: string; tests: { id: string }[] };
    assertEquals(r.from, "1.0.9-beta");
    assertEquals(r.tests.map((t) => t.id), [
      "oninit-timer-dispatch", // 1.0.11 — fails first
      "async-predicate", // 1.0.24
    ]);
  } finally {
    await dropTempDir(dir);
  }
});
