// `am surface` with no connected client (the headless server-side render) on an
// auth app used to answer differently on consecutive calls: the first render saw
// `useUser() === undefined` (the `/me` fetch not resolved yet — and in a server
// process a relative fetch can never resolve), the next saw `null` (the fetch
// had failed in between) and rendered <SignIn/>. An inspection that changes its
// answer on its own is not an inspection. A page with no origin and no bridge
// has no session: anonymous, resolved, from the first render.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("headless surface: an auth app renders the same anonymous branch on every call", async () => {
  const dir = await tempDir("surface-auth-");
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    `import { h } from "${toFileUrl(REPO).href}/src/air/vdom.ts";
import { useUser } from "${toFileUrl(REPO).href}/src/air.ts";
export default function App() {
  const u = useUser();
  return h("p", null, u === undefined ? "Loading" : u === null ? "Anonymous" : "Hello");
}
`,
  );
  const texts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await renderHeadlessSurface(join(dir, "App.tsx"));
    assert(r.ok, r.ok ? "" : r.error);
    texts.push(JSON.stringify(r.roots));
    await new Promise((res) => setTimeout(res, 20)); // let any fetch settle
  }
  assert(texts[0]!.includes("Anonymous"), `first render: ${texts[0]}`);
  assertEquals(texts[1], texts[0], "second call must match the first");
  assertEquals(texts[2], texts[0]);
});
