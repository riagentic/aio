# Road to 1.0.0-final

Plan written 2026-07-04 (alpha14 finalized 2026-07-07). Predecessor todo.md (DX
overhaul, 9 phases) shipped in alpha13 and was removed with that release.

**Core principle:** all breaking changes die in alpha; beta = frozen surface,
bugfix-only; 1.0.0 = boring. Commit per task as `rd(<task-id>): <summary>`.

---

## Phase A — remaining alphas (last window for breakage)

- [x] **A1 — Public-surface audit.** Enumerate every export of the 14
      `deno.json` entry points (`.`, `air`, `air/compat`, `jsx-runtime`,
      `adapters/air`, `state-core`, `db`, `sync`, `testing`, `schedule`,
      `selectors`, `src/build`, `src/am`, `aiol`); classify each: keep / rename
      / delete / `@experimental`. Anything <90% sure → cut now, re-add post-1.0
      (additive = non-breaking). Output:
      `docs/specs/2026-07-04-public-surface-audit.md`.
- [x] **A2 — API-snapshot gate.** `deno doc --json` diff of the public surface,
      snapshot committed, CI-enforced: any surface change fails the build unless
      the snapshot is deliberately regenerated. Mechanical
      no-accidental-breaking guarantee, kept forever.
      (`scripts/api-snapshot.ts`, `docs/api-snapshot.json` — 13 entries / 346
      symbols; `deno task api:check|api:update`; also enforces the `_`-prefix ⇒
      `@internal` rule.)
- [x] **A3 — WS protocol version handshake.** cid/ack protocol gets a version
      field + negotiation so post-1.0 protocol evolution ≠ breaking old clients.
      (`src/protocol-version.ts`: `__proto:{v,min}` hello, server speaks first,
      on WS + UDS + CLI clients; effective = min(v,v), mismatch → loud error +
      close 4505, no reconnect storm; legacy clients without hello still work.
      Tests: `tests/protocol-version.test.ts`.)
- [x] **A4 — Persistence schema versioning.** Stamp KV snapshots with a schema
      version + migration hook; alpha-era stored state migrates or fails loudly.
      (`src/persist-schema.ts`: `<appId>:__schema` stamp written AFTER
      successful state writes; boot migrates v0 (alpha-era) → current via
      `SCHEMA_MIGRATIONS`, refuses newer-schema stores with `PERSIST_SCHEMA`.
      Also fixed: `__versions` cell stamps were read at boot but never written —
      cell migrations re-ran on every restart.)
- [x] **A5 — Deprecation decision.** `aio/air/compat` re-exports: commit to
      "permanent" or "removed at beta1". Nothing labeled "until post-1.0"
      survives into beta. (Decision 2026-07-06: **permanent** — migrations don't
      finish on our schedule; 5 tiny shims, zero maintenance surface, protected
      by the A2 snapshot. Recorded in the entry's module doc.)
- [ ] **A6 — Field reports for untested app types.** Covered: TUI/desktop
      (risoto), AIR/canvas (risharp). Missing: `android`, `remote-*`,
      multi-client sync under concurrency. Build one real app per gap.
  - [x] multi-client sync under concurrency — in-repo E2E:
        `tests/sync/integration/multi-client-ws.test.ts` (two WS clients,
        interleaved op storm → exact ack/relay counts, no echo, late-joiner
        catch-up via `__sync`). A field-report app would still add value but the
        concurrency mechanics are now pinned by test.
  - [x] `android` field report — DONE 2026-07-08 on a real emulator (Pixel 7 /
        API 35, KVM). Scaffolded app → `compile:android` → 3.2 MB APK →
        installed → counter increments on tap → localStorage survives
        force-stop + relaunch. Found + fixed AIO-404 (registry boot, iife
        format, reactive getters; bundle-path breakage from folderization).
  - [ ] `remote-*` field report — internal validation done 2026-07-08: exposed
        TLS+token server driven by remote-cli thin client over the network
        (found+fixed AIO-403 wss-downgrade/token-drop). Remaining: a real
        deployed (off-box) server + client session, report.

## Phase B — betas (freeze + prove)

- [ ] **B1 — beta1 = feature freeze.** API snapshot locked ✓ (A2); semver +
      deprecation policy doc published ✓ (`docs/basics/semver-policy.md`,
      2026-07-08). Remaining: the beta1 release itself (freeze decision).
- [x] **B2 — Docs completeness gate.** Every public export documented (345/345)
      + CI gate `deno task docs:coverage` (`scripts/check-doc-coverage.ts`,
      2026-07-08). Examples type-check in CI via `deno task check` (extend
      `scripts/check-docs.ts`).
- [x] **B3 — Error-message audit.** Done 2026-07-08: 85 origin throw sites
      classified, 27 user-reachable ones now carry cause + fix (rename
      suggestions, known-cell lists, cron syntax examples, lifecycle hints).
- [ ] **B4 — Perf + soak.** Benchmarks ✓ (`deno task bench`, CI regression
      floors: signal graph, batched writes, composed reduce, KV persist) and
      soak harness ✓ (`deno task soak` / `soak:72h`, heap-slope leak gate,
      30-min run clean, 2026-07-08). Remaining: the actual 72h run.
- [x] **B5 — Security pass.** Done 2026-07-08 (commit 73f7678): full audit — WS
      auth/wsLimits/origin checks solid; fixed snapshot admin gate,
      allowedOrigins plumbing (+own-host in expose), trojan auth in user mode,
      symlink guard; secrets invariant (persist+ui exclude BOTH) documented in
      docs/auth/auth.md; scope:"client" boundary verified solid.
- [ ] **B6 — beta2+ = fixes only** + 2 more field-report apps on the frozen API.

## Phase C — 1.0.0 exit criteria (defined now, not negotiated later)

- [ ] **C1** — API snapshot unchanged across ≥2 consecutive betas.
- [ ] **C2** — Latest 2 field reports contain zero P1/P2 (only "worked well").
- [ ] **C3** — All templates × app types scaffold + build + run in CI.
- [ ] **C4** — `docs/upgrade/from-beta-to-1.0.0.md` + stability statement
      (what's guaranteed, what's `@experimental`).

## Post-1.0 insurance (policy, not tasks)

- Additive-only evolution: new features behind new exports/options, never
  changed semantics.
- `@experimental` tag = the only escape hatch for unstable surface.
- Keep the field-report ritual; pin the risoto/risharp keep-lists as tests where
  possible.
