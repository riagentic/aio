// PROPERTY: the code that REPORTS a failure never throws in its place.
//
// Every reporter once reached `String(x)` or `JSON.stringify(x)` unguarded,
// and each hostile value below made one of them throw: the crash handler
// logged its own TypeError instead of the crash, a `log.*` call threw at its
// call site, a method's thrown value reached its caller as the framework's
// error. Fixed one reporter at a time; this crosses every hostile value with
// every reporter so a new reporter (or a new shape) cannot reopen the class.
import { assert, assertEquals } from "@std/assert";
import { describeThrown } from "../src/diagnostics/fmt.ts";
import { createAioError } from "../src/diagnostics/error.ts";
import { _safeValue, formatText } from "../src/diagnostics/logger-format.ts";

function hostiles(): [string, unknown][] {
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.reason = "declined";
  const nullProtoBig = Object.create(null) as Record<string, unknown>;
  nullProtoBig.n = 10n;
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  const nullProtoCyclic = Object.create(null) as Record<string, unknown>;
  nullProtoCyclic.self = nullProtoCyclic;
  const badMessage = new Error("x");
  Object.defineProperty(badMessage, "message", {
    get() {
      throw new Error("message getter exploded");
    },
  });
  const trap = new Proxy({}, {
    get() {
      throw new Error("proxy get trap");
    },
    ownKeys() {
      throw new Error("proxy ownKeys trap");
    },
  });
  return [
    ["null-prototype object", nullProto],
    ["null-prototype with a BigInt", nullProtoBig],
    ["null-prototype cycle", nullProtoCyclic],
    ["plain cycle", cyclic],
    ["toJSON answering undefined", { toJSON: () => undefined }],
    ["throwing toString", {
      toString() {
        throw new Error("toString exploded");
      },
    }],
    ["throwing toJSON", {
      toJSON() {
        throw new Error("toJSON exploded");
      },
    }],
    ["Error whose message getter throws", badMessage],
    ["throwing Proxy", trap],
    ["Symbol", Symbol("s")],
    ["BigInt", 12n],
    ["undefined", undefined],
    ["null", null],
    ["function", function named() {}],
  ];
}

const reporters: [string, (v: unknown) => unknown][] = [
  ["describeThrown", (v) => describeThrown(v)],
  ["createAioError", (v) => createAioError("REDUCE_ERROR", v, {}).message],
  ["logger _safeValue", (v) => _safeValue(v)],
  ["logger formatText (data)", (v) =>
    formatText({
      ts: new Date(0).toISOString(),
      lvl: "error",
      cat: "test",
      msg: "m",
      data: { v },
    })],
];

Deno.test("reporters never throw on a hostile value (property)", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const [vName, value] of hostiles()) {
    for (const [rName, report] of reporters) {
      checked++;
      try {
        const out = report(value);
        if (typeof out !== "string") {
          failures.push(`${rName}(${vName}) answered ${typeof out}`);
        }
      } catch (e) {
        failures.push(`${rName}(${vName}) threw: ${describeThrown(e)}`);
      }
    }
  }
  assertEquals(checked, hostiles().length * reporters.length);
  assertEquals(failures, [], failures.join("\n"));
});

Deno.test("describeThrown keeps the app's words where they are readable", () => {
  const np = Object.create(null) as Record<string, unknown>;
  np.reason = "declined";
  assert(describeThrown(np).includes("declined"));
  assertEquals(describeThrown(new Error("boom")), "boom");
  assertEquals(describeThrown("plain"), "plain");
});
