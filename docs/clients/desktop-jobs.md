# Desktop apps that drive a CLI

The shape: a window, a **Browse…** button, a long-running external process, a
progress bar, and Stop / Pause / Resume. Video encoders, model runs, backups,
builds, disk scans — the class of app where the UI is small and the job is
everything.

Four framework pieces cover the parts every one of these apps used to write by
hand: `pickFile` / `pickDirectory`, `spawn`, `long`, and `cancelOn`.

```ts
import { cell } from "aio";
import { pickDirectory, pickFile, spawn } from "aio/server";

/** Your own parser for the tool's progress output. */
declare function parsePercent(line: string): number | undefined;

export const job = cell("job", {
  state: { input: "", outDir: "", pct: 0, status: "idle", paused: false },
  long: ["colorize"], //  no time ceiling — this one runs for hours
  cancelOn: { colorize: ["self", "job:stop"] }, //  Stop, and restart-supersedes
  methods: {
    async browse(s) {
      const f = await pickFile({
        filters: [{ name: "Video", extensions: ["mp4", "mkv"] }],
      });
      if (f === null) return; //  cancelled — a normal outcome
      s.input = f;
    },
    async chooseOutput(s) {
      const d = await pickDirectory({ startIn: s.outDir });
      if (d !== null) s.outDir = d;
    },
    async colorize(s) {
      s.status = "running";
      const proc = await spawn("ffmpeg", {
        args: ["-i", s.input, `${s.outDir}/out.mp4`],
        onLine: (line) => {
          s.pct = parsePercent(line) ?? s.pct;
        },
        signal: s.$signal, //  cancelOn kills the whole process tree
      });
      const { code } = await proc.status;
      s.status = code === 0 ? "done" : "failed";
    },
    stop(s) {
      s.status = "stopping";
    }, //  the cancelOn trigger
  },
});
```

## Choosing a path

`pickFile()` and `pickDirectory()` open the **native** dialog — zenity or
kdialog on Linux, `osascript` on macOS, the Windows common dialogs (STA
PowerShell). They are on `aio/server`: they spawn a desktop binary.

The contract is about the endings, because that is what a hand-rolled wrapper
gets wrong:

| outcome             | result                                 |
| ------------------- | -------------------------------------- |
| user picked         | absolute path (`string`)               |
| user cancelled      | `null`                                 |
| no dialog installed | **throws**, naming what to install     |
| no desktop session  | **throws**, before spawning anything   |
| dialog failed       | **throws**, with the tool's own stderr |

A missing `zenity` and a pressed Cancel are the same exit code — three apps
conflated them, and at least one shipped a Browse button that silently did
nothing. Here, only a real cancel is `null`.

```ts
const files = await pickFile({ multiple: true }); //  string[] | null — never []
```

`startIn` accepts a file path as well as a directory (its directory is used), so
"reopen where the last pick landed" is one line. `filters` take bare extensions;
a leading dot is tolerated.

You can still write your own dialog — nothing here is privileged.

## Running the job

`spawn(cmd, opts)` returns a handle once the child is running **in a process
group of its own**:

```ts
const proc = await spawn("python", {
  args: ["worker.py"],
  cwd: workdir,
  onLine: (line, stream) => { … },  //  every line, as it arrives
  signal: s.$signal,                //  abort ⇒ the tree is killed
  killGraceMs: 2000,                //  SIGTERM → SIGKILL after this
});

proc.pid;               //  the process-GROUP id
proc.pause();           //  SIGSTOP the whole group
proc.resume();          //  SIGCONT
await proc.kill();      //  SIGCONT → SIGTERM → SIGKILL, to the group
const { code, signal, success } = await proc.status;
```

Three things it does that are easy to get wrong, and that cost a real app a real
bug:

- **The group is the child's own.** Deno starts children in the _caller's_
  process group, so a negative-pid signal would hit your app. `spawn` launches
  through a session leader (`setsid`, or `perl`'s `POSIX::setsid()` on macOS)
  and **refuses to start** if it can't — an ungrouped child whose `kill()`
  orphans every grandchild is worse than no child at all.
- **`kill()` sends SIGCONT first.** A stopped process cannot handle SIGTERM, so
  "pause, then stop" otherwise leaves the tree alive and the app waiting.
- **`\r` ends a line.** Progress bars rewrite one line and emit no newline for
  the whole job; `onLine` fires on `\r`, `\n` and `\r\n`.

> `Deno.Command("kill", ["-STOP", "-1234"])` exits 0 and signals **nothing** —
> procps `kill` does not read a negative pid as a group. `Deno.kill(-pid, …)`
> does. That one line is why this API exists rather than a doc page.

Windows has no process groups or `SIGSTOP`: `kill()` uses `taskkill /T`, and
`pause()` / `resume()` **throw** rather than pretend.

## Letting it take as long as it takes

An async method has a 30s ceiling (`effectTimeoutMs`) so a method that never
settles cannot hang its caller forever. A method that legitimately runs for
hours says so where it is defined:

```ts
cell("job", {
  long: ["colorize", "refreshScratch"], //  checked against the method list
  methods: { async colorize(s) { … } },
});
```

- A typo throws at `cell()` time, with the known async methods listed.
- It lifts **both** ceilings — the caller-side `await job.colorize()` and the
  effect tracker's deadline — from one declaration.
- It applies wherever the cell runs, `testCell` and `testUI` included, so a test
  can `await` the job instead of starting it and polling.
- An explicit `perfBudget.methods["job:colorize"].timeout` still wins.

`long` removes a _deadline_. It does not make a method uncancellable — that is
`cancelOn` plus `s.$signal`, and a long method without one is a hang with a
nicer name.

## Cleaning up

Server-only I/O in a cell method is flagged by the dev-server graph check,
because a client-reachable path that calls `Deno.remove` blank-screens the
browser. When the path genuinely only runs on the server, say so:

```ts
// aio-ok: server-only — scratch cleanup for a file this method itself created
await Deno.remove(tmp);
```

The marker works on the line or on the comment line above it. It silences the
**warning** (`server-only-api`) only — a guaranteed break, like importing
`node:fs` into a browser-reachable module, is not a matter of opinion and stays
loud.

## See also

- [state/methods](../state/methods.md) — `cancelOn`, `$signal`, supersession
- [build/imports](../build/imports.md) — why the Deno-only half lives in a
  `*.server.ts` module
- [examples/disk](../../examples/disk/) — subprocesses, supersession and the
  `.server.ts` boundary in a complete app
