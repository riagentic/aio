# Build a Real-Time Monitoring Dashboard

A start-to-finish walkthrough. You type along, building a server metrics
dashboard that tracks CPU, memory, and request counts. Multiple browser tabs
stay in sync. Per-user auth controls who sees what. SQLite stores history for
queries. By the end you will have used: features, scheduling, SQLite
persistence, auth, React UI, and testing -- all in one app.

## Step 1: Project setup

Create a directory and add `deno.json`:

```json
{
  "title": "Metrics Dashboard",
  "nodeModulesDir": "auto",
  "unstable": ["kv"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "jsxImportSourceTypes": "@types/react"
  },
  "imports": {
    "aio": "jsr:@riagentic/aio@1.0.0-alpha5",
    "@types/react": "npm:@types/react@^18",
    "react": "npm:react@^18",
    "react-dom": "npm:react-dom@^18",
    "esbuild": "npm:esbuild@^0.24"
  },
  "tasks": {
    "dev": "deno run -A src/app.ts",
    "test": "deno test -A --unstable-kv src/"
  }
}
```

Run `deno install`, then build toward this structure:

```
deno.json
src/
  app.ts
  App.tsx
  features/metrics/index.ts
  features/metrics/metrics.test.ts
```

## Step 2: Metrics feature

The metrics feature owns CPU, memory, request count, and a history buffer. Sync
methods update values; an async method persists a request record.

```ts
// src/features/metrics/index.ts
import { feature } from "aio";

export type Snapshot = { cpu: number; mem: number; ts: number };

export const metrics = feature("metrics", {
  state: {
    cpu: 0,
    mem: 0,
    requests: 0,
    history: [] as Snapshot[],
  },

  methods: {
    update(s, cpu: number, mem: number) {
      s.cpu = cpu;
      s.mem = mem;
      const snap: Snapshot = { cpu, mem, ts: Date.now() };
      s.history.push(snap);
      // Keep last 100 snapshots in memory
      if (s.history.length > 100) s.history = s.history.slice(-100);
    },

    async recordRequest(s) {
      s.requests += 1;
    },
  },
});
```

`update` is synchronous -- it mutates the Immer draft directly. `recordRequest`
is async, which means it goes through the full dispatch/effect pipeline and can
be awaited from other features.

> **Tip:** Keep the history array bounded. SQLite handles the full archive; the
> in-memory buffer is just for the sparkline.

## Step 3: Schedule polling

The server needs to poll system metrics on an interval. aio's scheduler handles
this declaratively -- no `setInterval` in your code. Add an async `poll` method
that reads real system data:

```ts
// src/features/metrics/index.ts — add this method
    async poll(s) {
      // Deno built-in: loadavg for CPU approximation, memoryUsage for heap
      const [load1] = Deno.loadavg()  // 1-minute load average
      const mem = Deno.memoryUsage()
      const cpuPct = Math.min(load1 * 100, 100)
      const memMB = Math.round(mem.rss / 1_048_576)
      s.cpu = cpuPct
      s.mem = memMB
      s.history.push({ cpu: cpuPct, mem: memMB, ts: Date.now() })
      if (s.history.length > 100) s.history = s.history.slice(-100)
    },
```

Wire it up in `app.ts` with a static schedule:

```ts
// src/app.ts
import { aio } from "aio";
import { metrics } from "./features/metrics/index.ts";

await aio.run({
  appId: "dash",
  features: [metrics],
  schedules: [
    { id: "poll-metrics", every: 5000, action: metrics.poll() },
  ],
});
```

Every 5 seconds the server collects real data and pushes it to all connected
clients automatically.

## Step 4: SQLite persistence

The in-memory history resets on restart. Add SQLite to keep a permanent record.

```ts
// src/app.ts
import { aio, integer, pk, real, table } from "aio";
import { metrics } from "./features/metrics/index.ts";

await aio.run({
  appId: "dash",
  features: [metrics],
  schedules: [
    { id: "poll-metrics", every: 5000, action: metrics.poll() },
  ],
  db: {
    history: table({
      id: pk(),
      cpu: real(),
      mem: real(),
      ts: integer(),
    }),
  },
});
```

The `history` key matches the `history` array in the metrics state. aio
auto-syncs: after each reducer run, changed arrays are diffed and written to
SQLite. On startup, rows load back into state. With a `pk()` column, sync is
incremental -- inserts, updates, and deletes, not a full table replacement.

The `id` field needs to be set by your code since `pk()` is user-assigned.
Update the push logic:

```ts
update(s, cpu: number, mem: number) {
  s.cpu = cpu
  s.mem = mem
  const snap: Snapshot = { cpu, mem, ts: Date.now(), id: Date.now() }
  s.history.push(snap)
  if (s.history.length > 100) s.history = s.history.slice(-100)
},
```

And add `id` to the `Snapshot` type:

```ts
export type Snapshot = { id: number; cpu: number; mem: number; ts: number };
```

The full history lives in SQLite. The in-memory array holds the last 100 for the
UI sparkline.

## Step 5: Per-user auth

Two users: an admin who sees everything, and a viewer who sees only the summary.

