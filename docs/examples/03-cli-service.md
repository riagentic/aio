# Tutorial: Headless Service with CLI Control

A start-to-finish walkthrough building a task queue service. No Electron, no
browser. Just a headless server you control via `am` and `connectCli`.

## What we're building

A job queue that accepts tasks via CLI or web, processes them in order, and
reports status. You will wire up:

- A headless aio server with scheduled processing
- A CLI client that subscribes to state and dispatches actions
- `am` commands for inspection and control
- Deployment as a systemd service with remote access

## Step 1: Project setup

Create a new directory and `deno.json`:

```json
{
  "title": "Task Queue",
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha3"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts --client=server-only",
    "am": "deno run -A jsr:@riagentic/aio@1.0.0-alpha3/src/am",
    "test": "deno test -A --unstable-kv tests/",
    "compile:service": "deno run -A jsr:@riagentic/aio@1.0.0-alpha3/src/build --compile --service --headless"
  }
}
```

No React, no esbuild, no browser dependencies. The `--client=server-only` flag
tells aio to skip browser/Electron entirely.

Run `deno install` to pull the framework.

## Step 2: Queue feature

Create `src/features/queue/index.ts`:

```ts
import { feature } from "aio";

export type Job = {
  id: string;
  task: string;
  status: "pending" | "processing" | "done" | "failed";
  createdAt: number;
  error?: string;
};

export const queue = feature("queue", {
  state: {
    jobs: [] as Job[],
    processing: null as string | null,
    completed: 0,
    failed: 0,
  },
  methods: {
    enqueue(s, task: string) {
      s.jobs.push({
        id: crypto.randomUUID().slice(0, 8),
        task,
        status: "pending",
        createdAt: Date.now(),
      });
    },
    complete(s, jobId: string) {
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "processing") return;
      job.status = "done";
      s.processing = null;
      s.completed += 1;
    },
    fail(s, jobId: string, error: string) {
      const job = s.jobs.find((j) => j.id === jobId);
      if (!job || job.status !== "processing") return;
      job.status = "failed";
      job.error = error;
      s.processing = null;
      s.failed += 1;
    },
    async process(s) {
      if (s.processing) return;
      const next = s.jobs.find((j) => j.status === "pending");
      if (!next) return;
      next.status = "processing";
      s.processing = next.id;
      // Simulate work -- replace with real logic
      try {
        await new Promise((r) => setTimeout(r, 2000));
        queue.complete(next.id);
      } catch (e) {
        queue.fail(next.id, e instanceof Error ? e.message : "unknown error");
      }
    },
  },
});
```

The `process` method is async -- each state mutation after an `await` goes
through the dispatch loop, so everything persists and shows up in time-travel
automatically.

## Step 3: Schedule-driven processing

Create `src/app.ts`:

```ts
import { aio } from "aio";
import { queue } from "./features/queue/index.ts";

await aio.run({
  appId: "task-queue",
  features: [queue],
  client: "server-only",
  schedules: [
    { id: "process-queue", every: 1000, action: queue.process() },
  ],
});
```

The scheduler dispatches `queue:process` every second. If nothing is pending or
a job is already running, the method returns early. No manual polling loop
needed.

Start it:

```sh
deno task dev
```

The server starts. No window opens -- that is the point. You will see the
`running (dev, server-only)` log with the HTTP and WS URLs.

## Step 4: CLI client

Create `src/cli.ts` -- a separate process that connects to the running server:

```ts
import { connectCli } from "aio";
import type { Job } from "./features/queue/index.ts";

type QueueState = {
  queue: {
    jobs: Job[];
    processing: string | null;
    completed: number;
    failed: number;
  };
};

const url = Deno.args[0] ?? "http://localhost:8000";
const cli = connectCli<QueueState>(url);

console.log("Connecting to", url);
const state = await cli.ready;
console.log("Connected. Jobs:", state.queue.jobs.length);

// Reactive display -- fires on every state change
cli.subscribe((s) => {
  const q = s.queue;
  const pending = q.jobs.filter((j) => j.status === "pending").length;
  console.log(
    `[queue] pending=${pending} processing=${
      q.processing ?? "none"
    } done=${q.completed} failed=${q.failed}`,
  );
});

// Enqueue from CLI args
const task = Deno.args[1];
if (task) {
  cli.send({ type: "queue:enqueue", payload: { args: [task] } });
  console.log(`Enqueued: ${task}`);
}
```

