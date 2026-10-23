// `am instances --app=X` lists X's instances only. The flag was ignored, so
// `am instances --app=X --json | jq '.[0].pid'` read whichever app came first.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { cmdInstances } from "../src/am/am-cmd-status.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";

function listed(flags: Record<string, unknown>): { appId: string }[] {
  const chunks: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  try {
    cmdInstances([], { json: true, ...flags });
  } finally {
    console.log = log;
  }
  return JSON.parse(chunks.join("\n"));
}

Deno.test("am instances: --app narrows the list to that app", async () => {
  const a = new AppLock(`instfa${Deno.pid}`);
  const b = new AppLock(`instfb${Deno.pid}`);
  try {
    assertEquals((await a.acquire(4601)).ok, true);
    assertEquals((await b.acquire(4602)).ok, true);
    const ids = (f: Record<string, unknown>) =>
      listed(f).map((i) => i.appId).filter((id) => id.startsWith("instf"));
    assertEquals(ids({}).sort(), [a.appId, b.appId].sort());
    assertEquals(listed({ app: b.appId }).map((i) => i.appId), [b.appId]);
    assertEquals(listed({ app: "instf-none" }), []);
  } finally {
    a.release();
    b.release();
  }
});
