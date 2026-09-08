// `am restart <appId>` must accept the id `am instances` just printed.
//
// The positional was read only as a COMPONENT label — a declared `build.targets`
// entry — so typing a running app's id straight from `am instances` was refused
// with "this project declares no components, so <id> names nothing" (vidtune
// §5). True about components, and useless about the thing the user was holding.
// `am instances` is exactly where you go to find that name.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { processPlan } from "../src/am/am-components.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";

async function withLockedApp(
  appId: string,
  fn: (root: string) => void | Promise<void>,
): Promise<void> {
  const appsDir = await tempDir("am-positional-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", appsDir);
  try {
    writeLock({
      appId,
      pid: Deno.pid,
      port: 1234,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
    });
    // A project root with no declared components — the reported situation.
    const root = await tempDir("am-positional-root-");
    try {
      await Deno.writeTextFile(
        `${root}/deno.json`,
        JSON.stringify({ title: "x", version: "0.1" }),
      );
      await fn(root);
    } finally {
      await dropTempDir(root);
    }
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(appsDir);
  }
}

Deno.test("processPlan: a positional naming a RUNNING app targets that app", async () => {
  await withLockedApp("my-live-app", (root) => {
    const plan = processPlan(["my-live-app"], {}, root);
    assertEquals(
      plan.kind,
      "single",
      `an id straight from \`am instances\` was refused: ${
        plan.kind === "error" ? plan.message : plan.kind
      }`,
    );
    assertEquals(
      plan.kind === "single" ? plan.appId : undefined,
      "my-live-app",
      "the plan resolved but did not carry the app — the command would then " +
        "act on the WRONG app, which is worse than the refusal it replaced",
    );
  });
});

Deno.test("processPlan: a positional naming nothing is still refused, and says where to look", async () => {
  await withLockedApp("my-live-app", (root) => {
    const plan = processPlan(["not-a-thing"], {}, root);
    assertEquals(plan.kind, "error");
    if (plan.kind === "error") {
      assertStringIncludes(plan.message, "not-a-thing");
      assertStringIncludes(
        plan.message,
        "am instances",
        "the refusal must point at the list that HAS the names — that is the " +
          "half the old message was missing",
      );
    }
  });
});

Deno.test("processPlan: a declared component still wins over a same-named instance", async () => {
  // In a repo that declares components, the label IS a component's name by
  // definition. Letting a running instance shadow it would make the meaning of
  // a command depend on what happens to be up.
  //
  // Two targets with DIFFERENT entries: one alone is not a fleet, it is just
  // the app, and `projectComponents` says so by returning nothing.
  await withLockedApp("server", async (root) => {
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({
        title: "x",
        version: "0.1",
        build: {
          targets: {
            server: { entry: "src/api.ts" },
            browser: { entry: "src/ui.ts" },
          },
        },
      }),
    );
    const plan = processPlan(["server"], {}, root);
    assert(
      plan.kind === "one" || plan.kind === "error",
      `expected the declared component to win, got ${plan.kind}` +
        (plan.kind === "single" ? ` (appId=${plan.appId})` : ""),
    );
    if (plan.kind === "one") assertEquals(plan.component.label, "server");
  });
});