Run it in a second terminal while the server is up:

```sh
deno run -A src/cli.ts                                     # connect and watch
deno run -A src/cli.ts http://localhost:8000 "build v2.0"  # connect + enqueue
```

`connectCli` uses the same WebSocket delta protocol as the browser. It
auto-reconnects with exponential backoff and queues actions sent before the
connection opens.

> **Payload format:** Methods-style features expect `{ args: [...] }` as the
> payload. `queue.enqueue(task)` becomes
> `{ type: 'queue:enqueue', payload: { args: [task] } }`.

## Step 5: App manager (am)

`am` works out of the box — it finds the running instance via the lock file
created by `aio.run({ appId })`. Use `--app=X` to target a specific app.

Start the service in the background:

```sh
deno task am start
```

Inspect state:

```sh
deno task am state                         # full state
deno task am state queue.jobs              # just the jobs array
deno task am state queue.jobs[0]           # first job
deno task am state queue.{completed,failed} # pick fields
deno task am state queue --wait=2          # poll every 2s (Ctrl+C to stop)
```

Dispatch actions:

```sh
deno task am dispatch queue:enqueue task="deploy staging"
deno task am dispatch queue:enqueue task="run migrations"
```

Monitor:

```sh
deno task am schedules     # see process-queue timer
deno task am metrics       # uptime, connections
deno task am health        # exit 0 = ok
deno task am log --follow  # stream logs
```

Stop:

```sh
deno task am stop
```

> `am` output auto-detects the terminal. When piped, it emits JSON -- pipe to
> `jq` for scripting.

## Step 6: Deploy as systemd service

Compile a standalone binary:

```sh
deno task compile:service
```

This produces `task-queue` (binary) and `task-queue.service` (systemd unit) with
`ExecStart` set to `--headless --port=3000`. Install:

```sh
sudo cp task-queue /usr/local/bin/
sudo cp task-queue.service /etc/systemd/system/
sudo systemctl enable --now task-queue
journalctl -u task-queue -f
```

For remote access, add `--remote` to the compile command. That puts `--expose`
in ExecStart, which binds `0.0.0.0`, enables auto-HTTPS, and generates an auth
token (printed in the journal on first boot).

## Step 7: Remote CLI access

Once the service runs with `--expose`, connect from anywhere:

```ts
import { connectCli } from "aio";

const cli = connectCli<QueueState>("https://server.example.com:3000", {
  token: "your-auth-token-from-journal",
});

await cli.ready;
cli.subscribe((s) => console.log("Jobs:", s.queue.jobs.length));
cli.send({ type: "queue:enqueue", payload: { args: ["remote build"] } });
```

Same API, same code -- just a different URL and a token. `am` works remotely
too: `deno task am state --port=3000 --app=task-queue`.

## Step 8: Testing

Create `tests/queue.test.ts`:

```ts
import { testFeature } from "aio";
import { queue } from "../src/features/queue/index.ts";

testFeature(queue, "enqueue adds a pending job", (t) => {
  t.init();
  t.send.enqueue("build v2.0");
  t.expect.state((s) => s.jobs.length === 1);
  t.expect.state((s) => s.jobs[0].status === "pending");
  t.expect.state((s) => s.jobs[0].task === "build v2.0");
});

testFeature(queue, "process picks next pending job", async (t) => {
  t.init();
  t.send.enqueue("job-1");
  t.send.enqueue("job-2");
  t.send.process();
  await t.settle(3000);
  t.expect.state((s) => s.completed === 1);
  t.expect.state((s) => s.jobs[0].status === "done");
  t.expect.state((s) => s.jobs[1].status === "pending");
});

testFeature(queue, "random action fuzzing", (t) => {
  t.init();
  t.randomActions(50);
  t.expect.invariant((s) => Array.isArray(s.jobs));
  t.expect.invariant((s) => s.completed >= 0);
  t.expect.invariant((s) => s.failed >= 0);
});
```

Run:

```sh
deno task test
```

---

That covers the full service lifecycle: define features, schedule work, control
via CLI and `am`, compile to a binary, deploy with systemd, connect remotely. No
React, no Electron, no browser -- just aio doing what it does with state, on a
server.
