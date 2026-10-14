// A `deno test --preload` module: every test a file REGISTERS is written to
// `AIO_RECORD_TESTS` as a line of JSON (`{ file, name, ignore }`) and none is
// run. With `AIO_RECORD_OS` the file is loaded as that OS would load it
// (`Deno.build.os`), so its `ignore` expressions answer for that OS.
//
// This is how the mutation ledger learns where a row's test runs
// (tests/mutation-ledger.test.ts): an `ignore` is an expression over
// constants, helpers and row tables — reading it is guessing, evaluating it
// is not. Checked against a real Windows host: the same answer for every row.
const os = Deno.env.get("AIO_RECORD_OS");
if (os) {
  Object.defineProperty(Deno, "build", { value: { ...Deno.build, os } });
}
const out = Deno.env.get("AIO_RECORD_TESTS")!;
// deno-lint-ignore no-explicit-any
const record = (ignored: boolean) => (...args: any[]) => {
  let name = "";
  let ignore = ignored;
  for (const a of args) {
    if (typeof a === "string") name = a;
    else if (typeof a === "function") name ||= a.name;
    else if (a && typeof a === "object") {
      if (typeof a.name === "string") name = a.name;
      if (a.ignore) ignore = true;
    }
  }
  Deno.writeTextFileSync(
    out,
    JSON.stringify({ file: Deno.mainModule, name, ignore }) + "\n",
    { append: true },
  );
};
Object.assign(Deno, {
  test: Object.assign(record(false), {
    ignore: record(true),
    only: record(false),
  }),
});
