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
import { assert, assertEquals } from "@std/assert";
import {
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

Deno.test("ports: declared wins, otherwise a stable slot", () => {
  const cs = [
    { label: "relay", entry: "/a", appId: "relay", declaresAppId: true },
    {
      label: "agent",
      entry: "/b",
      appId: "agent",
      declaresAppId: true,
      port: 9100,
    },
    { label: "control", entry: "/c", appId: "control", declaresAppId: true },
  ];
  assertEquals(componentPort(cs, cs[0]!), { port: 8000, assigned: true });
  assertEquals(componentPort(cs, cs[1]!), { port: 9100, assigned: false });
  assertEquals(componentPort(cs, cs[2]!), { port: 8002, assigned: true });
  // Deterministic: a component keeps its address across restarts, so a client
  // pointed at :8002 is not re-pointed because a sibling started first.
  assertEquals(componentPort(cs, cs[2]!), componentPort(cs, cs[2]!));
  assertEquals(componentByLabel(cs, "agent")?.appId, "agent");
  assertEquals(componentByLabel(cs, "nope"), null);
});

// ── The commands that act on ONE app ────────────────────────────────────────
//
// `am start`/`stop`/`status` mean the project. Every other command — `state`,
// `logs`, `metrics`, `dispatch` — acts on one app, and in a component project
// there is no honest way to guess which. It used to guess anyway: the PROJECT's
// inferred id (deno.json `title` → "mc-probe") is not any component's id and
// never runs, so `am state` answered "no app named \"mc-probe\" is running" and
// listed five unrelated apps from other projects, in a directory where three
// real ones were up. An answer about an app that does not exist.
Deno.test("components: a one-app command refuses to guess, and names the parts", async () => {
  const dir = await project({
    title: "MC Probe",
    build: {
      targets: {
        relay: { entry: "src/relay/app.ts" },
        agent: { entry: "src/agent/app.ts" },
      },
    },
  }, {
    "src/relay/app.ts": entry("mcprobe-relay"),
    "src/agent/app.ts": entry("mcprobe-agent"),
  });
  const cwd = Deno.cwd();
  const errs: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  const realExit = Deno.exit;
  // BOTH streams: the refusal goes through the same failure path as every
  // other one, so a terminal gets the readable form on stderr and a script
  // gets `{"error": …}` on stdout. A test is not a terminal, so it sees the
  // second — and either way it must name the components.
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code?: number) => {
    throw new Error(`EXIT:${code}`);
  };
  try {
    Deno.chdir(dir);
    const { resolveAmAppId } = await import("../src/am/am-utils.ts");
    let thrown = "";
    try {
      resolveAmAppId();
    } catch (e) {
      thrown = (e as Error).message;
    }
    assertEquals(thrown, "EXIT:1", "it must refuse, not resolve a phantom");
    const msg = errs.join("\n");
    assert(msg.includes("relay") && msg.includes("agent"), msg);
    assert(msg.includes("--app="), "it must name the flag that resolves it");
    assert(msg.includes("am start"), "…and the verb that means all of them");

    // A label passed to --app resolves to that component's identity, so ONE
    // flag works for every command (their first positional is already taken by
    // a state path or an action).
    assertEquals(resolveAmAppId("agent"), "mcprobe-agent");
    // …and an id that is not a label still resolves as it always did.
    assertEquals(resolveAmAppId("something-else"), "something-else");
  } finally {
    Deno.chdir(cwd);
    console.error = realError;
    console.log = realLog;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = realExit;
    await Deno.remove(dir, { recursive: true });
  }
});
