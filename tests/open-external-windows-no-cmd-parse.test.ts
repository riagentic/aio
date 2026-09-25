// On Windows the target went through `cmd /c start "" <target>`, and cmd
// re-parses its command line: `https://h/?a=1&b=2` opened `…?a=1` and ran
// `b=2` as a command, `%VAR%` expanded (measured on Windows 11, Deno 2.9).
// The target must reach the launcher through something nothing parses.
import { assert, assertEquals } from "@std/assert";
import { _openSpec } from "../src/server/open-external.ts";

Deno.test("openExternal: on Windows the target is never on a cmd.exe command line", () => {
  const target = "https://h/?a=1&b=2%PATH%^x";
  const spec = _openSpec("windows", target);
  assert(!/^cmd(\.exe)?$/i.test(spec.cmd), `launcher is ${spec.cmd}`);
  assert(
    spec.args.every((a) => !a.includes(target)),
    "the target must not be parsed as part of a command line",
  );
  assertEquals(spec.env?.AIO_OPEN_TARGET, target);
  assertEquals(spec.cmd, "powershell");
});

Deno.test("openExternal: darwin and linux pass the target as one argv entry", () => {
  assertEquals(_openSpec("darwin", "a&b"), { cmd: "open", args: ["a&b"] });
  assertEquals(_openSpec("linux", "a&b"), { cmd: "xdg-open", args: ["a&b"] });
});
