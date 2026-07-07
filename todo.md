# Road to 1.0.0-final

Plan written 2026-07-04 (alpha14 in progress). Predecessor todo.md (DX overhaul,
9 phases) shipped in alpha13 and was removed with that release.

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
- [ ] **A2 — API-snapshot gate.** `deno doc --json` diff of the public surface,
      snapshot committed, CI-enforced: any surface change fails the build unless
      the snapshot is deliberately regenerated. Mechanical
      no-accidental-breaking guarantee, kept forever.
- [ ] **A3 — WS protocol version handshake.** cid/ack protocol gets a version
      field + negotiation so post-1.0 protocol evolution ≠ breaking old clients.
- [ ] **A4 — Persistence schema versioning.** Stamp KV snapshots with a schema
      version + migration hook; alpha-era stored state migrates or fails loudly.
- [ ] **A5 — Deprecation decision.** `aio/air/compat` re-exports: commit to
      "permanent" or "removed at beta1". Nothing labeled "until post-1.0"
      survives into beta.
- [ ] **A6 — Field reports for untested app types.** Covered: TUI/desktop
      (risoto), AIR/canvas (risharp). Missing: `android`, `remote-*`,
      multi-client sync under concurrency. Build one real app per gap.

## Phase B — betas (freeze + prove)

- [ ] **B1 — beta1 = feature freeze.** API snapshot locked; semver + deprecation
      policy doc published (what counts as breaking, how long deprecations
      live).
- [ ] **B2 — Docs completeness gate.** Every public export documented; all
      `examples/` + doc snippets type-checked in CI (extend
      `scripts/check-docs.ts`).
- [ ] **B3 — Error-message audit.** Every throw: code + cause + fix suggestion
      (extend existing error-code gate).
- [ ] **B4 — Perf + soak.** Benchmarks (signal graph, WS fan-out, persist write
      path) with CI regression thresholds; 72h soak of a scheduled service
      (scheduler/subscription leaks).
- [ ] **B5 — Security pass.** WS auth, secret-state exclusion from persist/ui
      (risoto's pattern → documented invariant), `scope:"client"` boundary.
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
