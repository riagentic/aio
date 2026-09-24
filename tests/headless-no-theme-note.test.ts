// A headless run (`--client=server-only`, `cli`) serves no page, so the boot
// line saying which LOOK a page would get — "theme: aio's default look is in
// effect…" — was noise, printed by a server-kind binary right after it said it
// serves no UI (field report, a user-driven hunt). A served app still hears it.
import { assert } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function bootLines(client: "server-only" | "browser"): Promise<string> {
  const { aio, cell } = await import("../mod.ts");
  const c = cell(`hnt-${client}`, { state: { n: 0 }, methods: {} });
  const dir = await tempDir("aio-headless-theme-");
  await Deno.writeTextFile(
    `${dir}/App.tsx`,
    "export default function App() { return <main>hi</main>; }\n",
  );
  const seen: string[] = [];
  const orig = { ...console };
  for (const k of ["log", "info", "warn", "error", "debug"] as const) {
    console[k] = (...a: unknown[]) => seen.push(a.map(String).join(" "));
  }
  try {
    const app = await aio.run({
      cells: [c],
      appId: `test-headless-theme-${client}`,
      client,
      persist: false,
      libraryMode: true,
      port: freePort(),
      baseDir: dir,
      ui: { theme: "auto" },
    });
    await app.close();
  } finally {
    Object.assign(console, orig);
    await dropTempDir(dir);
  }
  return seen.join("\n");
}

Deno.test("headless boot: no 'default look' line — there is no page to style", async () => {
  const out = await bootLines("server-only");
  assert(!out.includes("default look is in effect"), out);
});

Deno.test("served boot: the 'default look' line is still said", async () => {
  const out = await bootLines("browser");
  assert(out.includes("default look is in effect"), out);
});
