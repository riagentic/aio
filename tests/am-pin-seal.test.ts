// `am fix` SEALS an unpinned app — the floor under "an aio app runs forever".
//
// The guarantee: an app that builds today keeps building, on any machine, at any
// later framework version. That cannot rest on the framework staying
// compatible — it rests on the app naming the framework it was built against,
// and on that name still resolving years later. `am create` records the pin;
// this is the safety net for every app that reaches `am fix` without one,
// because an unpinned app silently links to whatever aio happens to be
// installed, which is precisely how a working app dies on a version it never
// asked for.
//
// Driven as a SUBPROCESS against a real clone with real tags and real
// worktrees: the whole claim is about a machine that has never seen the app.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { latestTag, readPin } from "../src/am/am-versions.ts";
import {
  linkSatisfiesPin,
  pinDisagreementHint,
  versionPath,
} from "../src/server/framework-pin.ts";

interface Sandbox {
  install: string;
  versions: string;
  app: string;
  cleanup: () => Promise<void>;
}

/** A throwaway clone of this repo plus its own versions dir, so nothing here
 *  touches the developer's real install. */
async function sandbox(
  pin?: string,
  files: Record<string, string> = {},
): Promise<Sandbox> {
  const base = await Deno.makeTempDir({ prefix: "aio-seal-" });
  const install = join(base, "install");
  const versions = join(base, "versions");
  const app = join(base, "app");
  const clone = await new Deno.Command("git", {
    // --no-hardlinks: /tmp is usually another filesystem, where a hardlinking
    // clone dies with "Invalid cross-device link".
    args: ["clone", "-q", "--no-hardlinks", Deno.cwd(), install],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(clone.success, new TextDecoder().decode(clone.stderr));
  await Deno.mkdir(join(app, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify(
      {
        name: "sealdemo",
        ...(pin ? { aioVersion: pin } : {}),
        imports: {
          aio: "./dep/aio/mod.ts",
          "aio/air": "./dep/aio/src/air.ts",
        },
      },
      null,
      2,
    ) + "\n",
  );
  for (const [rel, body] of Object.entries(files)) {
    const path = join(app, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return {
    install,
    versions,
    app,
    cleanup: () => Deno.remove(base, { recursive: true }).catch(() => {}),
  };
}

interface FixResult {
  fixed: number;
  results: { name: string; outcome: string; note: string }[];
}

/** Run a real `am <cmd>` the way a user would, in its own process. */
async function am(
  s: Sandbox,
  ...args: string[]
): Promise<{ code: number; out: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(Deno.cwd(), "src", "am.ts"), ...args],
    cwd: s.app,
    env: { AIO_HOME: s.install, AIO_VERSIONS_DIR: s.versions },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: p.code, out: dec.decode(p.stdout) + dec.decode(p.stderr) };
}

/** Run the real `am fix` the way a user's clone would, in its own process. */
async function amFix(s: Sandbox, ...args: string[]): Promise<FixResult> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "src", "am.ts"),
      "fix",
      "--json",
      ...args,
    ],
    cwd: s.app,
    env: { AIO_HOME: s.install, AIO_VERSIONS_DIR: s.versions },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const start = text.indexOf("{");
  assert(
    start >= 0,
    `am fix printed no JSON:\n${text}\n${new TextDecoder().decode(out.stderr)}`,
  );
  return JSON.parse(text.slice(start)) as FixResult;
}

const pinResult = (r: FixResult) =>
  r.results.find((x) => x.name === "aio version pin");

