// The THIRD question about a config value, after "is this a real key"
// (VALID_*_KEYS) and "is this one of the words" (ENUM_VALUES / NUMERIC_VALUES):
// is this the right SHAPE?
//
// It had no answer at all, and the silence ran the wrong way in every case a
// config fuzz found:
//
//   • `expose: "false"` — the most natural spelling of "I turned it off",
//     and the one a deno.json can hold without a compiler ever seeing it —
//     booted the app ON THE NETWORK. A non-empty string is truthy, and every
//     reader of `expose` asks it for truthiness. The author read "false" and
//     the machine read "yes, serve this to the LAN".
//   • `allowedOrigins: "https://app.example.com"` (one origin, not a list)
//     was spread and iterated as a STRING: `frameAncestors` walked it
//     character by character, and the Origin gate became a substring test.
//   • `wsLimits: 5` and `ui: 42` were dropped WHOLE — the nested validator
//     skips anything that is not a plain object, so every option inside them
//     vanished with no line of any kind. The WS DoS guard stack and the
//     window/theme block are exactly the two blocks whose absence is
//     invisible until it matters.
//   • `cells: {}` booted an app with no cells.
//
// So the shape is a table beside the other two, and this file is the property
// that keeps it complete: every PUBLIC config key whose declared type in
// `aio-types.ts` is a plain `boolean` or a plain array must have an entry.
// A new `?: boolean` option added to the type without one is a red test here
// rather than a silent truthiness read in an app.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  NESTED_CONFIGS,
  refuseWrongShapes,
  SHAPE_VALUES,
  shapeRefusal,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SRC = new URL("../src/server/aio-types.ts", import.meta.url);

/** `validateConfig` calls `exit` on refusal; make that observable without
 *  killing the test process. */
function refused(
  obj: Record<string, unknown>,
  keys: Set<string> = VALID_FEATURES_CONFIG_KEYS,
  label = "CellsConfig",
): boolean {
  let code: number | null = null;
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const) console[k] = () => {};
  try {
    validateConfig(
      obj,
      keys,
      label,
      ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    );
  } catch { /* the exit stub */ }
  Object.assign(console, orig);
  return code === 1;
}

/** Every public key declared `  <name>?: boolean;` anywhere in aio-types.ts.
 *  Internals (`_`-prefixed) are not an app author's to spell. */
function declaredBooleans(src: string): string[] {
  return [...src.matchAll(/\n {2}([a-zA-Z][a-zA-Z0-9_]*)\?: boolean;/g)]
    .map((m) => m[1]!);
}

/** Every public key declared `  <name>?: <T>[];` — a plain array type, no
 *  union (`watch?: false | string[]` is not one of these). */
