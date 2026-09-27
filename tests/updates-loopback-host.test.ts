// Hunt r10: `transportAuthenticatesHost` treats plain `http:` to loopback as
// authenticated — "the bytes never leave the machine". Its loopback test is
// `/^127\./.test(hostname)`, which also matches a DNS NAME that merely starts
// with "127." (`127.attacker.example`, `127.0.0.1.nip.io`). Those resolve to
// wherever their owner points them, so a manifest fetched over plain http from
// such a host is NOT loopback, yet its signing key is pinned forever (TOFU).
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  pinKey,
  readTrust,
  transportAuthenticatesHost,
} from "../src/server/updates-check.ts";
import { generateSigningKey } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("hunt r10: a DNS name beginning with '127.' is not loopback", () => {
  // Sanity: the genuine loopback forms stay accepted.
  assertEquals(
    transportAuthenticatesHost("http://127.0.0.1:8080/x.json"),
    true,
  );
  assertEquals(transportAuthenticatesHost("http://localhost/x.json"), true);
  // A remote host whose NAME starts with 127. is plain http to the network.
  assertEquals(
    transportAuthenticatesHost("http://127.attacker.example/prod/linux.json"),
    false,
    "127.attacker.example is a DNS name, not a loopback address",
  );
  assertEquals(
    transportAuthenticatesHost("http://127.0.0.1.nip.io/prod/linux.json"),
    false,
    "127.0.0.1.nip.io is a DNS name, not a loopback address",
  );
});

Deno.test("hunt r10: pinKey refuses a key learned over plain http from 127.<name>", async () => {
  const root = await tempDir("aio-r10-loop-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const { publicKey } = await generateSigningKey();
    assertThrows(
      () =>
        pinKey(
          dataDir,
          publicKey,
          "http://127.attacker.example/prod/linux-x86_64.json",
        ),
      Error,
      "unauthenticated transport",
    );
    assertEquals(readTrust(dataDir).key, undefined);
  } finally {
    await dropTempDir(root);
  }
});
