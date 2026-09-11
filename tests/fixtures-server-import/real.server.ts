// A stand-in for the module a cell would reach for — the one that owns an OS
// process in the report. Used by tests/server-import-stub.test.ts: unstubbed,
// `serverImport` must reach THIS file.
export const run = (): string => "REAL";
