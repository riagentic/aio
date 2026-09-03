// The PERSIST_ERROR tip said "check disk space and file permissions" for
// EVERY persist failure — a planner refusal ("bound to a state value that is
// not an array"), a UNIQUE violation, a value SQLite cannot hold. The reader
// then checked the one thing that was not wrong. The disk advice is now given
// only when the cause is a disk-class error; everything else points back at
// the message.
import { assert } from "@std/assert";
import { createAioError, generateTip } from "../src/diagnostics/error.ts";

const tip = (raw: unknown) =>
  generateTip(createAioError("PERSIST_ERROR", raw, {})) ?? "";

Deno.test("PERSIST_ERROR tip: disk advice for disk-class causes only", () => {
  for (
    const disk of [
      new Error("Permission denied (os error 13): writefile '/x/journal'"),
      new Error("No space left on device (os error 28)"),
      new Error("SQLITE_READONLY: attempt to write a readonly database"),
      new Error("database is locked"),
    ]
  ) {
    assert(/disk space and file permissions/.test(tip(disk)), disk.message);
  }
  for (
    const notDisk of [
      new Error(
        'db: table "extra" is bound to a state value that is not an array (it is a undefined).',
      ),
      new Error("UNIQUE constraint failed: users.id"),
      new Error(
        "db: state.notes.items[0].when is a Date — SQLite cannot hold it",
      ),
    ]
  ) {
    const t = tip(notDisk);
    assert(!/disk space and file permissions/.test(t), notDisk.message);
    assert(/fix that at its source/.test(t), t);
  }
});
