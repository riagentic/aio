# Local-first execution (perfect-aio D3) — design

Status: **design + prototype phase** (the D3 gate: no mass migration before this
doc and a working prototype). Date: 2026-07-22.

## The decision being implemented

Methods run **locally** wherever the caller is; changes propagate as sync ops;
the **server stays the authority** — it validates every op and is the arbiter of
truth. Server-only work becomes an explicit, typed surface (`serverFns`).

## The core design choice: how does the server judge?

Two candidate mechanisms were on the table:

1. **Pure patch validation** — client sends patches; server checks them against
   declarative rules. Weakest-primitive problem: expressing "balance never
   negative, only owner edits" as patch validators is hard and error-prone.
2. **Server re-execution** ✅ **chosen** — the client's method run is an
   optimistic _preview_; the server re-runs the SAME method against ITS state
   and commits that result. "The server ran the code" remains the security
   primitive — unchanged from today's model — while the UX becomes local-first.

Why re-execution wins: it is exactly what the CRDT sync layer already does
(`sync: true` cells replay ops through the cell's own reducer server-side —
`server-handler.ts` dispatches every accepted op through normal dispatch). We
have been field-testing the chosen mechanism since the sync layer shipped. The
authorization model needs NO redesign: guard lines
(`if (user.role !== "admin") return`) and `validate:` hooks run on the server's
execution, same as today.

## What exists today vs what's missing

| piece                                      | status                                 |
| ------------------------------------------ | -------------------------------------- |
| local method execution + op stamping (HLC) | ✅ shipped (`sync: true` cells)        |
| server re-execution as authority           | ✅ shipped (op → dispatch)             |
| offline queue + replay + convergence       | ✅ shipped + field-tested              |
| race-free catch-up cursor                  | ✅ shipped (alpha26)                   |
| **explainable rejection (D11)**            | ❌ built in this phase                 |
| **explicit server functions**              | ❌ built in this phase                 |
| local-first as an app-level switch         | ❌ built in this phase (opt-in)        |
| local-first as THE default                 | ⏳ after field validation of the above |

## D11 — rejected ops are always explainable (hard requirement)

Today a server-side rejection (validate hook, guard line) silently leaves the
client's optimistic view to be corrected by the next broadcast — the user never
learns _why_. New contract:

- When the server's re-execution of an op is REJECTED (validate returned an
  error, or state is unchanged because a guard refused it), the server sends
  `__op_rejected { opId, cell, reason }` to the op's origin.
- The client: drops the op from its buffer, rebases (optimistic view snaps
  back), logs `[aio:sync] op rejected: <reason>` loudly, and surfaces the
  rejection to the app via the cell's `sync.onRejected(info)` callback so UIs
  can show real feedback.
- Silent rejection is a bug of the blank-screen class.

## serverFns — the explicit seam

```ts
// server.ts — only ever imported by the server entry
export const api = serverFns("api", {
  chargeCard: async (amount: number) => await stripe.charge(amount),
});

// cell method — same file as always; the hop is visible in the code
async checkout(s) {
  s.status = "paying";                     // instant, local
  const r = await api.chargeCard(s.total); // explicit server round-trip
  s.status = r.ok ? "paid": "failed";
}
```

- Server side: `serverFns(namespace, fns)` registers named async functions.
- Client side: the same import resolves to a typed proxy that calls over the
  existing WS transport (cid-correlated request/response, like method acks).
- Errors propagate as rejected promises with the server's message; timeouts fail
  loudly.
- The graph validator treats `serverFns` modules like `.server.ts` — the one
  visible seam.

## Rollout

1. **This phase (alpha28):** D11 rejection path + `serverFns` + prototype
   example (`examples/targets/localfirst`) + docs. `sync: true` remains the
   opt-in switch per cell.
2. **Next:** `aio.run({ localFirst: true })` — every server cell defaults to
   sync (per-cell opt-out), measured against the benchmark suite (D12).
3. **The flip** (localFirst default ON) only after a field report on a real
   local-first app comes back clean — the same bar every foundational change in
   this repo has met.
