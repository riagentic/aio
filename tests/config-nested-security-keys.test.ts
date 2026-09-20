// A misspelled key inside a SECURITY block was accepted in silence, and the
// control the author asked for was simply absent.
//
//   • `sessions: { ttlMS: 300_000 }` — wrong case, five minutes asked for —
//     kept the built-in THIRTY DAYS. The app boots, logins work, and every
//     token outlives its intended life by four orders of magnitude.
//   • `auth: { requireVerifed: true }` — one letter — left email verification
//     OFF. The signup gate the author wrote is not in force, and nothing says
//     so at boot or ever after.
//   • `tls: { certt: "…", key: "…" }` lost the certificate: the pair is no
//     longer a pair, so the app falls back to a self-signed cert (or plain
//     http) while the operator believes their real one is serving.
//   • `updates: { allowUnsignd: true }`, `{ keyz: … }` — the manifest-trust
//     options, dropped.
//
// `aio.run()` has refused an unknown key at the TOP level since alpha52 and
// `ui`/`wsLimits` are recursed into, but these four blocks had no gate of any
// kind. They do now, from the same `validateConfig` — one spelling of "this
// key does not exist", with the did-you-mean the rest of the surface gets.
//
// The property that keeps them honest: each allowlist is compared against the
// TYPE's own field list, read out of the source (types are erased at runtime),
// so a key added to `AuthOptions` or `UpdatesConfig` without being added here
// is a red test rather than a documented option refused at boot.
import { assert, assertEquals } from "@std/assert";
import {
  NESTED_CONFIGS,
  VALID_AUTH_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_SESSIONS_KEYS,
  VALID_TLS_KEYS,
  VALID_UPDATES_KEYS,
  validateConfig,
} from "../src/server/config.ts";

/** What `validateConfig` said, and whether it refused. */
function verdict(obj: Record<string, unknown>): {
  refused: boolean;
  said: string;
} {
  let code: number | null = null;
  const lines: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  try {
    validateConfig(
      obj,
      VALID_FEATURES_CONFIG_KEYS,
      "CellsConfig",
      ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    );
  } catch { /* the exit stub */ }
  Object.assign(console, orig);
  return { refused: code === 1, said: lines.join("\n") };
}

/** The field names of a `type X = { … }` / `interface X { … }` block, read
 *  from source — the runtime has none. Nested braces are skipped, so an
 *  inline object type does not contribute its members. */
function typeFields(src: string, decl: string): string[] {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found — did it move or rename?`);
  let depth = 0;
  const out: string[] = [];
  const body = src.slice(src.indexOf("{", at));
  for (const line of body.split("\n")) {
    const m = depth === 1
      ? line.match(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)\??:/)
      : null;
    if (m) out.push(m[1]!);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && out.length > 0) break;
  }
  return out;
}

const TYPES = new URL("../src/server/aio-types.ts", import.meta.url);
const UPDATES = new URL("../src/server/updates-core.ts", import.meta.url);

Deno.test("VALID_AUTH_KEYS names every AuthOptions field", async () => {
  const src = await Deno.readTextFile(TYPES);
  // `AuthOptions` is a base type intersected with the requireVerified pair,
  // so both halves are read.
  const base = typeFields(src, "type AuthOptionsBase = {");
  assert(base.length >= 5, `read only ${base.length} AuthOptionsBase fields`);
  const all = [...base, "requireVerified", "sendMail"].sort();
  assertEquals([...VALID_AUTH_KEYS].sort(), all);
});

Deno.test("VALID_UPDATES_KEYS names every UpdatesConfig field", async () => {
  const src = await Deno.readTextFile(UPDATES);
  const fields = typeFields(src, "export type UpdatesConfig = {");
  assert(fields.length >= 8, `read only ${fields.length} UpdatesConfig fields`);
  assertEquals([...VALID_UPDATES_KEYS].sort(), fields.sort());
});

Deno.test("a misspelled key in a security block is refused, with the near miss", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["sessions", { sessions: { ttlMS: 300_000 } }, "ttlMs"],
    ["auth", { auth: { requireVerifed: true } }, "requireVerified"],
    ["tls", { tls: { certt: "a", key: "b" } }, "cert"],
    ["updates", {
      updates: { source: "https://x/y", allowUnsignd: true },
    }, "allowUnsigned"],
  ];
  for (const [block, cfg, near] of cases) {
    const v = verdict(cfg);
    assert(v.refused, `${block}: a misspelled key must not boot — ${v.said}`);
    assert(
      v.said.includes(near),
      `${block}: the refusal must name the near miss ${near} — ${v.said}`,
    );
  }
});

Deno.test("the spellings these blocks DO accept still boot", () => {
  assert(!verdict({ sessions: { ttlMs: 300_000 } }).refused);
  assert(!verdict({ sessions: true }).refused);
  assert(
    !verdict({ auth: { signup: false, cookie: true, totp: true } }).refused,
  );
  assert(!verdict({ auth: true }).refused);
  assert(!verdict({ tls: { cert: "a", key: "b" } }).refused);
  assert(!verdict({ tls: "auto" }).refused);
  assert(!verdict({ tls: false }).refused);
  assert(
    !verdict({ updates: { source: "https://x/y", allowUnsigned: true } })
      .refused,
  );
  assert(!verdict({ updates: "https://x/y" }).refused);
});

Deno.test("every security block is reached by the ONE nested validator", () => {
  // Not a second copy of the walk: these are entries in the same map `ui` and
  // `wsLimits` use, so one fix covers all of them.
  for (const block of ["auth", "sessions", "tls", "updates"]) {
    assert(block in NESTED_CONFIGS, `${block} is not a nested config`);
  }
  assertEquals(NESTED_CONFIGS.tls!(), VALID_TLS_KEYS);
  assertEquals(NESTED_CONFIGS.sessions!(), VALID_SESSIONS_KEYS);
});
