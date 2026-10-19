// The `--expose` share link must OPEN. It printed `?token=${token}` raw, so a
// key or `users:` token with `+`, `/`, `=`, `&` or `#` — every token
// `openssl rand -base64 24` makes, which the weak-token warning itself
// recommends — reached the server as a different string (`+` parses as a
// space, `&`/`#` cut it short): the copied link answered 401, and each open
// was charged to the auth budget. Measured on a real exposed loopback server.
// The desktop window's URL was built the same way.
import { assert, assertEquals } from "@std/assert";
import { captureConsoleAsync } from "./console-capture.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { withToken } from "../src/server/aio-lifecycle.ts";

const TOKEN = "q8Z+v/3kLmN9pQ+rS2tU/vW4&xY5#z=";

Deno.test("withToken: the token survives the URL parser", () => {
  const u = new URL(withToken("http://127.0.0.1:1", TOKEN));
  assertEquals(u.searchParams.get("token"), TOKEN);
  // A plain uuid key prints exactly as before.
  const id = crypto.randomUUID();
  assertEquals(withToken("http://h", id), `http://h?token=${id}`);
});

for (const mode of ["key", "users"] as const) {
  Deno.test({
    name: `--expose ${mode}: the printed share link opens the app`,
    async fn() {
      const dir = await tempDir("aio-share-tok-");
      const { aio, cell } = await import("../mod.ts");
      const port = freePort();
      let app: { close(): Promise<void> } | undefined;
      try {
        const lines = await captureConsoleAsync(async () => {
          app = await aio.run({
            cells: [
              cell(`sh-${crypto.randomUUID().slice(0, 8)}`, {
                state: { n: 0 },
                visible: "all",
                methods: {},
              }),
            ],
            appId: `sharetok-${mode}-${crypto.randomUUID().slice(0, 8)}`,
            client: "server-only",
            persist: false,
            libraryMode: true,
            singleton: false,
            port,
            host: "127.0.0.1",
            tls: false,
            appDir: dir,
            expose: true,
            ...(mode === "key"
              ? { key: TOKEN }
              : { users: { [TOKEN]: { id: "alice", role: "user" } } }),
            baseDir: dir,
            watch: false,
          } as never);
        });
        const line = lines.find((l) => /share.*\?token=/.test(l));
        assert(line, `no share line printed:\n${lines.join("\n")}`);
        const link = line.match(/(https?:\/\/\S+\?token=\S+)/)![1]!
          .replace("//localhost:", "//127.0.0.1:");
        const res = await fetch(link);
        await res.body?.cancel();
        assertEquals(res.status, 200, `share link ${link} was refused`);
      } finally {
        await app?.close();
        await dropTempDir(dir);
      }
    },
  });
}