Deno.test("am fix seals an unpinned app at the version it links", async () => {
  const s = await sandbox();
  try {
    assertEquals(await readPin(s.app), null, "fixture starts unpinned");
    const want = await latestTag(s.install);
    assert(want, "the clone has release tags");

    const r = await amFix(s);
    const pin = pinResult(r);
    assert(pin, "am fix reports on the pin");
    assertEquals(pin.outcome, "fixed", `expected a seal, got: ${pin.note}`);

    // The committed fact.
    assertEquals(
      await readPin(s.app),
      want,
      "the app now names the framework it was built against",
    );
    // …and it is a fact the user was told about, not a silent edit.
    assertStringIncludes(pin.note, want);
    assertStringIncludes(pin.note, "deno.json");

    // The link points into the sealed version, not at some ambient install.
    const link = await Deno.readLink(join(s.app, "dep", "aio"));
    assertStringIncludes(link, join(s.versions, want));
    assert(
      await Deno.stat(join(link, "mod.ts")).then(() => true).catch(() => false),
      "the sealed version is a real checkout",
    );
  } finally {
    await s.cleanup();
  }
});

Deno.test("am fix --dry-run never writes the seal", async () => {
  const s = await sandbox();
  try {
    const before = await Deno.readTextFile(join(s.app, "deno.json"));
    const r = await amFix(s, "--dry-run");
    const pin = pinResult(r);
    assert(pin);
    assertEquals(pin.outcome, "would-fix");
    assertStringIncludes(pin.note, "aioVersion");
    assertEquals(
      await Deno.readTextFile(join(s.app, "deno.json")),
      before,
      "--dry-run reports; it does not touch the developer's file",
    );
    assertEquals(await readPin(s.app), null);
  } finally {
    await s.cleanup();
  }
});

Deno.test("am fix is idempotent — a sealed app is reported, not re-sealed", async () => {
  const s = await sandbox();
  try {
    const first = await amFix(s);
    assertEquals(pinResult(first)?.outcome, "fixed");
    const sealed = await readPin(s.app);

    const second = await amFix(s);
    assertEquals(pinResult(second)?.outcome, "ok", "already pinned");
    assertEquals(await readPin(s.app), sealed, "the pin does not drift");
  } finally {
    await s.cleanup();
  }
});

Deno.test("am fix never overwrites a pin the author chose", async () => {
  // The point of the seal is to record a fact, never to have an opinion: an
  // app deliberately held at an older framework must stay there.
  const older = "v1.0.0-alpha26";
  const s = await sandbox(older);
  try {
    assert(older !== await latestTag(s.install), "fixture is genuinely older");
    const r = await amFix(s);
    const pin = pinResult(r);
    assert(pin);
    assertEquals(pin.outcome, "ok", "the author's pin stands");
    assertEquals(await readPin(s.app), older);
    const link = await Deno.readLink(join(s.app, "dep", "aio"));
    assertStringIncludes(
      link,
      older,
      "an old pin links the OLD framework — that is the whole contract",
    );
  } finally {
    await s.cleanup();
  }
});

const LEGACY_CELL = `import { cell } from "aio";
export const demo = cell("demo", {
  state: { n: 0 },
  machine: { initial: "idle", states: { idle: {} } },
});
`;

Deno.test("am pin refuses a move that would break the app, and says where", async () => {
  // The ladder's whole point: the pin does not change until the app has been
  // read. A successful `am pin --latest` followed by a boot crash is the
  // failure mode — the tool would have certified a move it never checked.
  const s = await sandbox("v1.0.0-alpha26", { "src/cell.ts": LEGACY_CELL });
  try {
    const r = await am(s, "pin", "--latest");
    assertEquals(r.code, 1, `expected a refusal, got:\n${r.out}`);
    assertStringIncludes(r.out, "src/cell.ts:4");
    assertStringIncludes(r.out, "machine");
    assertStringIncludes(r.out, "--force");
    assertEquals(
      await readPin(s.app),
      "v1.0.0-alpha26",
      "a refused move must not have moved the pin",
    );
  } finally {
    await s.cleanup();
  }
});

Deno.test("am pin --force moves anyway — the check informs, it does not forbid", async () => {
  const s = await sandbox("v1.0.0-alpha26", { "src/cell.ts": LEGACY_CELL });
  try {
    const r = await am(s, "pin", "--latest", "--force");
    assertEquals(r.code, 0, `--force should proceed:\n${r.out}`);
    const now = await readPin(s.app);
    assert(now && now !== "v1.0.0-alpha26", `pin moved: ${now}`);
  } finally {
    await s.cleanup();
  }
});