```ts
// src/app.ts
import type { AioUser } from "aio";

const users: Record<string, AioUser> = {
  "admin-token-123": { id: "admin", role: "admin" },
  "viewer-token-456": { id: "viewer", role: "viewer" },
};

await aio.run({
  appId: "dash",
  features: [metrics],
  users,
  schedules: [
    { id: "poll-metrics", every: 5000, action: metrics.poll() },
  ],
  db: {
    history: table({
      id: pk(),
      cpu: real(),
      mem: real(),
      ts: integer(),
    }),
  },
  stateForUI: (state, user?) => {
    if (user?.role === "admin") return state;
    // Viewers get current values but not the history array
    return {
      metrics: {
        cpu: state.metrics.cpu,
        mem: state.metrics.mem,
        requests: state.metrics.requests,
        history: [],
      },
    };
  },
});
```

`stateForUI` runs per client on every broadcast. Viewers get live numbers but no
history -- the sparkline will be empty for them. Connect as admin at
`http://localhost:8000?token=admin-token-123` or viewer at
`?token=viewer-token-456`.

> **Warning:** In production, load tokens from environment variables:
> `Deno.env.get('ADMIN_TOKEN')!`.

## Step 6: React UI

```tsx
// src/App.tsx
import { useFeature } from "aio/react";
import { metrics } from "./features/metrics/index.ts";
import type { Snapshot } from "./features/metrics/index.ts";

export default function App() {
  const { state, send } = useFeature(metrics);
  if (!state) return <div>Connecting...</div>;

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 800 }}>
      <h1>Metrics Dashboard</h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "1rem",
        }}
      >
        <Card label="CPU" value={`${state.cpu.toFixed(1)}%`} />
        <Card label="Memory" value={`${state.mem} MB`} />
        <Card label="Requests" value={String(state.requests)} />
      </div>

      {state.history.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2>CPU History</h2>
          <Sparkline data={state.history} field="cpu" max={100} />
          <h2>Memory History</h2>
          <Sparkline
            data={state.history}
            field="mem"
            max={Math.max(...state.history.map((h) => h.mem), 1)}
          />
        </div>
      )}

      <button
        style={{ marginTop: "2rem", padding: "0.5rem 1rem" }}
        onClick={() =>
          send.recordRequest()}
      >
        Simulate Request
      </button>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "1rem",
        background: "#1e1e2e",
        color: "#cdd6f4",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: "2rem", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Sparkline(
  { data, field, max }: { data: Snapshot[]; field: "cpu" | "mem"; max: number },
) {
  const recent = data.slice(-50);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 60,
        background: "#181825",
        borderRadius: 4,
        padding: 4,
      }}
    >
      {recent.map((snap, i) => {
        const pct = max > 0 ? (snap[field] / max) * 100 : 0;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${pct}%`,
              background: pct > 80 ? "#f38ba8" : "#a6e3a1",
              borderRadius: 1,
              minWidth: 2,
            }}
          />
        );
      })}
    </div>
  );
}
```

`useFeature(metrics)` gives you typed state and a typed `send` proxy. The
sparkline is just flex divs proportional to the value -- red above 80%, green
below. Open two browser tabs: both update simultaneously. Click "Simulate
Request" in one and watch the counter increment in both.

## Step 7: Testing

Test the sync method in isolation. No server, no browser, no mocking.

```ts
// src/features/metrics/metrics.test.ts
import { testFeature } from "aio";
import { metrics } from "./index.ts";

testFeature(metrics, "update records snapshot", (t) => {
  t.init();
  t.send.update(45.2, 512);
  t.expect.state((s) => s.cpu === 45.2);
  t.expect.state((s) => s.mem === 512);
  t.expect.state((s) => s.history.length === 1);
  t.expect.state((s) => s.history[0].cpu === 45.2);
});

testFeature(metrics, "history caps at 100", (t) => {
  t.init();
  for (let i = 0; i < 110; i++) {
    t.send.update(i, i);
  }
  t.expect.state((s) => s.history.length === 100);
  t.expect.state((s) => s.history[0].cpu === 10);
});

testFeature(metrics, "recordRequest increments", async (t) => {
  t.init();
  t.send.recordRequest();
  await t.settle();
  t.expect.state((s) => s.requests === 1);
});
```

Run with `deno task test`. `testFeature` wraps `Deno.test` with a harness that
resets state between runs. `t.send` dispatches through the real reducer -- no
mocking needed.

## Step 8: Build and deploy

Compile to a standalone binary:

```sh
deno run -A jsr:@riagentic/aio@1.0.0-alpha5/src/build --compile --service
```

This produces two files: a binary and a systemd unit file. The binary is
self-contained -- React, the bundled UI, SQLite, everything.

Install it:

```sh
sudo cp dash /usr/local/bin/
sudo cp dash.service /etc/systemd/system/
sudo systemctl enable --now dash
```

Check logs for the auth tokens:

```sh
journalctl -u dash -f
```

> **Tip:** For an exposed server (LAN access), compile with
> `--compile --service --remote`. The systemd unit will include `--expose` and
> auto-generate TLS.

That is the entire app: one feature, one schedule, one SQLite table, two users,
and a React UI -- all wired together by `aio.run()`.