function declaredArrays(src: string): string[] {
  return [
    ...src.matchAll(
      /\n {2}([a-zA-Z][a-zA-Z0-9_]*)\?: (?:readonly )?[\w.<>"'()/ -]+\[\];/g,
    ),
  ].map((m) => m[1]!);
}

/** Keys whose SHAPE already has exactly one owner, which is not this table.
 *  Listed rather than forgotten: a second gate on the same key pre-empts the
 *  better message (and, for `schedules`, turns a catchable throw into an
 *  `exit(1)`), and "two deciders" is the failure this repo keeps undoing. */
const DECIDED_ELSEWHERE: Record<string, string> = {
  // `validateSchedules` (src/state/schedule.ts) checks the container
  // AND every entry, and throws — tests/schedules-refused-at-config.test.ts.
  schedules: "validateSchedules",
};

const isPublicKey = (k: string) =>
  VALID_AIO_CONFIG_KEYS.has(k) || VALID_FEATURES_CONFIG_KEYS.has(k) ||
  VALID_UI_KEYS.has(k);

Deno.test("SHAPE_VALUES: every boolean-typed public option is in the table", async () => {
  const src = await Deno.readTextFile(SRC);
  const found = declaredBooleans(src)
    .filter(isPublicKey)
    .filter((k) => !(k in DECIDED_ELSEWHERE));
  // Not vacuous: a regex that stopped matching would pass this file while
  // every new option walked straight past the gate.
  assert(found.length >= 15, `read only ${found.length} boolean options`);
  const missing = found.filter((k) => SHAPE_VALUES[k] !== "boolean");
  assertEquals(
    missing.sort(),
    [],
    `these options are typed \`boolean\` and have no shape gate — a string, ` +
      `a number or an object passed to one is read for TRUTHINESS, so ` +
      `"false" and 0 do the opposite of what they read like`,
  );
});

Deno.test("SHAPE_VALUES: every array-typed public option is in the table", async () => {
  const src = await Deno.readTextFile(SRC);
  const found = declaredArrays(src).filter(isPublicKey);
  assert(found.length >= 7, `read only ${found.length} array options`);
  const missing = found
    .filter((k) => !(k in DECIDED_ELSEWHERE))
    .filter((k) => SHAPE_VALUES[k] !== "array");
  assertEquals(
    missing.sort(),
    [],
    `these options are typed as arrays and have no shape gate — a bare ` +
      `string handed to one is iterated character by character`,
  );
});

/** Nested blocks whose TYPE is a union with a non-object spelling —
 *  `auth: true`, `sessions: true`, `tls: "auto" | false`,
 *  `updates: "https://…"`. For these the nested walk's "enter only an object"
 *  is the correct reading, so they must NOT carry an "object" shape gate. */
const UNION_BLOCKS = new Set(["auth", "sessions", "tls", "updates"]);

Deno.test("SHAPE_VALUES: every object-only nested config must BE an object", () => {
  // The nested pass skips a non-object silently, so without this the whole
  // block is dropped and nothing says so.
  const nested = Object.keys(NESTED_CONFIGS);
  assert(nested.length >= 2, `NESTED_CONFIGS is empty — nothing was checked`);
  let checked = 0;
  for (const key of nested) {
    if (UNION_BLOCKS.has(key)) {
      assertEquals(
        SHAPE_VALUES[key],
        undefined,
        `${key} also accepts a non-object spelling — a shape gate would ` +
          `refuse a documented value`,
      );
      continue;
    }
    checked++;
    assertEquals(
      SHAPE_VALUES[key],
      "object",
      `${key} is recursed into as a config object but has no shape gate`,
    );
  }
  assert(checked >= 2, `only ${checked} object-only blocks were checked`);
});

Deno.test("DECIDED_ELSEWHERE is an exemption, not a hole", async () => {
  // Two halves, both required: the key is genuinely absent from this table
  // (otherwise it IS a second gate), and its real owner still refuses the
  // wrong shape — here, with the better message and as a catchable throw.
  for (const k of Object.keys(DECIDED_ELSEWHERE)) {
    assert(!(k in SHAPE_VALUES), `${k} is exempted AND in SHAPE_VALUES`);
  }
  const { validateSchedules } = await import("../src/state/schedule.ts");
  const err = assertThrows(
    () => validateSchedules({ id: "tick", every: 1000 } as never),
    Error,
  );
  assert(
    (err as Error).message.includes("not an array"),
    `the owner must still name the shape: ${(err as Error).message}`,
  );
});

Deno.test("shapeRefusal: pure, and names what is wrong", () => {
  assertEquals(shapeRefusal(true, "boolean"), null);
  assertEquals(shapeRefusal(false, "boolean"), null);
  assert(shapeRefusal("false", "boolean"));
  assert(shapeRefusal(0, "boolean"));
  assertEquals(shapeRefusal([], "array"), null);
  assertEquals(shapeRefusal(["a"], "array"), null);
  assert(shapeRefusal("a", "array"));
  assert(shapeRefusal({}, "array"));
  assertEquals(shapeRefusal({}, "object"), null);
  assert(shapeRefusal([], "object"));
  assert(shapeRefusal(5, "object"));
  assert(shapeRefusal("x", "object"));
});

Deno.test('expose: "false" is refused, not served to the network', () => {
  assert(refused({ expose: "false" }), '`expose: "false"` must not boot');
  assert(refused({ expose: "true" }));
  assert(refused({ expose: 1 }));
  assert(refused({ expose: 0 }));
  // …and the spellings the type actually allows still boot.
  assert(!refused({ expose: true }));
  assert(!refused({ expose: false }));
  assert(!refused({}));
});

Deno.test("a single origin written without the brackets is refused", () => {
  assert(refused({ allowedOrigins: "https://app.example.com" }));
  assert(!refused({ allowedOrigins: ["https://app.example.com"] }));
  assert(!refused({ allowedOrigins: [] }));
});

Deno.test("a config BLOCK that is not an object is refused, not dropped", () => {
  assert(refused({ wsLimits: 5 }), "wsLimits: 5 must not boot");
  assert(refused({ wsLimits: [] }), "wsLimits: [] must not boot");
  assert(refused({ ui: 42 }), "ui: 42 must not boot");
  assert(refused({ ui: [] }), "ui: [] must not boot");
  assert(refused({ cells: {} }), "cells: {} must not boot");
  assert(!refused({ wsLimits: { maxMessageBytes: 1024 } }));
  assert(!refused({ ui: { title: "x" } }));
  assert(!refused({ cells: [] }));
});

Deno.test("the refusal names the key, the value and the fix", () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    validateConfig(
      { expose: "false" },
      VALID_FEATURES_CONFIG_KEYS,
      "CellsConfig",
      (() => {
        throw new Error("exit");
      }) as (c: number) => never,
    );
  } catch { /* the exit stub */ }
  console.error = orig;
  const all = lines.join("\n");
  assert(all.includes("CellsConfig.expose"), `names the key: ${all}`);
  assert(all.includes('"false"'), `quotes the value: ${all}`);
  assert(
    all.includes("expose: true") || all.includes("expose: false"),
    `shows the fix: ${all}`,
  );
});

