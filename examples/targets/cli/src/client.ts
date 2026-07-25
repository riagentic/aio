// Thin CLI client — bound remote cell: the same cell definition the server
// uses, bound to the connection. `await counter.increment(1)` dispatches over
// the socket (resolves on the server ack) and `counter.count` reads live
// server state — no raw { type, payload } wire actions, no state mirror.
import { connectCli } from "aio/server";
import { counter } from "./cell/counter.ts";

const url = Deno.args[0] || "ws://localhost:8000/ws";
console.log("Connecting to", url, "...");

const app = connectCli(url);
app.bind(counter);
await app.ready;

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
