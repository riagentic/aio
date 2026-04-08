// Audit regression: isValidSyncOp rejects malformed ops and proto-pollution
import { assertEquals } from "@std/assert";
import { isValidSyncOp } from "../../src/sync/server-handler.ts";

const valid = {
  id: "op-1",
  cell: "todos",
  action: "add",
  hlc: [1000, 0, "client-1"],
  payload: {},
};

Deno.test("valid op returns true", () => {
  assertEquals(isValidSyncOp(valid), true);
});

Deno.test("null input returns false", () => {
  assertEquals(isValidSyncOp(null), false);
});

Deno.test("undefined input returns false", () => {
  assertEquals(isValidSyncOp(undefined), false);
});

Deno.test("non-object input returns false", () => {
  assertEquals(isValidSyncOp("string"), false);
  assertEquals(isValidSyncOp(42), false);
});

Deno.test("missing id returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, id: undefined }), false);
});

Deno.test("empty id returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, id: "" }), false);
});

Deno.test("cell __proto__ returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, cell: "__proto__" }), false);
});

Deno.test("cell constructor returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, cell: "constructor" }), false);
});

Deno.test("action constructor returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, action: "constructor" }), false);
});

Deno.test("action prototype returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, action: "prototype" }), false);
});

Deno.test("hlc wrong length returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, hlc: [1, 0] }), false);
  assertEquals(isValidSyncOp({ ...valid, hlc: [1, 0, "a", "x"] }), false);
});

Deno.test("hlc[0] not number returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, hlc: ["x", 0, "a"] }), false);
});

Deno.test("hlc[2] not string returns false", () => {
  assertEquals(isValidSyncOp({ ...valid, hlc: [1, 0, 99] }), false);
});
