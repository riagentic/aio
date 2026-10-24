// am-capture-helper.ts — run an `am` command function in-process and return
// its JSON reply, for tests that call `cmd*` directly.

/** Run an am command, return what it printed. `Deno.exit` is stubbed for the
 *  span: a command that exits throws instead, NAMING the reply that caused
 *  it — a real exit leaked its code into the next test of the file and said
 *  nothing about why (a flake seen once under load). */
export async function capture(fn: () => Promise<void>): Promise<unknown> {
  const orig = console.log;
  const origErr = console.error;
  const origExit = Deno.exit;
  let captured: unknown;
  const errs: string[] = [];
  // Only the command's own JSON reply is parsed. The flake's CAUSE: a reduce
  // over its budget under CPU load makes the app's reporter console.log a
  // pretty line from INSIDE the dispatch; parsing that threw there, aborted
  // the drain (DISPATCH_ABORTED), and the replay exited 1.
  const logs: string[] = [];
  console.log = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("{")) captured = JSON.parse(v);
    else logs.push(String(v));
  };
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  Deno.exit = ((code?: number) => {
    throw new Error(
      `the command called Deno.exit(${code}) — stdout: ${
        JSON.stringify(captured)
      } — stderr: ${JSON.stringify(errs)} — other output: ${
        JSON.stringify(logs)
      }`,
    );
  }) as typeof Deno.exit;
  try {
    await fn();
  } finally {
    console.log = orig;
    console.error = origErr;
    Deno.exit = origExit;
  }
  return captured;
}
