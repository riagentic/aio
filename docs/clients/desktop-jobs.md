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
  // No ceiling for the hours-long render. `browse` and `chooseOutput` need no
  // entry here: they block on a native DIALOG, and pickFile/pickDirectory lift
  // the ceiling themselves for as long as a person is deciding.
  long: ["colorize"],
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

`pickFile()` and `pickDirectory()` open the **native** dialog. Who opens it
depends on who asked:

- **the call came from your Electron window** — that window's main process opens
  it (`dialog.showOpenDialog(win, …)`): owned by the window, modal, in front, no
  child process, on all three OSes. Nothing to configure; a method or a serverFn
  called from the window takes this path, and so does a call with no caller (a
  schedule, `onStart`) while exactly one window is connected.
- **anyone else** — a browser tab, a script, `am dispatch` — gets the spawned
  desktop tool: zenity or kdialog on Linux, `osascript` on macOS, the Windows
  common dialogs (STA PowerShell, with a TopMost owner so the dialog is in front
  of the app).

Both paths take the same `PickOptions` and give the same results, cancel
included. The window path exists because a spawned dialog belongs to a
background process with no relation to any window: on Windows it opened BEHIND
the app, sometimes fully hidden, and no flag on the spawn could fix it.

On Windows a double-clicked app has no console, and Windows would give every
console program it starts — `openExternal`'s `cmd`, an update step, your own
`spawn()`, the dialog's PowerShell on the paths that still use it — a new
Terminal window. So at boot such an app attaches to one hidden console, and
every child shares it: no window, output intact (measured on Windows 11). An app
started from a terminal keeps its own console and is untouched.

The contract is about the endings, because that is what a hand-rolled wrapper
gets wrong:

| outcome             | result                                 |
| ------------------- | -------------------------------------- |
| user picked         | absolute path (`string`)               |
| user cancelled      | `null`                                 |
| no dialog installed | **throws**, naming what to install     |
| no desktop session  | **throws**, before spawning anything   |
| dialog failed       | **throws**, with the tool's own stderr |

(On the window path the last two rows are the window's: a dialog it could not
open, or a window that CLOSED while the dialog was up, throws — never `null`.)

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

### Talking to it — `stdin: true`

By default the child's stdin is closed (EOF at once), because a child that reads
stdin when it is a pipe blocks until it gets EOF — and a pipe nobody asked for
is a hang nobody can explain. Ask for it when the child takes input:

```ts
const repl = await spawn("python3", {
  args: ["-i", "-q"],
  stdin: true,
  onLine: (l) => s.transcript.push(l),
});
await repl.stdin!.write("print(2 + 2)\n");
await repl.stdin!.close(); //  EOF — the interpreter exits
const { code } = await repl.status;
```

A string is written as UTF-8; a `Uint8Array` as it is. `write()` rejects once
the child has exited or after `close()`, so a message into a closed pipe fails
instead of vanishing. Forgetting `close()` leaks nothing — the child's exit
closes the pipe — but a child that reads until EOF will wait for it.

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
- **A method that opens a picker needs no entry.** `pickFile`/`pickDirectory`
  lift the ceiling for as long as the dialog is open: waiting on a person is not
  the app being slow, and thirty seconds is an ordinary time to spend finding a
  folder.
- It lifts **both** ceilings — the caller-side `await job.colorize()` and the
  effect tracker's deadline — from one declaration.
- It applies wherever the cell runs, `testCell` and `testUI` included, so a test
  can `await` the job instead of starting it and polling.
- An explicit `perfBudget.methods["job:colorize"].timeout` still wins.

`long` removes a _deadline_. It does not make a method uncancellable — that is
`cancelOn` plus `s.$signal`, and a long method without one is a hang with a
nicer name.

## Cleaning up

### A spawned child does not die with your app

Every child `spawn()` starts runs in a **process group of its own**. That is
what lets `kill()` reach the whole tree instead of orphaning grandchildren — and
it is also why your app exiting does not stop them. Spawn a transcode, quit the
app, and the transcode keeps going, with nothing left that knows its pid.

Tie the job to the cell that owns it:

```ts
const job = await spawn("ffmpeg", { args, signal: s.$signal });
s.$do(own.set("encode", () => job.kill()));
```

If you forget, aio kills whatever is still running during shutdown and logs a
warning naming the commands. That is a backstop, not the plan: it runs at the
very end, after everything else has closed, so a job holding a file or a GPU
holds it for the whole shutdown.

Passing `s.$signal` covers the other half — a `cancelOn` supersession kills the
tree with no extra plumbing.

### Server-only I/O

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
