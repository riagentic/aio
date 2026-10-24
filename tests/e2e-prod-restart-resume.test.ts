// A BUILT app restarted on the same build keeps its open tabs: the `boot`
// frame's id is the build's identity (src/server/server.ts `_bootId`), so the
// page does not reload — it resumes. Unit tests pin the id; nothing ran the
// resume itself. Here, end to end in a real browser against `--prod`: a call
// the page makes while the server is DOWN waits in the tab's in-memory queue
// (any reload loses it), the same build comes back on the same port, the
// queue flushes, and the call lands on the restored state.
//
// A prod server has no trojan, so the app reports through its own log: every
// mount says MOUNT, every `inc` says `INC <n>`. The second boot must say
// `INC 2` (the queued call, on the persisted 1) and never MOUNT (a reload).
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bootDir,
  BROWSER,
  launchBrowser,
  type Server,
  serverOutput,
  waitFor,
} from "./e2e-harness.ts";
import { makeApp } from "./e2e-app-harness.ts";

const CELL = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: {
    mount() { console.log("MOUNT"); },
    inc(s) { s.n += 1; console.log("INC " + s.n); },
  },
});
`;

// First mount of this tab (sessionStorage survives a reload): one call now,
// one 5 s later — by then the server is down.
const APP = `import { onMount } from "aio/air";
import { counter } from "./cell.ts";
export default function App() {
  onMount(() => {
    counter.mount();
    if (sessionStorage.getItem("armed")) return;
    sessionStorage.setItem("armed", "1");
    counter.inc();
    setTimeout(() => counter.inc(), 5000);
  });
  return <span t="n">{String(counter.n)}</span>;
}
`;

const said = (s: Server, what: string) => () =>
  serverOutput(s.proc).includes(what) ? true : null;

Deno.test({
  name:
    "e2e prod: a restart of the same build resumes the open tab — its queued call lands",
  ignore: BROWSER === null || Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: child processes, stopped below
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await makeApp("counter", "e2e-prod-resume-");
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), CELL);
    await Deno.writeTextFile(join(dir, "src", "App.tsx"), APP);
    let server: Server | undefined;
    let tab: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      const built = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "./dep/aio/src/build.ts", "--force"],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(built.code === 0, new TextDecoder().decode(built.stderr));
      server = await bootDir(dir, { args: ["--prod"] });
      const port = server.port;
      tab = await launchBrowser(`${server.base}/`);
      await waitFor("the first call landed", said(server, "INC 1"), 30_000);
      await server.stop(); // the timer fires while nothing is listening
      await new Promise((r) => setTimeout(r, 6000));
      server = await bootDir(dir, { port, args: ["--prod"] });
      await waitFor(
        "the queued call landed on the restored state",
        said(server, "INC 2"),
        30_000,
      );
      const out = serverOutput(server.proc);
      assert(!out.includes("MOUNT"), `the tab reloaded:\n${out}`);
      assertStringIncludes(out, "running (prod");
    } finally {
      await tab?.close();
      await server?.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