Deno.test("null and undefined stay 'not said' — the one decider's semantics", () => {
  // config-sources.ts's `pick` documents null/undefined as "nobody answered".
  // A shape gate that refused them would make a second decider out of a
  // spelling that boots today.
  assert(!refused({ expose: null }));
  assert(!refused({ expose: undefined }));
  assert(!refused({ allowedOrigins: null }));
});

Deno.test("a value JSON cannot print is still refused by name, not a TypeError", () => {
  // The gate's job is to refuse a value that is the wrong KIND of thing, so it
  // has to survive the kinds `JSON.stringify` cannot hold: it returns
  // `undefined` for a function or a symbol, and THROWS on a BigInt and on
  // anything circular. A throw here leaves `validateConfig` as a TypeError out
  // of the validator instead of the sentence naming the key and the fix — the
  // one gate that exists to explain a bad value, killed by that value.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const v of [10n, circular, () => {}, Symbol("s")]) {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) =>
      void lines.push(a.map(String).join(" "));
    let exited = 0;
    try {
      refuseWrongShapes(
        { expose: v },
        "CellsConfig",
        ((c: number) => {
          exited = c;
          throw new Error("exit");
        }) as (c: number) => never,
      );
    } catch {
      /* the exit stub */
    } finally {
      console.error = orig;
    }
    assertEquals(exited, 1, `expose: ${String(v)} must be refused`);
    assert(
      lines.join("\n").includes("CellsConfig.expose"),
      `the refusal still names the key for ${String(v)}: ${lines.join("\n")}`,
    );
  }
  // A circular value under an OBJECT key is a legal SHAPE and stays legal —
  // whether it prints is not the question this gate asks. (Checked against
  // `refuseWrongShapes` itself, not `validateConfig`: `ui` would also be
  // walked as a nested config, and `self` is not a ui key.)
  refuseWrongShapes(
    { perfBudget: circular },
    "CellsConfig",
    ((c: number) => {
      throw new Error(`a circular perfBudget must not be refused: exit ${c}`);
    }) as (c: number) => never,
  );
});

// A gate that runs after the first reader is not a gate. `aio.run()` merges
// plugins FIRST, deliberately, and that merge SPREADS `allowedOrigins` — so a
// bare string became its 23 CHARACTERS, reached `validateConfig` as a
// perfectly good array of one-character origins, and turned the Origin gate
// into the substring test this table exists to stop. Measured before the fix:
// exit 1 with no plugin, exit 0 and a clean boot with one.
//
// A real boot, because the ORDER of two calls inside `_runAsApp` is the whole
// claim and nothing short of running it can check that.
Deno.test({
  name: "the shape is settled before the plugin merge reads it",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const dir = await tempDir("aio-shape-plugins-");
    try {
      const boot = async (withPlugin: boolean) => {
        const file = join(dir, `app-${withPlugin}.ts`);
        const plugin = withPlugin
          ? `  plugins: [definePlugin({ name: "o", ` +
            `allowedOrigins: ["https://p.example"] })],\n`
          : "";
        await Deno.writeTextFile(
          file,
          `import { aio, cell } from "${root}/mod.ts";
import { definePlugin } from "${root}/src/server/plugin.ts";
const c = cell("shapeplug", { state: { n: 0 }, methods: {} });
const app = await aio.run({
  cells: [c],
  appId: "shapeplug",
  client: "server-only",
  port: 0,
${plugin}  allowedOrigins: "https://app.example.com" as unknown as string[],
});
console.log("BOOTED");
await app.close();
Deno.exit(0);
`,
        );
        const r = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--no-check",
            "--config",
            join(root, "deno.json"),
            file,
          ],
          env: { AIO_APPS_DIR: join(dir, `home-${withPlugin}`), NO_COLOR: "1" },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          code: r.code,
          out: new TextDecoder().decode(r.stdout) +
            new TextDecoder().decode(r.stderr),
        };
      };
      // The DIFFERENTIAL is the test: the same wrong value, with and without a
      // plugin, has to get the same verdict.
      for (const withPlugin of [false, true]) {
        const { code, out } = await boot(withPlugin);
        assertEquals(
          code,
          1,
          `a bare-string allowedOrigins must be refused ${
            withPlugin ? "WITH" : "without"
          } a plugin:\n${out.slice(-2000)}`,
        );
        assert(!out.includes("BOOTED"), out.slice(-2000));
        assert(
          out.includes("allowedOrigins") && out.includes("not a list"),
          `and refused for its SHAPE, by name:\n${out.slice(-2000)}`,
        );
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});
