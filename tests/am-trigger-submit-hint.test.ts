// `am surface` reports a form as `events: ["submit"]`, so `am trigger <form>
// submit` is the obvious next move — and it used to land in a usage list of
// fifteen actions that does not contain the word the reader just typed, with
// nothing about forms in it.
//
// There is no `submit` action on purpose: these are the browser's real
// gestures, not shortcuts — the same rule that makes `type` fire
// keydown/input/keyup per character rather than assigning `.value`. A form is
// submitted by a person pressing Enter or clicking a button, and
// `ui-trigger.ts` dispatches `submit` from exactly that Enter press. So the
// fix is to name the gesture, not to add a synthetic action.
//
// The usage path calls Deno.exit, so this drives the real CLI.
import { assert } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;
const _covDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

async function amTrigger(args: string[]): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}src/am.ts`, "trigger", ...args],
    env: { ...Deno.env.toObject(), DENO_COVERAGE_DIR: _covDir },
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test("am trigger: `submit` names the gesture that submits a form", async () => {
  const msg = await amTrigger(["App:Form", "submit"]);
  assert(
    /there is no .?submit.? action/i.test(msg),
    `must say submit is not an action, got:\n${msg.slice(0, 500)}`,
  );
  // Both real gestures, because which one applies depends on the form.
  // Loose on the quoting: this text is read out of JSON, where the quotes
  // around Enter arrive escaped.
  assert(
    /press/i.test(msg) && /Enter/.test(msg),
    `must name the Enter press:\n${msg}`,
  );
  assert(/click/i.test(msg), `must name clicking the button:\n${msg}`);
});

Deno.test("am trigger: an ordinary bad action still gets the plain usage", async () => {
  // The hint is for the word the surface invites, not for every typo — a
  // usage message that grows a special case per mistake stops being read.
  const msg = await amTrigger(["App:Form", "clik"]);
  assert(
    !/there is no .?submit.? action/i.test(msg),
    `the submit hint leaked into an unrelated typo:\n${msg.slice(0, 400)}`,
  );
  assert(/usage: am trigger/.test(msg), `must still print usage:\n${msg}`);
});
