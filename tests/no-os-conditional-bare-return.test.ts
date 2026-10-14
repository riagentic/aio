// A test that `return`s on an OS passes there without running — and is
// counted as a pass. About 50 did: `if (Deno.build.os === "windows") return;`
// as the first statement, so the Windows run reported them green while none
// of their asserts ran. A case whose subject does not exist on an OS says so
// where the runner can count it: `ignore: <condition>, // <reason>`. A case
// whose subject does exist is ported.
//
// So, in a test body: an `if` whose condition names the OS (`Deno.build.os`,
// or a constant of this file made from it) and whose whole effect is a bare
// `return` is refused. `// aio-ok: <reason>` on the statement (or the line
// above) admits one that is not a skip of the test — a helper closure, a
// loop over OSes.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Every OS-conditional bare `return` inside a test body of `src`, as
 *  `{ line (1-based), text }`. Relies on `deno fmt` layout: a call's closing
 *  line sits at the indent of its opening line. Pure. */
export function osBareReturns(src: string): { line: number; text: string }[] {
  const lines = src.split("\n");
  const indent = (l: string) => l.length - l.trimStart().length;

  // Constants made from the OS: `const WIN = Deno.build.os === "windows";`
  // — and the ones made from those (`const POSIX = !WIN;`), to the end of the
  // chain. `Deno.build.target` and the Node spelling name the OS as well.
  const names = ["Deno\\.build\\.(?:os|target)", "process\\.platform"];
  const decls = [
    ...src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=([^;]*);/g),
  ];
  for (let grew = true; grew;) {
    grew = false;
    const known = new RegExp(names.join("|").replaceAll("$", "\\$"));
    for (const m of decls) {
      const name = `\\b${m[1]!}\\b`;
      if (names.includes(name) || !known.test(m[2]!)) continue;
      names.push(name);
      grew = true;
    }
  }
  const os = new RegExp(names.join("|").replaceAll("$", "\\$"));

  // Lines inside a `Deno.test(` / `t.step(` call.
  const inTest = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:await )?(?:Deno\.test|\w+\.step)\(/.test(lines[i]!)) continue;
    const at = indent(lines[i]!);
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      // …which closes the call: `}, async () => {` only ends its options.
      if (
        l.trim() !== "" && indent(l) === at && /^\s*[})]/.test(l) &&
        !/(?:\{|=>|\()$/.test(l.trimEnd())
      ) break;
      inTest[j] = true;
    }
  }

  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inTest[i] || !/^\s*if \(/.test(lines[i]!)) continue;
    const at = indent(lines[i]!);
    // The header: one line, or down to the `)` back at the `if`'s indent.
    let h = i;
    if (!/\)\s*(?:return;|\{)\s*(?:\/\/.*)?$/.test(lines[i]!)) {
      h = i + 1;
      while (
        h < lines.length &&
        !(indent(lines[h]!) === at && lines[h]!.trimStart().startsWith(")"))
      ) h++;
      if (h >= lines.length) continue;
    }
    const header = lines.slice(i, h + 1).join("\n");
    let end = h;
    if (/\{\s*(?:\/\/.*)?$/.test(lines[h]!)) {
      // A block: a skip when it ends in `return;` and asserts nothing.
      while (
        end < lines.length - 1 &&
        !(indent(lines[end + 1]!) === at &&
          lines[end + 1]!.trimStart().startsWith("}"))
      ) end++;
      const body = lines.slice(h + 1, end + 1)
        .map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("//"));
      end++;
      if (
        body.at(-1) !== "return;" || body.some((l) => /\bassert/.test(l)) ||
        /^\s*\}\s*else\b/.test(lines[end] ?? "")
      ) continue;
    } else if (!/\)\s*return;\s*(?:\/\/.*)?$/.test(lines[h]!)) continue;
    // The condition only — not what a block's body mentions.
    if (!os.test(header.replace(/\/\/.*$/gm, ""))) continue;
    const above = (lines[i - 1] ?? "").trim();
    const said = [
      above.startsWith("//") ? above : "",
      ...lines.slice(i, end + 1),
    ];
    if (said.some((l) => /\/\/\s*aio-ok:[ \t]*\S/.test(l))) continue;
    hits.push({ line: i + 1, text: lines[i]!.trim() });
  }
  return hits;
}

