// The end-to-end CRUD story a field report rated highest: "the pieces are
// documented; the integration story isn't." `examples/contacts` is that story —
// a cell whose state array is backed by a SQLite table, with validation, and a
// UI that creates, edits and deletes. These tests drive it the way the docs
// tell people to: cell methods for logic, testUI for the screen.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { contacts } from "../examples/contacts/cell.ts";

testCell(contacts, "create → read → update → delete", async (t) => {
  t.init();
  await t.send.create({ name: "Ada", email: "ada@example.com", note: "math" });
  await t.send.create({ name: "Bob", email: "bob@example.com" });
  t.expect.state((s) => s.contacts.length === 2);

  // Ids are assigned by the cell, not the caller.
  const ada = t.getState().contacts[0]!;
  assertEquals(ada.id, 1);
  assertEquals(ada.note, "math");

  await t.send.update(ada.id, { email: "ada@lovelace.dev" });
  t.expect.state((s) => s.contacts[0]!.email === "ada@lovelace.dev");

  await t.send.remove(ada.id);
  t.expect.state((s) =>
    s.contacts.length === 1 && s.contacts[0]!.name === "Bob"
  );
});

testCell(
  contacts,
  "invalid input is refused, and the caller is told why",
  async (t) => {
    t.init();
    await assertRejects(
      () => t.send.create({ name: "", email: "a@b.co" }),
      Error,
      "name is required",
    );
    await assertRejects(
      () => t.send.create({ name: "Ada", email: "not-an-email" }),
      Error,
      "not an email address",
    );
    t.expect.state((s) => s.contacts.length === 0);

    // …and an update that would make a row invalid leaves it untouched.
    await t.send.create({ name: "Ada", email: "ada@example.com" });
    await assertRejects(
      () => t.send.update(1, { email: "broken" }),
      Error,
      "not an email address",
    );
    t.expect.state((s) => s.contacts[0]!.email === "ada@example.com");
  },
);

testCell(contacts, "operating on a missing row fails loud", async (t) => {
  t.init();
  await assertRejects(() => t.send.remove(999), Error, "no contact 999");
  await assertRejects(
    () => t.send.update(999, { note: "x" }),
    Error,
    "no contact 999",
  );
});

Deno.test("example contacts: the UI creates, edits and deletes", async () => {
  const { testUI } = await import("../src/testing/ui-test.ts");
  const App = (await import("../examples/contacts/App.tsx")).default;
  await using ui = await testUI(App);

  assert(ui.surface().text.includes("No contacts yet"), "starts empty");

  ui.NameInput.type("Ada");
  ui.EmailInput.type("ada@example.com");
  ui.add.click();
  await ui.expectCell(contacts, (c) => c.contacts.length === 1);
  assert(ui.surface().text.includes("ada@example.com"));

  // A bad address is refused, and the reason is on screen.
  ui.NameInput.type("Bob");
  ui.EmailInput.type("nope");
  ui.add.click();
  await ui.waitFor(
    () => ui.surface().text.includes("not an email address"),
    "the validation failure is shown, not swallowed",
  );
  await ui.expectCell(contacts, (c) => c.contacts.length === 1);

  // Edit, then delete.
  ui["edit-1"].click();
  await ui.settle(); // the edit field only exists once the row is in edit mode
  ui["email-edit"].clear();
  ui["email-edit"].type("ada@lovelace.dev");
  ui["save-1"].click();
  await ui.expectCell(
    contacts,
    (c) => c.contacts[0]!.email === "ada@lovelace.dev",
  );

  ui["delete-1"].click();
  await ui.expectCell(contacts, (c) => c.contacts.length === 0);
});
