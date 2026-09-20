// A component that is not running is told to start THAT component.
//
// The "stopped app in its own directory" message asks `resolveAmAppId()` with
// no flag to decide whether the id it is about to name came from this project.
// In a project that declares COMPONENTS that question has no answer — and
// `resolveAmAppId()` does not return one, it prints its own refusal and
// `Deno.exit(1)`s. So a caller who had already named a component got:
//
//     am state --app=agent
//     {"error":"this project has several components (agent, relay) and this
//      command acts on one — pick one with --app=agent, …"}
//
// told to do the thing it just did, from a message-composition path that
// terminates the process. The id IS this project's — it is one of the
// components — so the answer is the same as for a single-app project, naming
// the part: `am start agent`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const ENTRY = (appId: string) =>
  `import { aio } from "aio";\nawait aio.run({ appId: "${appId}", cells: [] });\n`;

async function amJson(
  cwd: string,
  apps: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, AM, ...args, "--json"],
    cwd,
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

Deno.test("am: a stopped COMPONENT is told to start that component", async () => {
  const dir = await tempDir("aio-am-comp-stopped-");
  const apps = join(dir, "apps");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(apps, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        name: "comp-stopped",
        title: "comp-stopped",
        build: {
          targets: {
            agent: { entry: "src/agent.ts", target: "server" },
            relay: { entry: "src/relay.ts", target: "server" },
          },
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "src/agent.ts"), ENTRY("cs-agent"));
    await Deno.writeTextFile(join(dir, "src/relay.ts"), ENTRY("cs-relay"));

    const r = await amJson(dir, apps, ["state", "--app=agent"]);
    const msg = r.out + r.err;
    assertEquals(
      msg.includes("pick one with --app="),
      false,
      `the caller already picked one — it wrote --app=agent: ${msg}`,
    );
    assertStringIncludes(msg, "not running");
    assertStringIncludes(msg, "am start agent");
  } finally {
    await dropTempDir(dir);
  }
});

// The single-app half of the same sentence, driven through the real CLI rather
// than the in-process unit — the refusal it replaced could not be reached from
// a unit test at all, because it exits the process.
Deno.test("am: a stopped single app is told `am start`, with no component noise", async () => {
  const dir = await tempDir("aio-am-one-stopped-");
  const apps = join(dir, "apps");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.mkdir(apps, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ appId: "one-stopped", tasks: {} }),
    );
    await Deno.writeTextFile(join(dir, "src/app.ts"), ENTRY("one-stopped"));
    const r = await amJson(dir, apps, ["state"]);
    const msg = r.out + r.err;
    assertStringIncludes(msg, "one-stopped");
    assertStringIncludes(msg, "is not running");
    assertStringIncludes(msg, "am start");
    assert(!msg.includes("does not know which app"), msg);
  } finally {
    await dropTempDir(dir);
  }
});
