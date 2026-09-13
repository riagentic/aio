// Thin CLI client — bound remote cell: the same cell definition the server
// uses, bound to the connection. `await counter.increment(1)` dispatches over
// the socket (resolves on the server ack) and `counter.count` reads live
// server state — no raw { type, payload } wire actions, no state mirror.
import { connectCli } from "aio/server";
import config from "../deno.json" with { type: "json" };
import { counter } from "./cell/counter.ts";

// WHERE the server is. This binary has no server of its own, so nothing local
// can know: the URL is an argument, or `build.server` in this project's
// deno.json — the one place a fleet names its server. There is no default. The
// ws://localhost:8000 this used to fall back to was a guess that reached
// nothing (or some other app) and retried it forever without a word.
const server = (config.build as { server?: string }).server;
const url = Deno.args[0] ??
  (server ? (server.includes("://") ? server : `http://${server}`) : undefined);
if (!url) {
  console.error(
    "usage: client <url>   e.g. client http://192.168.1.50:8000\n" +
      '  or set "build": { "server": "host:port" } in deno.json',
  );
  Deno.exit(2);
}
console.log("Connecting to", url, "...");

// Bounded: a server that is not there is an answer, not a hang.
const app = connectCli(url, { readyTimeoutMs: 10_000 });
app.bind(counter);
try {
  await app.ready;
} catch (e) {
  console.error(`no server at ${url} — ${e instanceof Error ? e.message : e}`);
  app.close();
  Deno.exit(1);
}

console.log("Counter:", counter.count);
app.subscribe(() => console.log("Counter:", counter.count));

const HELP = "Commands: inc [n], dec [n], reset";
console.log(HELP);

const decoder = new TextDecoder();
const buf = new Uint8Array(1024);
while (true) {
  const n = await Deno.stdin.read(buf);
  if (n === null) break;
  const [cmd, arg] = decoder.decode(buf.subarray(0, n)).trim().split(/\s+/);
  if (cmd === "inc") await counter.increment(Number(arg) || 1);
  else if (cmd === "dec") await counter.decrement(Number(arg) || 1);
  else if (cmd === "reset") await counter.reset();
  else if (cmd) console.log(HELP);
}

app.close();
