// An async verdict is for the value it was started on. When the field then
// changes to a value its SYNC rules reject, the in-flight (or debounced) async
// run for the old value must not land: it used to — the sync-error branch
// returned without superseding it, so the old value's `null` verdict cleared
// the new value's sync error, and `form.valid` said true for an empty
// required field (and `form.validate()` let it submit).
import { assertEquals } from "@std/assert";
import { useForm } from "../src/air/form.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

for (const debounceMs of [0, 30]) {
  Deno.test(`form: a sync error is not cleared by the previous value's async verdict (debounceMs ${debounceMs})`, async () => {
    const form = useForm({
      user: {
        initial: "",
        rules: [(v: string) => (v.length > 0 ? null : "Required")],
        asyncRules: [async (_v: string) => {
          await delay(20);
          return null;
        }],
        debounceMs,
      },
    });
    const f = form.fields.user;
    f.set("alice");
    f.touch(); // async run for "alice" starts (or is debounced)
    f.set(""); // sync rule rejects "" — must supersede the "alice" run
    assertEquals(f.error, "Required");
    await delay(debounceMs + 60);
    assertEquals(f.error, "Required");
    assertEquals(f.validating, false);
    assertEquals(form.valid, false);
  });

  Deno.test(`form: going back to a value whose verdict is settled is not overwritten by the run it left (debounceMs ${debounceMs})`, async () => {
    const form = useForm({
      user: {
        initial: "",
        asyncRules: [async (v: string) => {
          await delay(20);
          return v === "taken" ? "Taken" : null;
        }],
        debounceMs,
      },
    });
    const f = form.fields.user;
    f.set("taken");
    f.touch();
    await delay(debounceMs + 60);
    assertEquals(f.error, "Taken"); // settled for "taken"
    f.set("free"); // a run for "free" starts
    f.set("taken"); // back: the settled verdict is restored…
    assertEquals(f.error, "Taken");
    await delay(debounceMs + 60);
    assertEquals(f.error, "Taken"); // …and the "free" run must not land on it
    assertEquals(form.valid, false);
  });
}
