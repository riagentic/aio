// Framework version pinning — the mechanism that makes an aio app reproducible.
//
// The problem it solves: a source-layout app imports aio through a gitignored
// `dep/aio` symlink, so a committed app said NOTHING about which framework
// version it was written against. Clone it next month and `am fix` linked it to
// whatever aio happened to be installed — "it compiled last month" was not a
// fact you could reproduce.
//
// The mechanism: `"aioVersion"` in the app's committed deno.json, provisioned as
// a git worktree of the install clone, with `dep/aio` pointed at it. These tests
// drive the real thing — a real clone, real tags, real worktrees — because the
// whole value is that it works on a machine that has never seen the app.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  compareVersions,
  currentLink,
  ensureVersion,
  knownTags,
  latestTag,
  linkTo,
  newestVersion,
  parseVersion,
  provisioned,
  readPin,
  refOfLink,
  removeVersion,
  sortVersions,
  syncFrameworkDeps,
  versionPath,
  writePin,
} from "../src/am/am-versions.ts";
import { pinInfo } from "../src/am/am-cmd-pin.ts";

/** A throwaway clone of this repo (tags + history) plus its own versions dir, so
 *  nothing here touches the developer's real install. */
async function sandbox(): Promise<{
  root: string;
  versions: string;
  app: string;
  cleanup: () => Promise<void>;
}> {
  const base = await Deno.makeTempDir({ prefix: "aio-pin-" });
  const root = join(base, "install");
  const versions = join(base, "versions");
  const app = join(base, "app");
  const clone = await new Deno.Command("git", {
    // --no-hardlinks: /tmp is usually a different filesystem, and a hardlinking
    // clone dies there with "Invalid cross-device link".
    args: ["clone", "-q", "--no-hardlinks", Deno.cwd(), root],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(clone.success, new TextDecoder().decode(clone.stderr));
  await Deno.mkdir(app, { recursive: true });
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify(
      { name: "demo", imports: { aio: "./dep/aio/mod.ts" } },
      null,
      2,
    ) +
      "\n",
  );
  const prev = Deno.env.get("AIO_VERSIONS_DIR");
  Deno.env.set("AIO_VERSIONS_DIR", versions);
  return {
    root,
    versions,
    app,
    cleanup: async () => {
      if (prev === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
      else Deno.env.set("AIO_VERSIONS_DIR", prev);
      await Deno.remove(base, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("pin: a tag is provisioned as a worktree and linked", async () => {
  const s = await sandbox();
  try {
    const tags = await knownTags(s.root);
    assert(tags.length > 0, "the clone must carry release tags");
    const tag = tags[0]!;

    const res = await ensureVersion(s.root, tag);
    assert(res.ok, res.ok ? "" : res.error);
    assertEquals(res.created, true, "first call provisions it");
    // A real checkout of that exact tag — not a copy of the working tree.
    assertEquals(
      (await Deno.readTextFile(join(res.path, "deno.json"))).includes(
        tag.replace(/^v/, ""),
      ),
      true,
      `${res.path} should be aio ${tag}`,
    );

    // Second call is a no-op — an immutable pin is the whole point.
    const again = await ensureVersion(s.root, tag);
    assert(again.ok);
    assertEquals(again.created, false);

    await linkTo(s.app, res.path);
    assertEquals(await currentLink(s.app), versionPath(tag));
    assertEquals(refOfLink(versionPath(tag)), tag);
    assertEquals(await provisioned(), [tag]);
  } finally {
    await removeVersion(s.root, (await knownTags(s.root))[0]!).catch(() => {});
    await s.cleanup();
  }
});

Deno.test("pin: an unknown version fails loud, listing what exists", async () => {
  const s = await sandbox();
  try {
    const res = await ensureVersion(s.root, "v9.9.9-nope");
    assertEquals(res.ok, false);
    if (!res.ok) {
      assert(res.error.includes("v9.9.9-nope"), res.error);
      assert(
        /Known:/.test(res.error),
        `must list what IS available: ${res.error}`,
      );
    }
  } finally {
    await s.cleanup();
  }
});

Deno.test("pin: the app records it, and drift is detectable", async () => {
  const s = await sandbox();
  const tags = await knownTags(s.root);
  const [newer, older] = [tags[0]!, tags[1] ?? tags[0]!];
  try {
    assertEquals(await readPin(s.app), null, "starts unpinned");
    let info = await pinInfo(s.app, s.root);
    assertEquals(info.pinned, null);
    assertEquals(info.drift, false, "an unpinned app cannot drift");

    await writePin(s.app, older);
    assertEquals(await readPin(s.app), older);
    // The pin survives a re-read as valid JSON with the app's own fields intact.
    const cfg = JSON.parse(await Deno.readTextFile(join(s.app, "deno.json")));
    assertEquals(cfg.aioVersion, older);
    assertEquals(cfg.name, "demo", "the developer's own fields are untouched");
    assertEquals(cfg.imports.aio, "./dep/aio/mod.ts");

    // Linked to a DIFFERENT version than pinned → drift, which `am pin` reports
    // and exits non-zero on (a CI check for "this app is built wrong").
    const other = await ensureVersion(s.root, newer);
    assert(other.ok);
    await linkTo(s.app, other.path);
    info = await pinInfo(s.app, s.root);
    assertEquals(info.pinned, older);
    assertEquals(info.linkedRef, newer);
    assertEquals(
      info.drift,
      newer !== older,
      "asking for one version while building against another must be visible",
    );

    // Re-pinning twice must not duplicate the field.
    await writePin(s.app, newer);
    const raw = await Deno.readTextFile(join(s.app, "deno.json"));
    assertEquals(raw.match(/"aioVersion"/g)?.length, 1);
    assertEquals(JSON.parse(raw).aioVersion, newer);
  } finally {
    for (const tag of new Set([newer, older])) {
      await removeVersion(s.root, tag).catch(() => {});
    }
    await s.cleanup();
  }
});

Deno.test("pin: latestTag picks a release, never the branch tip", async () => {
  const s = await sandbox();
  try {
    const latest = await latestTag(s.root);
    assert(latest, "there must be a latest release");
    assert(latest.startsWith("v"), `expected a version tag, got ${latest}`);
    assertEquals(
      (await knownTags(s.root)).includes(latest),
      true,
      "the default pin must be a real tag — the branch tip is WIP by definition",
    );
  } finally {
    await s.cleanup();
  }
});

Deno.test("pin: linkTo never destroys a vendored copy", async () => {
  const s = await sandbox();
  try {
    // A real directory at dep/aio is someone's deliberately vendored framework.
    const dep = join(s.app, "dep", "aio");
    await Deno.mkdir(dep, { recursive: true });
    await Deno.writeTextFile(join(dep, "mod.ts"), "// vendored");
    let threw = false;
    try {
      await linkTo(s.app, s.root);
    } catch {
      threw = true;
    }
    assertEquals(
      threw,
      true,
      "replacing a vendored copy must refuse, not delete",
    );
    assertEquals(
      await Deno.readTextFile(join(dep, "mod.ts")),
      "// vendored",
      "the vendored copy is still there",
    );
  } finally {
    await s.cleanup();
  }
});

// ── Surviving alpha → beta → 1.0 → 2.0 ─────────────────────────
//
// The scheme has to keep working as aio itself grows up, which means three
// things must hold that a naive "latest tag" implementation gets wrong.

Deno.test("order: semver, not tag date — across the whole lifecycle", () => {
  const tags = [
    "v1.0.0-alpha9",
    "v1.0.0-alpha38",
    "v1.0.0-beta1",
    "v1.0.0",
    "v1.2.1",
    "v2.0.0-rc1",
    "v2.0.0",
  ];
  assertEquals(
    sortVersions(tags).map((v) => v.raw),
    [
      "v2.0.0",
      "v2.0.0-rc1",
      "v1.2.1",
      "v1.0.0",
      "v1.0.0-beta1",
      "v1.0.0-alpha38",
      "v1.0.0-alpha9",
    ],
    "alpha < beta < rc < final, and alpha38 > alpha9 (numeric, not lexical)",
  );
  // Date order would be wrong here in two ways at once: this very repo has an
  // abandoned v1.0.0-beta1 tagged BEFORE v1.0.0-alpha38, and post-1.0 a
  // maintenance release (v1.2.1) can be tagged after a new major.
  assertEquals(newestVersion(tags)?.raw, "v2.0.0");
});

Deno.test("order: --latest never crosses a major on its own", () => {
  const tags = ["v1.0.0", "v1.2.1", "v2.0.0"];
  assertEquals(
    newestVersion(tags, { major: 1 })?.raw,
    "v1.2.1",
    "a 1.x app offered `--latest` must get the newest 1.x — handing it 2.0 " +
      "would be a breaking upgrade nobody asked for",
  );
  assertEquals(
    newestVersion(tags)?.raw,
    "v2.0.0",
    "--major crosses explicitly",
  );
  assertEquals(newestVersion(tags, { major: 3 }), null, "no 3.x line yet");
});

Deno.test("pin: a moving ref is committed RESOLVED, so a clone reproduces it", async () => {
  const s = await sandbox();
  try {
    const first = await ensureVersion(s.root, "main");
    assert(first.ok, first.ok ? "" : first.error);
    assert(
      /^main-[0-9a-f]{7,}$/.test(first.ref),
      `"main" must resolve to an exact commit, got ${first.ref}`,
    );

    // Two apps tracking main get the SAME immutable checkout, not one mutable
    // directory that either can rewrite under the other.
    const second = await ensureVersion(s.root, "main");
    assert(second.ok);
    assertEquals(second.ref, first.ref);
    assertEquals(second.created, false);

    // And the resolved pin is provisionable on a machine that has never seen it
    // — which is what makes `git clone && am fix` reproduce a main-follower.
    await writePin(s.app, first.ref);
    assertEquals(await readPin(s.app), first.ref);
    const reproduced = await ensureVersion(s.root, first.ref);
    assert(reproduced.ok, reproduced.ok ? "" : reproduced.error);
    assertEquals(reproduced.ref, first.ref);
  } finally {
    for (const ref of await provisioned()) {
      await removeVersion(s.root, ref).catch(() => {});
    }
    await s.cleanup();
  }
});

Deno.test("pin: the framework's own dep versions are synced into the app", async () => {
  const s = await sandbox();
  try {
    const tag = (await knownTags(s.root))[0]!;
    const res = await ensureVersion(s.root, tag);
    assert(res.ok, res.ok ? "" : res.error);

    // An app carrying a RANGE where the framework pins an exact version is a
    // half-pin: `dep/aio/**` resolves through the APP's map, so the framework
    // would get whatever immer the range picks — and the day aio needs immer@^11
    // that app breaks at runtime while claiming to be pinned.
    const appCfg = join(s.app, "deno.json");
    await Deno.writeTextFile(
      appCfg,
      JSON.stringify(
        {
          name: "demo",
          imports: { aio: "./dep/aio/mod.ts", immer: "npm:immer@^10" },
        },
        null,
        2,
      ) + "\n",
    );
    const changes = await syncFrameworkDeps(s.app, res.path);
    const immer = changes.find((c) => c.key === "immer");
    assert(immer, `immer should be aligned: ${JSON.stringify(changes)}`);
    const after = JSON.parse(await Deno.readTextFile(appCfg));
    assertEquals(after.imports.immer, immer!.to);
    assert(
      /^npm:immer@\d/.test(after.imports.immer),
      `expected the framework's exact pin, got ${after.imports.immer}`,
    );
    assertEquals(after.name, "demo", "the app's own fields are untouched");
    assertEquals(after.imports.aio, "./dep/aio/mod.ts");

    // Idempotent: a second sync reports nothing.
    assertEquals((await syncFrameworkDeps(s.app, res.path)).length, 0);

    // A dep the app never declared is NOT added — no widening its graph.
    assert(!("esbuild" in after.imports));
  } finally {
    for (const ref of await provisioned()) {
      await removeVersion(s.root, ref).catch(() => {});
    }
    await s.cleanup();
  }
});
