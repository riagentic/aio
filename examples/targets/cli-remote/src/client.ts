// Thin CLI client — connects to a running aio server over WebSocket
import { connectCli } from "aio";
import type { AppState } from "./state.ts";
import { parseCommand, printHelp } from "./commands.ts";

const url = Deno.args[0] || "ws://localhost:8000/ws";
console.log("Connecting to", url, "...");

const app = connectCli<AppState>(url);
await app.ready;
console.log("Counter:", app.state?.counter.count);

app.subscribe((state) => {
  console.log("Counter:", state.counter.count);
});

const decoder = new TextDecoder();
const buf = new Uint8Array(1024);
printHelp();

while (true) {
  const n = await Deno.stdin.read(buf);
  if (n === null) break;
  const line = decoder.decode(buf.subarray(0, n)).trim();
  if (!line) continue;
  const action = parseCommand(line.split(/\s+/));
  if (action) app.send(action);
  else printHelp();
}

app.close();
