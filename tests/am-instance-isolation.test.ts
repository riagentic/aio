// `am --instance=<name>` — a private copy, beside anyone else's.
//
// The singleton lock is on the appId and the appId picks the data home, so an
// agent could not run its own copy next to a human's: every `am dispatch`
// landed in the human's session and their clicks landed in the agent's
// measurements (report 6 §4). `--takeover` steals the lock; it never gave an
// isolated one.
//
// Not a new isolation mechanism. `single-instance-lock.ts` already says
// "AIO_APPS_DIR relocates the apps' DATA root — the lock/socket dir scopes with
// it, so ONE env var isolates an instance completely". This is a NAME for that,
// bound before any command resolves a lock, so the `am` process and the child
// it starts land in the same private world without either knowing about it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    // `Deno.Command` MERGES the parent env, and `--instance` yields to an
    // explicit `AIO_APPS_DIR` on purpose. So a leaked one in the test process
    // silently turns every case here into a no-op that still passes its
    // spelling — which is exactly how this file failed, pointing three hundred
    // files away from the tls module-level pin that caused it. Unless a case
    // sets it deliberately, it is cleared here.
    env: { AIO_APPS_DIR: "", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("am --instance: a named instance cannot see the shared world", async () => {
  const shared = await tempDir("am-instance-shared-");
  try {
    // An app "running" in the SHARED world.
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", shared);
    try {
      writeLock({
        appId: "the-humans-app",
        pid: Deno.pid,
        port: 4321,
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
      });
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
    }

    // The shared world sees it…
    const sharedView = await am(["instances", "--json"], {
      AIO_APPS_DIR: shared,
    });
    assertStringIncludes(sharedView.out, "the-humans-app");

    // …and a named instance does not. This is the whole point: an agent's
    // `am dispatch` must not reach the human's session.
    const isolated = await am(["instances", "--json", "--instance=agent1"], {
      HOME: shared,
    });
    assertEquals(isolated.code, 0, isolated.out + isolated.err);
    assertEquals(
      JSON.parse(isolated.out),
      [],
      "a named instance could see the shared world — the isolation is the " +
        "entire feature",
    );
  } finally {
    await dropTempDir(shared);
  }
});

Deno.test("am --instance: two instances cannot see each other", async () => {
  const home = await tempDir("am-instance-home-");
  try {
    // Write a lock INSIDE agent1's world by running am with its own scoping.
    const a1 = `${home}/.aio-instances/agent1`;
    await Deno.mkdir(a1, { recursive: true });
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", a1);
    try {
      writeLock({
        appId: "agent1-app",
        pid: Deno.pid,
        port: 1111,
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
      });
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
    }
    const one = await am(["instances", "--json", "--instance=agent1"], {
      HOME: home,
    });
    assertStringIncludes(one.out, "agent1-app");
    const two = await am(["instances", "--json", "--instance=agent2"], {
      HOME: home,
    });
    assertEquals(JSON.parse(two.out), [], "agent2 saw agent1's instance");
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("am --instance: an explicit AIO_APPS_DIR wins", async () => {
  // The more specific instruction. Silently relocating someone who set it by
  // hand is exactly the surprise this flag exists to prevent for everyone else.
  const explicit = await tempDir("am-instance-explicit-");
  try {
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", explicit);
    try {
      writeLock({
        appId: "explicit-app",
        pid: Deno.pid,
        port: 2222,
        startedAt: Date.now(),
        status: "started",
        cwd: Deno.cwd(),
      });
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
    }
    const r = await am(["instances", "--json", "--instance=ignored"], {
      AIO_APPS_DIR: explicit,
    });
    assertStringIncludes(
      r.out,
      "explicit-app",
      "--instance overrode an explicit AIO_APPS_DIR — the env var is the " +
        "more specific instruction and must win",
    );
  } finally {
    await dropTempDir(explicit);
  }
});

Deno.test("am --instance: a path-shaped name is refused, not turned into one", async () => {
  // The name becomes a directory segment. `../..` or `a/b` would either escape
  // the instances root or silently nest, and both are worse than a refusal.
  for (const bad of ["../escape", "a/b", ""]) {
    const r = await am(["instances", `--instance=${bad}`]);
    assertEquals(r.code, 1, `"${bad}" was accepted as an instance name`);
    assert(
      (r.out + r.err).includes("--instance needs a simple name"),
      `the refusal must say what a good name looks like: ${r.out}${r.err}`,
    );
  }
});
