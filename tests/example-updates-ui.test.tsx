// examples/updates was the one UI example nobody drove.
//
// It had a boot gate (does the server answer?) and a lint gate, and both passed
// while `App.tsx` — the entire point of that example — was never executed by
// any test. The example exists to show an app how to render `updates`, so the
// thing under test is exactly what it renders: the offer, the refusal, the
// blocked notice, and that the ordinary app underneath still works.
//
// Driven through `testUI` (the harness the docs recommend) rather than the
// hand-rolled DOM mounting the older example tests use, and seeded through
// `{ seed }` — update state is machine-dependent by nature, so a test that did
// not pin it would assert whichever branch the developer's box happened to be
// in.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import App from "../examples/updates/App.tsx";
import { notes } from "../examples/updates/cell.ts";

/** A release the user can take, mid-migration warning and all. */
const AVAILABLE = {
  enabled: true,
  kind: "manifest",
  channel: "stable",
  current: "1.0.0",
  status: "idle",
  available: {
    version: "1.1.0",
    reason: "1.1.0 is newer than 1.0.0",
    notes: "faster boot",
    migrates: true,
    signed: true,
    keyFingerprint: "0badc0ffee11",
    size: null,
    releasedAt: null,
    warnings: [],
  },
};

testUI(
  App,
  "example updates: the offer names the version, the notes and the migration",
  { seed: { updates: AVAILABLE } },
  async (ui) => {
    const html = ui.html();
    assertStringIncludes(html, "1.1.0");
    assertStringIncludes(html, "faster boot");
    // The two things a user must be told BEFORE clicking, not after.
    assertStringIncludes(html, "Your data will be migrated");
    assertStringIncludes(html, "The app will restart");
    // …and the footer says what is running, so "did it update?" is answerable.
    assertStringIncludes(html, "1.0.0");
    assertStringIncludes(html, "stable");
    // The Update button IS here — which is what gives the blocked case's
    // "no Update button" assertion below any meaning at all. Without this
    // contrast a renamed button would make that test pass for the wrong
    // reason, forever.
    assert(ui.present("UpdateButton", "element"), "an offer can be taken");

    // "Not now" is a real refusal: the offer goes away and the version is
    // remembered, so it is not re-offered on the next render.
    // Whether the release is authenticated, and by which key, where the
    // decision is actually made.
    assertStringIncludes(html, "signed");
    assertStringIncludes(html, "0badc0ffee11");

    await ui.NotNowButton.click();
    const { updates } = await import("../src/updates.ts");
    await ui.expectCell(
      updates,
      (u: { available: unknown; dismissed: unknown }) =>
        u.available === null && u.dismissed === "1.1.0",
      "dismiss() clears the offer and records the version",
    );
    assert(
      !ui.html().includes("faster boot"),
      "the banner is gone once dismissed",
    );
  },
);

testUI(
  App,
  "example updates: a BLOCKED release is shown with its reason and no Update button",
  {
    seed: {
      updates: {
        enabled: true,
        channel: "stable",
        current: "1.0.0",
        blocked: { version: "2.0.0", blockers: ["data contract changed"] },
      },
    },
  },
  (ui) => {
    const html = ui.html();
    // Hiding it would read as "you are up to date" — the example's own comment.
    assertStringIncludes(html, "2.0.0");
    assertStringIncludes(html, "data contract changed");
    // No Update button here on purpose: apply() would refuse it.
    assert(
      ui.absent("UpdateButton", "element"),
      "a blocked release must not offer an Update button",
    );
  },
);

testUI(
  App,
  "example updates: the app underneath still works while an update is offered",
  { seed: { updates: AVAILABLE } },
  async (ui) => {
    await ui.AddANoteButton.click();
    await ui.expectCell(
      notes,
      (n: { items: string[] }) => n.items.length === 1,
      "the note reached the cell",
    );
    assertEquals(ui.html().includes("note "), true);
  },
);
