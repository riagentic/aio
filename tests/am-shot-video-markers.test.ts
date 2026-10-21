// `am shot --video --json` start event (t0) and `--markers`: where `am trigger`
// and the recorder meet (src/am/am-markers.ts).
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  shotVideoOptions,
  shotVideoStartEvent,
} from "../src/am/am-cmd-shot-video.ts";
import { unknownFlags } from "../src/am/am-flags.ts";
import {
  announceRecording,
  liveJournal,
  markerRegistryPath,
  markersFromJournal,
  markersPathFor,
  noteTrigger,
} from "../src/am/am-markers.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { runUITrigger } from "../src/air/ui-remote.ts";
import { lockDir } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("shotVideoOptions: --markers needs --video, takes no value, rides on the video", () => {
  assertEquals(shotVideoOptions(["--markers"], "app", "S").ok, false);
  assertEquals(
    shotVideoOptions(["--video", "--markers=1"], "app", "S").ok,
    false,
  );
  assertEquals(shotVideoOptions(["--video=a.mp4", "--markers"], "app", "S"), {
    ok: true,
    value: { path: "a.mp4", format: "mp4", durationMs: null, markers: true },
  });
  assertEquals(unknownFlags("shot", ["--video", "--markers"]), []);
});

Deno.test("shotVideoStartEvent: one JSON line — event, file, t0", () => {
  assertEquals(JSON.parse(shotVideoStartEvent("d.mp4", 1234)), {
    event: "recording",
    file: "d.mp4",
    t0: 1234,
  });
});

Deno.test("markersFromJournal: video clock, video px, out-of-window and torn lines dropped", () => {
  const lines = [
    {
      at: 1500,
      path: "App:Save",
      action: "click",
      rect: { x: 10, y: 5, w: 20.4, h: 8 },
    },
    { at: 1100, path: "window", action: "press" },
    { at: 999, path: "early", action: "click" }, // before t0
    { at: 9000, path: "late", action: "click" }, // after the end
  ].map((l) => JSON.stringify(l)).join("\n") + '\n{"at":12';
  assertEquals(markersFromJournal(lines, 1000, 2000, 2), [
    { t: 100, path: "window", action: "press", rect: null },
    {
      t: 500,
      path: "App:Save",
      action: "click",
      rect: { x: 20, y: 10, w: 41, h: 16 },
    },
  ]);
  assertEquals(markersPathFor("out/d.webm"), "out/d.webm.markers.json");
});

Deno.test("announceRecording ↔ liveJournal ↔ noteTrigger: found while live, gone after, ignored when the recorder died", async () => {
  const dir = await tempDir("am-markers-");
  try {
    await Deno.mkdir(lockDir(), { recursive: true });
    const journal = join(dir, "j.jsonl");
    assertEquals(liveJournal("mk-app", 4242), null);
    const off = await announceRecording("mk-app", 4242, journal);
    assertEquals(liveJournal("mk-app", 4242), journal);
    assertEquals(liveJournal("mk-app", 4243), null, "another instance's pid");
    await noteTrigger(journal, { at: 1, path: "a", action: "click" });
    await noteTrigger(journal, { at: 2, path: "b", action: "type" });
    assertEquals(
      (await Deno.readTextFile(journal)).trim().split("\n").length,
      2,
    );
    await off();
    assertEquals(liveJournal("mk-app", 4242), null);
    await off(); // idempotent
    // A recorder that died without cleaning up is not a recording.
    const gone = new Deno.Command(Deno.execPath(), { args: ["eval", "0"] })
      .spawn();
    await gone.status;
    await Deno.writeTextFile(
      markerRegistryPath("mk-app", 4242),
      JSON.stringify({ pid: gone.pid, journal }),
    );
    assertEquals(liveJournal("mk-app", 4242), null);
    await Deno.remove(markerRegistryPath("mk-app", 4242));
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("runUITrigger: rect:true returns the target's rect (measured before the action); absent otherwise", async () => {
  const App = () => h("button", { type: "button", onClick: () => {} }, "Save");
  await using ui = await testUI(App);
  await ui.settle();
  type R = { ok: boolean; rect?: unknown; error?: string };
  const plain = await runUITrigger({
    path: "SaveButton",
    action: "click",
  }) as R;
  assert(plain.ok, plain.error);
  assertEquals("rect" in plain, false);
  const withRect = await runUITrigger({
    path: "SaveButton",
    action: "click",
    rect: true,
  }) as R;
  assert(withRect.ok, withRect.error);
  const r = withRect.rect as Record<string, number>;
  assertEquals(Object.keys(r).sort(), ["h", "w", "x", "y"]);
  for (const v of Object.values(r)) assertEquals(typeof v, "number");
});
