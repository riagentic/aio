// amui UI, mounted for real (testUI). Stop / Restart / ▶ method confirmations used the native `confirm()`:
// a modal that freezes the renderer, so `am trigger` on amui hung with "client
// did not respond" until a human clicked the OS dialog, and the live tiles
// stopped updating behind it. The guard is now an inline bar — drivable by
// name, and the action runs only on Confirm.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import App from "../amui/src/App.tsx";
import { manager } from "../amui/src/manager.ts";
import type { DiscoveredProject, ProjectDetail } from "../amui/src/manager.ts";

const id = "/apps/probe#probe#home";
const running = {
  appId: "probe",
  pid: 1,
  port: 1,
  status: "started",
} as DiscoveredProject["running"];
const project = {
  id,
  path: "/apps/probe",
  name: "probe",
  meta: {
    name: "probe",
    version: null,
    target: "browser",
    tasks: {},
    isAio: true,
    entry: null,
  },
  running,
  git: false,
  self: false,
} as DiscoveredProject;
const detail = {
  id,
  path: "/apps/probe",
  name: "probe",
  running: true,
  appId: "probe",
  pid: 1,
  port: 1,
  status: "started",
  build: "dev",
  meta: project.meta,
  git: false,
  self: false,
  config: null,
  cells: { counter: ["increment"] },
  cpuPct: null,
  memMb: null,
  uptimeSec: null,
  connections: null,
  errors: null,
  schedules: null,
  at: new Date(0).toISOString(),
} as ProjectDetail;

const seed = {
  manager: { projects: [project], selectedId: id, detail },
};

// FIRST in the file: the contrast audit reports each colour pair once per
// process, so a later mount would see an earlier test's findings swallowed.
// amui's `dim` grey was 3–4:1 on its own panels — every session filled amui's
// log (which amui itself displays) with the dev contrast warning.
Deno.test("amui: its palette passes the dev contrast audit on every tab", async () => {
  // console.warn is wrapped BEFORE the mount: the first audit runs on the
  // first commit, inside testUI().
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
    warn(...a);
  };
  try {
    await using ui = await testUI(App, { seed });
    for (
      const tab of [
        "Overview",
        "Cells",
        "State",
        "Metrics",
        "Logs",
        "Tasks",
        "Codebase",
      ]
    ) {
      ui[`${tab}Button`].click();
      await ui.settle();
    }
    ui.StopButton.click();
    await ui.settle();
  } finally {
    console.warn = warn;
  }
  assertEquals(warned.filter((w) => w.includes("unreadable")), []);
});

testUI(
  App,
  "amui: Stop asks inline, Cancel leaves the app alone",
  { seed },
  async (ui) => {
    ui.StopButton.click();
    await ui.settle();
    assertEquals(ui.html().includes("Stop probe?"), true);
    ui.CancelButton.click();
    await ui.settle();
    assertEquals(ui.html().includes("Stop probe?"), false);
    await ui.expectCell(manager, (s: { actionMsg: string }) => !s.actionMsg);
  },
);

testUI(App, "amui: ▶ method runs only after Confirm", { seed }, async (ui) => {
  ui.CellsButton.click();
  // Invalid JSON: the dispatch answers without touching any process, so its
  // message proves the action ran — and its absence that it did not.
  ui["args-counter"].type("{");
  ui.IncrementButton.click();
  await ui.settle();
  assertEquals(ui.html().includes("Run counter:increment({) on probe?"), true);
  await ui.expectCell(
    manager,
    (s: { dispatchMsg: string }) => !s.dispatchMsg,
  );
  ui.ConfirmButton.click();
  await ui.expectCell(
    manager,
    (s: { dispatchMsg: string }) =>
      s.dispatchMsg === "payload is not valid JSON",
  );
});
