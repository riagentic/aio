# Problem reports

```ts
aio.run({ cells: [wallet], feedback: true });
```

That is the whole configuration. Your app can now capture a report — what is
running, what state it was in, what had just happened, and the recent log — and
it captures one automatically when the app breaks.

```tsx
import { feedback } from "aio/feedback";

export function ReportButton(props: { title: string; details: string }) {
  return (
    <>
      <button
        type="button"
        onClick={() => feedback.report(props.title, props.details)}
      >
        Report a problem
      </button>
      {feedback.last && <p>Thanks — saved to {feedback.last.path}</p>}
    </>
  );
}
```

It is a cell, so this is an ordinary reactive read. Nothing new to learn.

## What a report contains

The point is to answer the questions a maintainer asks anyway, so nobody has to
go back and forth collecting them:

| Section       | What it answers                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- |
| `app`         | which build — version, aio version, target, channel, commit, platform, the artifact path |
| `environment` | how it was configured — data dir, exposed, persistence, cells                            |
| `state`       | what it was doing (redacted — see below)                                                 |
| `timeline`    | what had just happened, newest last                                                      |
| `diagnostics` | recent warnings and errors off the diagnostic bus                                        |
| `logs`        | the tail of `app.log`                                                                    |
| `truncated`   | anything dropped to keep the report attachable, and why                                  |

Plain JSON, so a maintainer, a script, an issue tracker and a coding agent all
read it the same way with no aio installed.

## Redaction is not optional

A report carries state, and your app already declared which state must be
retained nowhere:

```ts
aio.run({ redactActions: ["wallet:unlockWith", "vault:*"] });
```

Reports honour that **same list** — the one the journal, the timeline and the
checkpoint honour. A cell with any redacted action has its slice withheld whole,
and the report names it in `redactedCells`, so the absence reads as a decision
rather than as "this app has no such data".

This is the rule, not a setting: a report that ignored the redaction list would
be the leak the list exists to prevent.

## Everything is capped

A report nobody can attach to an issue helps nobody:

- timeline: newest 100 entries
- diagnostics: newest 50
- logs: last 200 lines
- state: **dropped** above 256 KB rather than truncated — half a state tree
  misleads in a way none does not

Whatever was dropped is listed in `truncated`, with the reason.

## Automatic capture

The reports worth having are the ones nobody was there to file. With
`feedback: true`, aio writes one when the app hits an error, using the same
format and the same redaction as a user-filed report.

Two bounds keep that from becoming its own problem: reports are deduplicated by
message, so one repeating fault produces one report; and a session writes at
most 10 automatically, saying so once when it stops. Set `auto: false` to
capture only what users file.

## Where they go, and how to read them

`<data>/reports/*.json` — inside the app's data directory, so they travel with a
backup and are deleted with the app. The newest 50 are kept (`keep`).

```sh
am report list            # what is there
am report show <id>       # the full bundle — attach this to an issue
am report path            # the directory
```

An id prefix is enough for `show`; nobody should have to paste a timestamp in
full.

## Sending them somewhere

There is no default destination, and that is deliberate — aio does not run a
service to receive your users' data. The seam is there when you want one:

```ts
feedback: { url: "https://reports.example.com/intake" }   // POST as JSON
feedback: { sink: async (report) => { … } }               // anything else
```

Delivery is attempted **after** the report is safely on disk, and never instead
of it. An app has no idea whether a destination is reachable, and losing a
report because a server was down is the one outcome worth engineering against —
`feedback.last.delivered` says which happened.

If you do send reports off the machine, tell your users: a report contains
application state, and that is their data.

## Configuration reference

| Option | Default | Meaning                                   |
| ------ | ------- | ----------------------------------------- |
| `auto` | `true`  | Capture automatically when the app breaks |
| `url`  | —       | POST each report as JSON                  |
| `sink` | —       | Hand each report anywhere else            |
| `keep` | `50`    | Reports kept on disk                      |

## Cell state reference

| Field     | Meaning                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | `feedback` was configured — set by the boot-time `refresh()` once cells are bound; `false` in an app that never configured it |
| `status`  | idle · capturing · saved · error                                                                                              |
| `last`    | `{ id, path, createdAt, delivered }` or null                                                                                  |
| `pending` | reports on disk, including automatic ones                                                                                     |
| `error`   | last failure, verbatim                                                                                                        |

Methods: `report(title, body?, contact?)` · `refresh()` · `dismiss()`.
