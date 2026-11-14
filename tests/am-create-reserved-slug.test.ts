// `am create` refused a reserved name ("kube", "ssh", "aio" …) by comparing
// the RAW name — but the app's id, which names `~/.<appId>`, is the SLUG of
// it. `kube_`, `ssh-`, `config.`, `aio_` passed create, slugged to a reserved
// home, and the scaffold's very first `deno task dev` / `am start` was then
// refused by the boot's reservedAppHomeError: the check create exists to make
// up front, made one step too late.
import "./store-sandbox.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { resolveAppId } from "../src/server/app-id.ts";
import { RESERVED_APP_NAMES } from "../src/am/am-utils.ts";

const there = (p: string) => Deno.lstat(p).then(() => true, () => false);

Deno.test("am create: a name whose appId SLUG is reserved is refused, before anything is written", async () => {
  const names = ["kube_", "ssh-", "config.", "aio_"];
  for (const n of names) {
    assert(
      RESERVED_APP_NAMES.has(resolveAppId(n)),
      `${n} → ${resolveAppId(n)}`,
    );
  }
  const cwd = await tempDir("am-create-reserved-slug-");
  try {
    for (const name of names) {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--no-lock",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          fromFileUrl(new URL("../src/am.ts", import.meta.url)),
          "create",
          name,
          "--json",
        ],
        cwd,
        env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(out.stdout);
      assertEquals(out.code, 1, `${name}: ${text}`);
      if (name.endsWith(".")) {
        // Refused earlier, by the name rule itself (no trailing '.').
        assertStringIncludes(text, "do not end in '.'");
      } else {
        assertStringIncludes(text, "reserved");
        assertStringIncludes(text, `appId \\"${resolveAppId(name)}\\"`);
      }
      assertEquals(
        await there(join(cwd, name)),
        false,
        `${name} scaffolded anyway`,
      );
    }
  } finally {
    await dropTempDir(cwd);
  }
});