Deno.test("am pin lets a modern app move forward without ceremony", async () => {
  const s = await sandbox("v1.0.0-alpha26", {
    "src/cell.ts":
      `import { cell } from "aio";\nexport const demo = cell("demo", { state: { n: 0 }, methods: {} });\n`,
  });
  try {
    const r = await am(s, "pin", "--latest");
    assertEquals(r.code, 0, `a clean app must not be blocked:\n${r.out}`);
  } finally {
    await s.cleanup();
  }
});

Deno.test("am pin reports how far behind the pin is", async () => {
  const s = await sandbox("v1.0.0-alpha26");
  try {
    const { pinInfo } = await import("../src/am/am-cmd-pin.ts");
    const info = await pinInfo(s.app, s.install);
    assert(
      info.behind !== null && info.behind > 0,
      `alpha26 is behind ${info.latest}, got behind=${info.behind}`,
    );
    // An unpinned app has no staleness to report — there is no pin to be stale.
    const fresh = await sandbox();
    try {
      assertEquals((await pinInfo(fresh.app, fresh.install)).behind, null);
    } finally {
      await fresh.cleanup();
    }
  } finally {
    await s.cleanup();
  }
});

Deno.test("am fix seals a local-checkout link with a path: pin, and the pin decider agrees", async () => {
  // Field case: dep/aio already links a LOCAL WORKING TREE (am link <path> /
  // am create --mirror). Sealing that with a VERSION string is
  // self-contradictory — linkDepAio keeps the working link, so aiol/doctor
  // (linkSatisfiesPin: a version pin must resolve to the versions store)
  // warned "pin does not match dep/aio" immediately after the fix that wrote
  // it. The local-dev pin exists for exactly this shape.
  const s = await sandbox();
  try {
    await Deno.mkdir(join(s.app, "dep"), { recursive: true });
    await Deno.symlink(s.install, join(s.app, "dep", "aio"));

    const r = await amFix(s);
    const pin = pinResult(r);
    assert(pin, "am fix reports on the pin");
    assertEquals(pin.outcome, "fixed", `expected a seal, got: ${pin.note}`);
    const sealed = await readPin(s.app);
    assert(
      sealed?.startsWith("path:"),
      `a local-tree link must seal as a path: pin, got ${sealed}`,
    );
    // …and the seal SAYS it is machine-specific, with the way out.
    assertStringIncludes(pin.note, "path:");
    assertStringIncludes(pin.note, "am pin --latest");

    // THE decider every reporter asks (aiol, doctor, am pin) agrees by
    // construction — no "pin does not match dep/aio" the moment fix exits.
    const link = await Deno.readLink(join(s.app, "dep", "aio"));
    assert(
      linkSatisfiesPin(sealed!, link),
      `pin ${sealed} contradicts the link ${link}`,
    );

    // aiol's own pin check passes on the app am fix just repaired.
    const { lintProject } = await import("../aiol/mod.ts");
    const report = await lintProject(s.app);
    const mismatch = report.issues.filter((i) =>
      i.message.includes("does not match dep/aio")
    );
    assertEquals(
      mismatch.map((i) => i.message),
      [],
      "aiol must not warn about the pin am fix just wrote",
    );

    // Idempotent: a second fix reports, never re-seals.
    const second = await amFix(s);
    assertEquals(pinResult(second)?.outcome, "ok");
    assertEquals(await readPin(s.app), sealed);
  } finally {
    await s.cleanup();
  }
});

