// Capture what the framework PRINTS, on every channel.
//
// The level now picks the console method (`console.error` / `warn` / `info` /
// `debug`), not just the word in the line — so a test that stubs `console.log`
// alone sees nothing when a warning fires, and asserts "no warning" over an app
// that warned loudly. That failure is silent and looks like a pass, which is
// the one shape a test must never have.
//
// So capture is a helper rather than four lines copied into each test: one
// place to change when a channel is added, and no test can capture half.

/** Every line printed by `fn`, in order, whichever channel it went to. */
export function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const restore = interceptConsole(lines);
  try {
    fn();
  } finally {
    restore();
  }
  return lines;
}

/** Async twin of {@link captureConsole}. */
export async function captureConsoleAsync(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const restore = interceptConsole(lines);
  try {
    await fn();
  } finally {
    restore();
  }
  return lines;
}

/** Lower-level form: start capturing into `sink`, get the restore back. */
export function interceptConsole(sink: string[]): () => void {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const push = (...a: unknown[]) => void sink.push(a.map(String).join(" "));
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  console.debug = push;
  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
    console.debug = orig.debug;
  };
}
