// serverfns-shared-namespace-warns.test.ts — a namespace every app serves is
// said out loud, once.
//
// `export const api = serverFns("api", …)` at a module's top level is the
// documented pattern, and it is registered outside any app — so it cannot be
// placed, and every app in the process serves it. With one app that is right
// and nothing is printed. With two, app B (open, no auth) answers app A's
// functions: the moment a second app is live, the namespace is named ONCE,
// with both apps and the two fixes.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell, serverFns } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

// Outside any app — before any boot.
const NS = `payroll${crypto.randomUUID().slice(0, 8)}`;
serverFns(NS, { read: () => "SECRET" });

type App = { close(): Promise<void> };
const boot = (id: string, dir: string) =>
  aio.run({
    cells: [
      cell("c", {
        state: { n: 0 },
        methods: {
          inc(s: { n: number }) {
            s.n++;
          },
        },
      }),
    ],
    appId: id,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port: freePort(),
  } as never) as unknown as Promise<App>;

const logsOf = async (dir: string) => {
  let all = "";
  for (const f of ["app.log", "warning.log", "debug.log"]) {
    all += await Deno.readTextFile(join(dir, "logs", f)).catch(() => "");
  }
  return all;
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

Deno.test("serverFns: a namespace registered outside any app is named once two apps serve it", async () => {
  const tag = crypto.randomUUID().slice(0, 6);
  const [idA, idB, idC] = [`sfwa-${tag}`, `sfwb-${tag}`, `sfwc-${tag}`];
  const [dirA, dirB, dirC] = [
    await tempDir("aio-sfw-a-"),
    await tempDir("aio-sfw-b-"),
    await tempDir("aio-sfw-c-"),
  ];
  const needle = `serverFns(${JSON.stringify(NS)}) was registered outside`;

  // One app: every app serving it is exactly right — and silent.
  await (await boot(idA, dirA)).close();
  const alone = await logsOf(dirA);
  assertEquals(
    count(alone, needle),
    0,
    `one app must print nothing:\n${alone}`,
  );

  // A second app goes live: named once, with both apps and the fixes. A third
  // app says nothing new.
  const A = await boot(idA, dirA);
  let B: App | undefined, C: App | undefined;
  try {
    B = await boot(idB, dirB);
    C = await boot(idC, dirC);
  } finally {
    await C?.close();
    await B?.close();
    await A.close();
  }
  const [la, lb, lc] = [
    await logsOf(dirA),
    await logsOf(dirB),
    await logsOf(dirC),
  ];
  const lines = lb.split("\n").filter((l) => l.includes(needle));
  const line = lines[0] ?? "";
  assert(line !== "", `B's boot must name the shared namespace:\n${lb}`);
  assert(line.includes(idA) && line.includes(idB), line);
  assert(line.includes("onStart") && line.includes("access:"), line);
  assertEquals(new Set(lines).size, 1, "one announcement, not one per boot");
  assertEquals(count(la + lc, needle), 0, "announced again after the first");
  for (const d of [dirA, dirB, dirC]) {
    await dropTempDir(d).catch(() => {});
  }
});
