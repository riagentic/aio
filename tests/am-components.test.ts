// `am` in a repo that is more than one app.
//
// aio supports several runnable things in one repo — labelled build targets
// with their own entries — and `am` did not know it. `am start` started
// whatever deno.json's single `entry` pointed at, said nothing about the other
// two, and offered no verb to reach them: the command that manages the project
// could only ever see a third of it. `am stop --all` existed, which is the
// tell — the need was already known, and only the stopping half was answered.
//
// So the declaration the BUILD reads now means the same thing to the process
// commands: `am start` starts the project, `am start <label>` starts one part.
// A single-app repo must be completely unaffected, which is most of what these
// tests check.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { declaredPort } from "../src/am/am-utils.ts";
import { envPort } from "../src/server/paths.ts";
import {
  type Component,
  componentByLabel,
  componentConflict,
  componentPort,
  entryDeclarations,
  processPlan,
  projectComponents,
} from "../src/am/am-components.ts";

/** A project on disk: deno.json + the entries its targets name. */
async function project(
  denoJson: Record<string, unknown>,
  entries: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-comp-" });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify(denoJson, null, 2),
  );
  for (const [rel, src] of Object.entries(entries)) {
    const path = `${dir}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, src);
  }
  return dir;
}

const entry = (appId?: string, port?: number) =>
  `import { aio } from "aio";\nawait aio.run({\n` +
  (appId ? `  appId: "${appId}",\n` : "") +
  (port ? `  port: ${port},\n` : "") +
  `  cells: [],\n});\n`;

// ── What counts as a component ──────────────────────────────────────────────

Deno.test("components: an ordinary app declares none", async () => {
  const dir = await project(
    { title: "Counter", build: { targets: ["server", "electron"] } },
    { "src/app.ts": entry() },
  );
  try {
    assertEquals(
      projectComponents(dir),
      [],
      "the ARRAY form is one app built for two shells — not two apps",
    );
    assertEquals(processPlan([], {}, dir).kind, "single");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("components: two targets sharing one entry are still one app", async () => {
  const dir = await project({
    title: "Counter",
    build: {
      targets: {
        server: { entry: "src/app.ts" },
        electron: { entry: "src/app.ts" },
      },
    },
  }, { "src/app.ts": entry() });
  try {
    assertEquals(
      projectComponents(dir),
      [],
      "the object form is not the signal — DISTINCT ENTRIES are",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("components: distinct entries are the project's parts", async () => {
  const dir = await project({
    title: "Rimote",
    build: {
      targets: {
        relay: { kind: "server", entry: "src/relay/app.ts" },
        agent: { kind: "electron", entry: "src/agent/app.ts" },
        control: { kind: "electron", entry: "src/control/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("relay", 9000),
    "src/agent/app.ts": entry("agent"),
    "src/control/app.ts": entry("control"),
  });
  try {
    const cs = projectComponents(dir);
    assertEquals(cs.map((c) => c.label), ["relay", "agent", "control"]);
    assertEquals(cs.map((c) => c.appId), ["relay", "agent", "control"]);
    assertEquals(cs[0]!.port, 9000, "a declared port is read from the entry");
    assertEquals(cs[1]!.port, undefined);
    assert(cs.every((c) => c.declaresAppId));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── The plan each command reads ─────────────────────────────────────────────

Deno.test("plan: no argument means the whole project", async () => {
  const dir = await project({
    build: {
      targets: {
        relay: { entry: "src/relay/app.ts" },
        agent: { entry: "src/agent/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("relay"),
    "src/agent/app.ts": entry("agent"),
  });
  try {
    const plan = processPlan([], {}, dir);
    assertEquals(plan.kind, "all");
    if (plan.kind === "all") assertEquals(plan.components.length, 2);

    const one = processPlan(["agent"], {}, dir);
    assertEquals(one.kind, "one");
    if (one.kind === "one") assertEquals(one.component.appId, "agent");

    // Flags naming an instance win — "this one" is never widened to "all".
    assertEquals(processPlan([], { app: "relay" }, dir).kind, "single");
    assertEquals(processPlan([], { port: 8000 }, dir).kind, "single");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plan: an unknown label lists the real ones", async () => {
  const dir = await project({
    build: {
      targets: {
        relay: { entry: "src/relay/app.ts" },
        agent: { entry: "src/agent/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("relay"),
    "src/agent/app.ts": entry("agent"),
  });
  try {
    const plan = processPlan(["agnet"], {}, dir);
    assertEquals(plan.kind, "error");
    if (plan.kind === "error") {
      assert(plan.message.includes("agnet"));
      assert(plan.message.includes("relay, agent"), plan.message);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plan: a label in a single-app repo says what components ARE", async () => {
  const dir = await project({ title: "Counter" }, { "src/app.ts": entry() });
  try {
    const plan = processPlan(["agent"], {}, dir);
    assertEquals(plan.kind, "error");
    // A refusal that does not teach the concept just says no twice.
    if (plan.kind === "error") {
      assert(plan.message.includes("build"), plan.message);
      assert(plan.message.includes("targets"), plan.message);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("plan: a component AND --app is a contradiction, not a refinement", async () => {
  const dir = await project({
    build: {
      targets: {
        relay: { entry: "src/relay/app.ts" },
        agent: { entry: "src/agent/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("relay"),
    "src/agent/app.ts": entry("agent"),
  });
  try {
    const plan = processPlan(["agent"], { app: "relay" }, dir);
    assertEquals(plan.kind, "error");
    if (plan.kind === "error") {
      assert(plan.message.includes("one or the other"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Identity, which is what makes them separable at all ─────────────────────

Deno.test("components: entries that resolve to ONE identity are refused", async () => {
  // No appId in either entry, and target labels that slug to the same thing.
  const dir = await project({
    appId: "one-app",
    build: {
      targets: {
        a: { entry: "src/a/app.ts", name: "same" },
        b: { entry: "src/b/app.ts", name: "same" },
      },
    },
  }, { "src/a/app.ts": entry(), "src/b/app.ts": entry() });
  try {
    const cs = projectComponents(dir);
    assertEquals(cs.length, 2);
    const conflict = componentConflict(cs);
    assert(conflict, "two apps under one identity must not be startable");
    assert(conflict.includes("same"), conflict);
    // The consequence and the fix, not just the fact.
    assert(conflict.includes("lock"), conflict);
    assert(conflict.includes("appId"), conflict);
    assertEquals(processPlan([], {}, dir).kind, "error");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("components: the entry's own appId wins over the target label", async () => {
  const dir = await project({
    build: {
      targets: {
        relay: { entry: "src/relay/app.ts" },
        agent: { entry: "src/agent/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("rimote-relay"),
    "src/agent/app.ts": entry("rimote-agent"),
  });
  try {
    const cs = projectComponents(dir);
    assertEquals(cs.map((c) => c.appId), ["rimote-relay", "rimote-agent"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entryDeclarations: reads identity without running the app", async () => {
  const dir = await project({}, {
    "src/app.ts": entry("thing", 7777),
    "src/none.ts": "export const x = 1;\n",
  });
  try {
    assertEquals(entryDeclarations(`${dir}/src/app.ts`), {
      appId: "thing",
      port: 7777,
    });
    assertEquals(entryDeclarations(`${dir}/src/none.ts`), {});
    assertEquals(entryDeclarations(`${dir}/src/missing.ts`), {}, "no throw");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Ports ───────────────────────────────────────────────────────────────────

// `am` does not invent a port. It used to assign each component a slot (8000,
// 8001, …) so siblings had predictable addresses — which recreated, one level
// up, the bug that made this area wrong: on a machine where something already
// owns 8000, that assignment IS a port conflict am created. The runtime's own
// answer for an app that declares nothing is `findFreePort()`, which is also
// what `deno task dev` does, so components follow it.
Deno.test("ports: a declared port is honoured, an undeclared one is not invented", () => {
  const declared: Component = {
    label: "agent",
    entry: "/b",
    appId: "agent",
    declaresAppId: true,
    port: 9100,
  };
  const silent: Component = {
    label: "relay",
    entry: "/a",
    appId: "relay",
    declaresAppId: true,
  };
  assertEquals(componentPort(declared), 9100);
  assertEquals(
    componentPort(silent),
    undefined,
    "undefined means the runtime picks a free one and says so — the same " +
      "answer `deno task dev` gives for the same app",
  );
  assertEquals(componentByLabel([declared, silent], "relay")?.appId, "relay");
  assertEquals(componentByLabel([declared, silent], "nope"), null);
});

// ── AIO_PORT ────────────────────────────────────────────────────────────────

// The operator rung between `--port` and `aio.run({ port })`. It exists for the
// contexts with no command line to hang a flag on — a systemd unit, a
// container, a compiled binary — which is also why aio does not read `.env`
// itself: `deno run --env-file` / `EnvironmentFile=` already deliver one, and
// `am` already forwards `--env-file` to the child (am-restart-flags).
//
// ONE reader (`paths.ts: envPort`), shared by the runtime and `am`, so the
// same environment cannot mean one port to the app and another to the tool
// inspecting it.
function withEnvPort<T>(value: string | null, fn: () => T): T {
  const had = Deno.env.get("AIO_PORT");
  try {
    if (value === null) Deno.env.delete("AIO_PORT");
    else Deno.env.set("AIO_PORT", value);
    return fn();
  } finally {
    if (had === undefined) Deno.env.delete("AIO_PORT");
    else Deno.env.set("AIO_PORT", had);
  }
}

Deno.test("AIO_PORT: unset or blank is 'nobody said', not a value", () => {
  withEnvPort(null, () => assertEquals(envPort(), undefined));
  withEnvPort("", () => assertEquals(envPort(), undefined));
  withEnvPort("   ", () => assertEquals(envPort(), undefined));
});

Deno.test("AIO_PORT: a port is read, and 0 keeps its meaning", () => {
  withEnvPort("9100", () => assertEquals(envPort(), 9100));
  withEnvPort(" 9100 ", () => assertEquals(envPort(), 9100));
  // 0 is the documented "pick a free one" — the same answer as saying nothing,
  // and NOT the falsy hole that once made a port-0 lock read back as invalid.
  withEnvPort("0", () => assertEquals(envPort(), 0));
});

// The whole point of the rung: an app that quietly ignores a misconfigured
// AIO_PORT and binds an ephemeral port instead is the silent failure this
// framework refuses. It must be impossible to set it wrong and not know.
Deno.test("AIO_PORT: a malformed value is refused, never ignored", () => {
  for (const bad of ["havoc", "80.5", "-1", "65536", "8000abc"]) {
    withEnvPort(bad, () => {
      assertThrows(
        () => envPort(),
        Error,
        "AIO_PORT",
        `AIO_PORT=${bad} must not be silently dropped`,
      );
    });
  }
});

Deno.test("AIO_PORT: --port outranks it, and it outranks nothing else here", () => {
  withEnvPort("9100", () => {
    assertEquals(declaredPort(7000), 7000, "the flag is this run's answer");
    assertEquals(declaredPort(), 9100, "with no flag, the environment speaks");
    // `--port=0` is a value, not an absence (AIO-212) — it must still win.
    assertEquals(declaredPort(0), 0);
  });
});
