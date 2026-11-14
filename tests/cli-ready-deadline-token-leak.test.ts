// connectCli(shareLink, { readyTimeoutMs }) — the "no connection" rejection
// (and the "closed before the first connection" one) print the share link
// WITH its ?token=, while every other line of this client redacts it.
import { assert, assertRejects } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";

const SECRET = "s3cr3t-app-key-0123456789";

Deno.test("ready deadline error must not carry the share-link token", async () => {
  const port = freePort(); // nothing listens: the deadline fires
  const app = connectCli(`http://127.0.0.1:${port}/?token=${SECRET}`, {
    readyTimeoutMs: 300,
  });
  try {
    const e = await assertRejects(() => app.ready);
    assert(
      !(e as Error).message.includes(SECRET),
      `token leaked: ${(e as Error).message}`,
    );
  } finally {
    app.close();
  }
});

Deno.test("close-before-connect error must not carry the share-link token", async () => {
  const port = freePort();
  const app = connectCli(`http://127.0.0.1:${port}/?token=${SECRET}`);
  app.close();
  const e = await assertRejects(() => app.ready);
  assert(
    !(e as Error).message.includes(SECRET),
    `token leaked: ${(e as Error).message}`,
  );
});
