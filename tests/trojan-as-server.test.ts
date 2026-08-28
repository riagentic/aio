// `am dispatch --as-server` — the operator door for a server-only-write cell.
//
// "Public read, server-only write" (`access: false` + `visible: "all"`) is a
// shape aio actively encourages, and its consequence is that the CLI cannot
// call the method either: `am dispatch news:add` answers "access denied",
// correctly. The fallback was `am snapshot save/load`, which bypasses
// validation entirely and is the wrong tool for "call this one method".
//
// This widens nothing — the whole trojan is dev-only and loopback-only, and
// already reads unfiltered state and runs SQL. It replaces a bypass through
// the snapshot file with a named, logged door, and NAMES it in the denial so
// it is discoverable at the moment you need it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "aio";
import { aio } from "aio";
import { freePort } from "../src/testing/server-test.ts";

const news = cell("as-server-news", {
  access: false,
  visible: "all",
  state: { items: [] as string[] },
  methods: {
    add(s, title: string) {
      s.items.push(title);
    },
  },
});

Deno.test({
  name: "the network is refused, and the refusal names the escape hatch",
  async fn() {
    const port = freePort();
    const app = await aio.run({
      appId: "as-server-app",
      cells: [news],
      dbPath: ":memory:",
      client: "server-only",
      libraryMode: true,
      port,
    });
    try {
      const post = (qs: string) =>
        fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch${qs}`, {
          method: "POST",
          // The trojan's CSRF gate — `am` sends it on every POST.
          headers: { "X-AIO": "1" },
          body: JSON.stringify({
            type: "as-server-news:add",
            payload: { args: ["hello"] },
          }),
        }).then(async (r) => ({ status: r.status, body: await r.text() }));

      const denied = await post("");
      assert(
        denied.body.includes("access denied"),
        `a network caller is refused: ${denied.body}`,
      );
      assert(
        denied.body.includes("--as-server"),
        `…and the refusal names the way through: ${denied.body}`,
      );
      assertEquals(news.items.length, 0, "nothing was written");

      const allowed = await post("?as=server");
      assertEquals(allowed.status, 200, allowed.body);
      assertEquals(news.items, ["hello"], "the method ran for real");
    } finally {
      await app.close();
    }
  },
});