const at = (src: string) => osBareReturns(src).map((h) => h.line);

Deno.test("os bare return: the scanner sees every shape of the skip, in test bodies only", () => {
  // first statement, mid-test, a constant, a block that only logs, a step
  assertEquals(
    at(`const WIN = Deno.build.os === "windows";
Deno.test("a", async (t) => {
  if (Deno.build.os === "windows") return; // no POSIX mode
  const x = 1;
  if (WIN) return;
  if (!WIN && x) {
    console.log("skipped");
    return;
  }
  await t.step("s", () => {
    if (
      Deno.build.os !== "linux" ||
      Deno.uid() === 0
    ) return;
  });
});
`),
    [3, 5, 6, 11],
  );
  // a constant made from a constant, to the end of the chain; the other
  // spellings of the OS
  assertEquals(
    at(`const WIN = Deno.build.os === "windows";
const POSIX = !WIN;
const UID = POSIX && uid() !== null;
Deno.test("a", () => {
  if (!POSIX) return;
  if (!UID) return;
  if (Deno.build.target.includes("apple")) return;
  if (process.platform === "win32") return;
});
`),
    [5, 6, 7, 8],
  );
  // registered in a loop; each options form
  assertEquals(
    at(`for (const k of [1]) {
  Deno.test({
    name: "b",
    fn() {
      if (Deno.build.os === "darwin") return;
    },
  });
}
Deno.test({
  name: "c",
  ignore: false,
}, () =>
  wrapped(async () => {
    if (Deno.build.os === "darwin") return;
  }));
Deno.test("d", {
  ignore: false,
}, async () => {
  if (Deno.build.os === "darwin") return;
});
`),
    [5, 14, 19],
  );
});

Deno.test("os bare return: what is not a skip is left alone", () => {
  assertEquals(
    at(`const WIN = Deno.build.os === "windows";
const EXE = WIN ? ".exe" : "";
function helper() {
  if (WIN) return; // outside a test body
}
Deno.test("a", () => {
  if (done) return; // not the OS
  if (WIN) return 1; // a value
  if (WIN) {
    assertEquals(1, 1); // the OS's own branch asserts
    return;
  }
  if (WIN) {
    work();
  }
  if (other) {
    console.log(WIN);
    return;
  }
  // aio-ok: a closure of the product's, not the test's flow
  if (WIN) return;
  if (WIN) return; // aio-ok: same, said on the line
  if (WIN) return; // aio-ok:
});
`),
    [23], // an empty reason admits nothing
  );
});

Deno.test("os bare return: no test body returns on an OS — a skip is `ignore:` with its reason", async () => {
  const found: string[] = [];
  let files = 0;
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) {
        if (e.name !== "node_modules" && e.name !== "fixtures") await walk(p);
      } else if (/\.test\.tsx?$/.test(e.name)) {
        files++;
        // This file's own cases are the shapes it refuses.
        if (p === fromFileUrl(import.meta.url)) continue;
        for (const h of osBareReturns(await Deno.readTextFile(p))) {
          found.push(
            `${
              p.slice(ROOT.length).replaceAll("\\", "/")
            }:${h.line}  ${h.text}`,
          );
        }
      }
    }
  };
  await walk(join(ROOT, "tests"));
  await walk(join(ROOT, "amui", "src"));
  assertEquals(files > 500, true, `only ${files} test files were scanned`);
  assertEquals(
    found,
    [],
    "a test that returns on an OS passes there without running. Port it, or " +
      "gate it with `ignore: <condition>, // <reason>`; `// aio-ok: <reason>` " +
      "only for a return that does not skip the test",
  );
});
