# Upgrade from v1.0.0-alpha2 to v1.0.0-alpha3

### Breaking changes

**Log format changed from JSONL to plain text**

If you have tooling parsing JSON logs, update it. New format:

```
2026-03-23 14:22:35.123  INFO   feature:auth  ready  port=3000
```

**`rotate` config replaced by `backupLogs` + `backupKeep`**

```ts
// BEFORE (alpha2)
await aio.run({
  logging: { rotate: { keep: 7 } },
});

// AFTER (alpha3)
await aio.run({
  logging: { backupLogs: true, backupKeep: 7 },
});
```

Default behavior changed: logs are wiped on each app start (clean slate). Set
`backupLogs: true` to rotate instead.

**Logging enabled by default**

Logging is now on by default — no need for `logging: true`. Set `logging: false`
to disable.

### Non-breaking additions

- `AioError` class with structured error codes, correlation IDs, state snapshots
- Memory pressure monitor (`MemoryConfig`)
- Time-travel error markers
- Time-travel `MAX_ENTRIES` bumped to 20,000

### Upgrade steps

1. Remove `logging: true` from `aio.run()` — it's the default now
2. Replace `rotate: { keep: N }` → `backupLogs: true, backupKeep: N`
3. Update any log parsing scripts: format is now plain text, not JSONL
