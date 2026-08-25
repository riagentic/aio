// `smoke()` — boot headless, fetch every eagerly-linked client module. The
// dynamic half of the blank-screen gate (field report §5.1): the same request the
// browser makes, against a real `aio.run()`.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { smoke } from "../src/testing/smoke-test.ts";

// A boot needs one cell; the fixture's App.tsx is what is under test.
const probe = cell("smoke-probe", { state: { n: 0 }, methods: {} });

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-smoke-" });
  for (const [name, body] of Object.entries(files)) {
    const full = `${dir}/${name}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, body);
  }
  return dir;
}

const APP = `import { h } from "aio/air";
import { label } from "./lib/label.ts";
export default function App() { return h("div", null, label); }`;

Deno.test("smoke: a healthy app — every eager module answers 200", async () => {
  const dir = await fixture({
    "App.tsx": APP,
    "lib/label.ts": `export const label = "ok";`,
  });
  try {
    const r = await smoke({ baseDir: dir, cells: [probe] });
    assertEquals(r.checked.sort(), ["/App.tsx", "/lib/label.ts"]);
    assertEquals(r.graph.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("smoke: a static *.server.ts import fails BEFORE boot, naming file:line", async () => {
  const dir = await fixture({
    "App.tsx": APP,
    "lib/label.ts":
      `import { secret } from "./vault.server.ts";\nexport const label = secret;`,
    "lib/vault.server.ts": `export const secret = "s";`,
  });
  try {
    const err = await assertRejects(
      () => smoke({ baseDir: dir, cells: [probe] }),
      Error,
    );
    assert(err.message.includes("blocking module error"), err.message);
    assert(err.message.includes("lib/label.ts:1"), err.message);
    assert(err.message.includes("vault.server.ts"), err.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("smoke: a module the dev server refuses to serve fails with its importer chain", async () => {
  // A dotfile directory passes the static validator (the file exists) and is
  // 404'd by the dev server's protected-path rule — exactly the class of
  // "green everywhere, blank in the window" the boot smoke exists for.
  const dir = await fixture({
    "App.tsx": APP,
    "lib/label.ts":
      `import { v } from "./.private/v.ts";\nexport const label = v;`,
    "lib/.private/v.ts": `export const v = "hidden";`,
  });
  try {
    const err = await assertRejects(
      () => smoke({ baseDir: dir, cells: [probe] }),
      Error,
    );
    assert(err.message.includes("HTTP 404"), err.message);
    assert(
      err.message.includes("App.tsx → lib/label.ts → lib/.private/v.ts"),
      err.message,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("smoke: no entry is a loud refusal, not a vacuous pass", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-smoke-empty-" });
  try {
    const err = await assertRejects(
      () => smoke({ baseDir: dir, cells: [probe] }),
      Error,
    );
    assert(err.message.includes("no UI entry"), err.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
