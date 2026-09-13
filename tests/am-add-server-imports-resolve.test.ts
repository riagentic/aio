// `am add server|cell` — every name the generated module imports from an aio
// entry is one that entry actually exports.
//
// `am add server` wrote `import { serverFns } from "aio/server"`. The server
// entry does not export serverFns (it lives on "aio"), so the module failed its
// own type-check and the app crashed at boot on the missing export — while the
// generator's test asserted the wrong specifier as a string. A string match
// cannot tell a right import from a wrong one; resolving it against the real
// `exports` map can.
import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const EXPORTS = JSON.parse(await Deno.readTextFile(`${REPO}deno.json`))
  .exports as Record<string, string>;

/** `aio` → ".", `aio/server` → "./server" — the deno.json exports key. */
function entryFor(spec: string): string | undefined {
  if (spec === "aio") return EXPORTS["."];
  if (spec.startsWith("aio/")) return EXPORTS[`./${spec.slice(4)}`];
  return undefined;
}

/** Each `import { a, b } from "aio…"` in a source, as [spec, names]. */
function aioImports(src: string): [string, string[]][] {
  return [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(aio[^"]*)"/g)].map(
    (m) => [
      m[2]!,
      m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, ""))
        .filter(Boolean),
    ],
  );
}

async function am(args: string[], cwd: string) {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    cwd,
    env: { AIO_APPS_DIR: `${cwd}/.aio-home`, AIO_AM_NO_DELEGATE: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { code: p.code, text: d.decode(p.stdout) + d.decode(p.stderr) };
}

for (
  const [kind, file] of [
    ["server", "src/server/billing.server.ts"],
    ["cell", "src/cell/billing.ts"],
  ] as const
) {
  Deno.test(`am add ${kind}: the generated imports resolve against the real entries`, async () => {
    const dir = await tempDir(`am-add-${kind}-imports-`);
    try {
      await Deno.mkdir(`${dir}/src`, { recursive: true });
      await Deno.writeTextFile(`${dir}/src/app.ts`, `await 1;\n`);
      const r = await am(["add", kind, "billing"], dir);
      assertEquals(r.code, 0, r.text);
      const imports = aioImports(await Deno.readTextFile(`${dir}/${file}`));
      assert(imports.length > 0, `no aio import found in ${file}`);
      for (const [spec, names] of imports) {
        const entry = entryFor(spec);
        assert(
          entry,
          `${file} imports "${spec}", which deno.json does not export`,
        );
        const mod = await import(toFileUrl(`${REPO}${entry.slice(2)}`).href);
        const missing = names.filter((n) => !(n in mod));
        assertEquals(
          missing,
          [],
          `${file} imports ${missing.join(", ")} from "${spec}" (${entry}), ` +
            `which does not export it — the scaffolded app crashes at boot`,
        );
      }
    } finally {
      await dropTempDir(dir);
    }
  });
}
