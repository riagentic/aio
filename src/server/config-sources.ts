// config-sources.ts — ONE decider per setting that has more than one home.
//
// A setting that can come from a flag, `aio.run({ … })`, an env var or
// deno.json is a question with several answers, and the bug this module
// exists for came back four times (feedback/frustration.md F6): the declared
// window size lost to `--width` in one place and not another, `expose`, the
// bind address, the database file. Each time, two sites answered the same
// question with their own `??` chain, and one of them drifted.
//
// So the precedence of every such key is written HERE, once, as data — an
// ordered candidate list — and the value and its source come out of that one
// list together, so the boot report's "(from …)" cannot disagree with the
// value it labels. tests/one-decider.test.ts refuses a raw `cli.x ?? …` merge
// anywhere else in the server.

import type { Provenance, Sourced } from "./boot-facts.ts";

/** One rung: where a value could come from, and what it said there. */
export type Candidate<T> = readonly [Provenance, T | null | undefined];

/** The first rung that said something — `??` semantics: `null` and
 *  `undefined` are "not said", while `0`, `""` and `false` are answers. */
export function pick<T>(
  ...candidates: readonly Candidate<T>[]
): Sourced<T> | undefined {
  for (const [from, value] of candidates) {
    if (value !== undefined && value !== null) return { value, from };
  }
  return undefined;
}

/** {@link pick}, with the framework's own answer when nobody said anything. */
export function pickOr<T>(
  fallback: T,
  ...candidates: readonly Candidate<T>[]
): Sourced<T> {
  return pick(...candidates) ?? { value: fallback, from: "default" };
}

type Flags = {
  host?: string;
  expose?: boolean;
  serverUrl?: string;
  persist?: boolean;
  dbPath?: string;
  keepServer?: boolean;
  width?: number;
  height?: number;
  cert?: string;
  key?: string;
  noTls?: boolean;
};

/** `--host` > `aio.run({ host })`; unset means "the expose default". */
export const hostOf = (
  cli: Pick<Flags, "host">,
  config: { host?: string },
): Sourced<string> | undefined =>
  pick(["flag", cli.host], ["config", config.host]);

/** `--expose` > `aio.run({ expose })` > off. (A non-loopback `host` is
 *  exposure too — `_exposeOf` in aio.ts combines the two.) */
export const exposeFlagOf = (
  cli: Pick<Flags, "expose">,
  config: { expose?: boolean },
): Sourced<boolean> =>
  pickOr(false, ["flag", cli.expose], ["config", config.expose]);

/** `--server-url` / `--connect` > `aio.run({ serverUrl })`. */
export const serverUrlOf = (
  cli: Pick<Flags, "serverUrl">,
  config: { serverUrl?: string },
): Sourced<string> | undefined =>
  pick(["flag", cli.serverUrl], ["config", config.serverUrl]);

/** `--no-persist` > `aio.run({ persist })` > on. */
export const persistOf = (
  cli: Pick<Flags, "persist">,
  config: { persist?: boolean },
): Sourced<boolean> =>
  pickOr(true, ["flag", cli.persist], ["config", config.persist]);

/** The SQLite file. The CONFIG wins over `--db-path` — the one key where it
 *  does, kept because flipping it would open a different database under a
 *  deployment that passes both (aio.ts warns when they differ). */
export const dbPathOf = (
  cli: Pick<Flags, "dbPath">,
  config: { dbPath?: string },
): Sourced<string> | undefined =>
  pick(["config", config.dbPath], ["flag", cli.dbPath]);

/** Electron: `--keep-server` > `aio.run({ keepServer })` > off. */
export const keepServerOf = (
  cli: Pick<Flags, "keepServer">,
  configKeepServer: boolean | undefined,
): Sourced<boolean> =>
  pickOr(false, ["flag", cli.keepServer], ["config", configKeepServer]);

/** The window box: `--width`/`--height` > `ui.width`/`ui.height`. Unset
 *  means the shell's own size (and the saved window state, which is the
 *  shell's to apply — docs/clients/electron.md). */
export const windowSizeOf = (
  cli: Pick<Flags, "width" | "height">,
  ui: { width?: number; height?: number },
): { width?: Sourced<number>; height?: Sourced<number> } => ({
  width: pick(["flag", cli.width], ["config", ui.width]),
  height: pick(["flag", cli.height], ["config", ui.height]),
});

/** TLS material: each flag > its `tls: { … }` twin. */
export const tlsOf = (
  cli: Pick<Flags, "cert" | "key" | "noTls">,
  tls: { cert?: string; key?: string; noTls?: boolean },
): {
  cert?: Sourced<string>;
  key?: Sourced<string>;
  noTls?: Sourced<boolean>;
} => ({
  cert: pick(["flag", cli.cert], ["config", tls.cert]),
  key: pick(["flag", cli.key], ["config", tls.key]),
  noTls: pick(["flag", cli.noTls], ["config", tls.noTls]),
});

/** `[name, "value (from)"]` for the `--verbose` boot report; unset keys
 *  are left out rather than printed as `undefined`. */
export function sourceLines(
  entries: readonly (readonly [string, Sourced<unknown> | undefined])[],
): [string, string][] {
  return entries.flatMap(([name, s]) =>
    s === undefined ? [] : [[name, `${fmt(s.value)} (${s.from})`]]
  );
}

function fmt(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}
