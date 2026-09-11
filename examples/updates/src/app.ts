// Entry point — one line turns updates on. Point `source` at wherever your
// releases land: a static host, a mounted share, or the repo itself.
import "./cell.ts";
import { aio } from "aio";

await aio.run({
  // A bare URL is the whole configuration. The object form adds the switches
  // a default cannot decide for you — see docs/deploy/updates.md.
  //
  //   updates: { source: "…", auto: true }   // unattended service
  //   updates: "https://github.com/you/app"  // the repository itself
  // Problem reports: user-filed through the `feedback` cell, plus automatic
  // capture when the app breaks. They land in <data>/reports/.
  feedback: true,
  updates: Deno.env.get("RELEASES") ??
    "https://releases.example.com/updates-demo",
});