// A version pin over a CHECKOUT link is a choice, not a defect — and the two
// tools that report it have to say the same thing (got #4).
//
// `dep/aio -> ../../aio` is the documented co-development setup. Writing the
// plain version — the obvious thing, and what the README implies — made doctor
// FAIL with "run `am fix`", which would have relinked away from the checkout
// the developer deliberately chose, while aiol WARNed with a different, better
// sentence. One link, two tools, two answers, and the only visible exit was the
// destructive one. `pinDisagreementHint` is now THE decider both read.
Deno.test("pin hint: a version pin over a checkout offers BOTH ways out", () => {
  const hint = pinDisagreementHint("1.0.0-alpha56", "/opt/aio-checkout");
  assert(hint, "a checkout link must produce a hint");
  assertStringIncludes(hint, "am pin path:/opt/aio-checkout");
  assertStringIncludes(hint, "am fix");
  assert(
    hint.indexOf("am pin path:") < hint.indexOf("am fix"),
    "keeping the checkout comes first — it is what the developer chose",
  );
});

Deno.test("pin hint: a link inside the version store gets no special hint", () => {
  // Here "run `am fix`" IS the whole answer, and a hint about path pins would
  // be noise pointing at a setup this app is not using.
  const inStore = versionPath("1.0.0-alpha56");
  assertEquals(pinDisagreementHint("1.0.0-alpha56", inStore), null);
});

Deno.test("pin hint: a path pin never disagrees with the link it names", () => {
  const checkout = "/opt/aio-checkout";
  assertEquals(
    pinDisagreementHint(`path:${checkout}`, checkout),
    null,
    "the sealed form is the fix — it cannot also be the complaint",
  );
  assert(
    linkSatisfiesPin(`path:${checkout}`, checkout),
    "and THE decider agrees, which is the point of sharing it",
  );
});

// A link that WORKS is not a link that is RIGHT. The pin said `main` (an
// author edited aioVersion, or ran `am pin`), dep/aio still pointed at the
// previous tag — and `am fix` reported "dep/aio framework link: ok", then the
// one-liner built a desktop app against a framework the app had just stopped
// pinning. One fact (which framework) decided in two places, with the wrong
// one winning silently. The pin is the fact; the link follows it.
Deno.test("am fix relinks dep/aio when the pin and the link disagree", async () => {
  const s = await sandbox();
  try {
    const want = await latestTag(s.install);
    assert(want, "the clone has release tags");
    await Deno.writeTextFile(
      join(s.app, "deno.json"),
      JSON.stringify(
        {
          name: "sealdemo",
          aioVersion: want,
          imports: { aio: "./dep/aio/mod.ts" },
        },
        null,
        2,
      ) + "\n",
    );
    // A perfectly usable aio — just not the pinned one.
    await Deno.mkdir(join(s.app, "dep"), { recursive: true });
    await Deno.symlink(s.install, join(s.app, "dep", "aio"));
    const linkOf = (r: FixResult) =>
      r.results.find((x) => x.name === "dep/aio framework link");

    const dry = await amFix(s, "--dry-run");
    assertEquals(linkOf(dry)?.outcome, "would-fix", linkOf(dry)?.note);
    assertStringIncludes(linkOf(dry)!.note, "was");
    assertStringIncludes(
      await Deno.readLink(join(s.app, "dep", "aio")),
      s.install,
      "--dry-run touched the link",
    );

    const r = await amFix(s);
    assertEquals(linkOf(r)?.outcome, "fixed", linkOf(r)?.note);
    assertStringIncludes(linkOf(r)!.note, s.install); // says what it was
    const link = await Deno.readLink(join(s.app, "dep", "aio"));
    assertStringIncludes(link, join(s.versions, want));
    // The decider reads the versions dir from the env — this process must see
    // the sandbox's, exactly as the child `am fix` did.
    Deno.env.set("AIO_VERSIONS_DIR", s.versions);
    try {
      assert(
        linkSatisfiesPin(want, link),
        "the pin decider agrees with the link am fix wrote",
      );
    } finally {
      Deno.env.delete("AIO_VERSIONS_DIR");
    }

    // Idempotent: the second run has nothing to say.
    const again = await amFix(s);
    assertEquals(linkOf(again)?.outcome, "ok", linkOf(again)?.note);
  } finally {
    await s.cleanup();
  }
});
