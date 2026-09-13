// example-updates-show-again-and-errors.test.tsx — two things examples/updates
// taught wrong.
//
//   * "Show it again" called `undismiss()` alone. That forgets the "no" — and
//     the NEXT check re-offers — but `available` stays null, so the panel
//     vanished and nothing replaced it until the next poll (6h on prod): the
//     button looked like it had thrown the update away.
//   * Every error rendered as "Update check failed: …", including an install
//     failure and apply()'s refusal of a blocked release — and "Hide" on that
//     blocked release left the refusal on screen, because `dismiss()` cleared
//     the release but not its error.
import { assert, assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import App from "../examples/updates/src/App.tsx";
import { installUpdatesRuntime, updates } from "../src/updates.ts";

const offer = {
  version: "1.1.0",
  reason: "1.1.0 is newer than 1.0.0",
  notes: "faster boot",
  migrates: false,
  signed: true,
  keyFingerprint: "0badc0ffee11",
  size: null,
  releasedAt: null,
  warnings: [],
};

testUI(
  App,
  "example updates: 'Show it again' brings the offer back now, not at the next poll",
  {
    seed: {
      updates: {
        enabled: true,
        kind: "manifest",
        channel: "prod",
        current: "1.0.0",
        status: "idle",
        dismissed: "1.1.0",
      },
    },
  },
  async (ui) => {
    installUpdatesRuntime({
      kind: "manifest",
      channel: "prod",
      current: "1.0.0",
      currentUnknown: null,
      exposed: false,
      check: (o) =>
        Promise.resolve(
          o.dismissed === "1.1.0"
            ? { kind: "current", reason: "1.1.0 was dismissed" }
            : { kind: "offer", update: offer },
        ),
      apply: () => Promise.resolve(),
      setChannel: () => Promise.resolve(),
    });
    try {
      await ui.ShowItAgainButton.click();
      await ui.expectCell(
        updates,
        (u: { available: { version: string } | null; dismissed: unknown }) =>
          u.dismissed === null && u.available?.version === "1.1.0",
        "the offer is back on screen",
      );
      assert(ui.present("UpdateButton", "element"));
    } finally {
      installUpdatesRuntime(null);
    }
  },
);

testUI(
  App,
  "example updates: an error is not called a failed CHECK, and Hide takes it away with its release",
  {
    seed: {
      updates: {
        enabled: true,
        kind: "manifest",
        channel: "prod",
        current: "1.0.0",
        status: "error",
        blocked: { version: "2.0.0", blockers: ["data contract changed"] },
        error: "2.0.0 is blocked: data contract changed.",
      },
    },
  },
  async (ui) => {
    assert(!ui.html().includes("Update check failed"), ui.html());
    assert(ui.html().includes("2.0.0 is blocked"));
    await ui.HideButton.click();
    await ui.expectCell(
      updates,
      (u: { blocked: unknown; error: unknown }) =>
        u.blocked === null && u.error === null,
      "dismiss() clears the release and the error about it",
    );
    assertEquals(ui.html().includes("2.0.0 is blocked"), false);
  },
);
