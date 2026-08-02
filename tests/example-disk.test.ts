// "ship a subprocess/filesystem template or example": counter and todo
// are both pure in-memory state, so the first real question a desktop app asks
// ("how do I shell out / touch the filesystem from a cell?") had only a prose
// answer. `examples/disk` is that answer, and this is its test.
//
// It also exercises the shape the report says every app re-invents: long-running
// work with a cancel path and no stale write (cancelOn: { open: ["self", …] }).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { testCell } from "../src/testing/cell-test.ts";
import { disk } from "../examples/disk/cell.ts";

/** A real temp tree — the cell reads the actual filesystem, no fixture layer. */
async function tree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "aio-disk-" });
  await Deno.mkdir(join(root, "big"));
  await Deno.mkdir(join(root, "small"));
  await Deno.mkdir(join(root, "big", "nested"));
  await Deno.writeFile(
    join(root, "big", "nested", "a.bin"),
    new Uint8Array(4096),
  );
  await Deno.writeFile(join(root, "small", "b.bin"), new Uint8Array(16));
  await Deno.writeFile(join(root, "loose.bin"), new Uint8Array(64)); // not a dir
  return root;
}

testCell(disk, "scans a folder: children sized, largest first", async (t) => {
  const root = await tree();
  try {
    await t.send.open(root);
    const s = t.getState();
    assertEquals(s.entries.map((e) => e.name), ["big", "small"]);
    assert(s.entries[0]!.bytes >= 4096, "nested files count toward the parent");
    assert(s.entries[1]!.bytes >= 16);
    assertEquals(s.scanning, false);
    assertEquals(s.error, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

testCell(disk, "a new open supersedes the scan still running", async (t) => {
  const root = await tree();
  try {
    // Both calls start immediately (production ordering), so the second really
    // does land while the first is walking — cancelOn: "self" aborts the first.
    const first = t.send.open(root); // would produce ["big", "small"]
    const second = t.send.open(join(root, "small"));
    await Promise.all([first, second]);
    const s = t.getState();
    assertEquals(s.path, join(root, "small"), "the newest folder wins");
    assertEquals(
      s.entries.map((e) => e.name),
      [],
      "and the superseded scan wrote nothing into it",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

testCell(
  disk,
  "stop() cancels a running scan and clears the flag",
  async (t) => {
    const root = await tree();
    try {
      const scanning = t.send.open(root);
      await t.send.stop();
      await scanning;
      const s = t.getState();
      assertEquals(s.scanning, false);
      assertEquals(s.entries, [], "an aborted scan never writes its results");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

testCell(disk, "up() walks to the parent folder", async (t) => {
  const root = await tree();
  try {
    await t.send.open(join(root, "big"));
    await t.send.up();
    await t.settle();
    assertEquals(t.getState().path, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

testCell(
  disk,
  "an unreadable path reports an error, not a crash",
  async (t) => {
    await t.send.open("/definitely/not/a/real/path");
    const s = t.getState();
    assert(s.error !== null, "the failure is visible in state");
    assertEquals(s.scanning, false, "and the app is not left spinning");
  },
);

// The UI half: rendered from the same cell, driven semantically — no selectors,
// no DOM scraping (docs/testing/ui-testing.md).
Deno.test("example disk: the UI renders a scan and drills into a folder", async () => {
  const { testUI } = await import("../src/testing/ui-test.ts");
  const App = (await import("../examples/disk/App.tsx")).default;
  const root = await tree();
  try {
    // No explicit `{ cells }`: the cell self-registers on import, which is how
    // an app is written. (This needed the workaround before `_resetAioRuntime`
    // stopped wiping the registry — see one app's testCell finding.)
    await using ui = await testUI(App);
    await disk.open(root);
    await ui.settle();

    assert(
      ui.surface().text.includes("big"),
      "the biggest folder is on screen",
    );
    assert(ui.surface().text.includes("small"));

    ui.Folders["open-big"].click(); // drill in
    await ui.waitFor(() => disk.path === join(root, "big"), "drilled into big");
    await ui.settle();
    assert(
      ui.surface().text.includes("nested"),
      `the child folder is listed:\n${ui.surface().text}`,
    );

    ui.Trail.up.click(); // and back out
    await ui.waitFor(() => disk.path === root, "walked back up");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
