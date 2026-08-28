// Testing an identity-dependent method without reaching into the framework.
//
// Field report (relay app, item 9): every relay method reads its caller from the ambient
// (`serverUser()`), which is the right design — a username passed as an
// argument is a forgery waiting to happen. But there was no supported way to
// TEST one: the mechanism (`runWithUser`) is framework-internal, so all 35 of
// their tests did
//
//     import { runWithUser } from "../dep/aio/src/server/auth-context.ts";
//
// reaching past the public surface into a file marked internal. `t.as(user,
// fn)` is that affordance, without publishing the AsyncLocalStorage plumbing.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testCell } from "../src/cell-test.ts";
import { serverUser } from "../src/server/auth-context.ts";

const notes = cell("as-user-notes", {
  state: { author: "", count: 0 },
  methods: {
    // The shape the report describes: identity comes from the ambient, never
    // from an argument the caller could forge.
    post(s: { author: string; count: number }) {
      s.author = serverUser()?.id ?? "anon";
      s.count += 1;
    },
  },
});

testCell(
  notes,
  "t.as: serverUser() answers with the ambient caller",
  async (t) => {
    await t.as({ id: "alice", role: "member" }, () => t.send.post());
    assertEquals(t.getState().author, "alice");
  },
);

testCell(
  notes,
  "t.as: omitting the user asserts the anonymous path",
  async (t) => {
    await t.send.post();
    assertEquals(
      t.getState().author,
      "anon",
      "no ambient caller ⇒ serverUser() is undefined, exactly as a public client",
    );
  },
);

testCell(
  notes,
  "t.as: the identity does not leak past its scope",
  async (t) => {
    await t.as({ id: "bob", role: "admin" }, () => t.send.post());
    assertEquals(t.getState().author, "bob");
    // A later call OUTSIDE the scope must not still be bob — an ambient that
    // leaked would make every subsequent assertion in the file a lie.
    await t.send.post();
    assertEquals(t.getState().author, "anon");
  },
);
