// amui's ＋ (create app) failed with no reason: "create failed: ".
//
// `am` answers a piped caller in JSON on STDOUT (`{"error":"'x' already
// exists …"}`); createApp read stderr only, which is empty, so the one line
// that said what was wrong never reached the user.
import { assertStringIncludes } from "@std/assert";
import { createApp } from "../amui/src/server/proc.server.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("amui createApp: a refused create says why", async () => {
  // The real deno cache, before HOME moves (it defaults under HOME).
  const info = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const denoDir: string = JSON.parse(new TextDecoder().decode(info.stdout))
    .denoDir;
  const sandbox = await tempDir("amui-r3-create-");
  await Deno.mkdir(`${sandbox}/aio-apps/taken`, { recursive: true });
  await Deno.writeTextFile(`${sandbox}/aio-apps/taken/keep.txt`, "x");
  const keys = ["HOME", "DENO_DIR"] as const;
  const prev = keys.map((k) => Deno.env.get(k));
  Deno.env.set("HOME", sandbox);
  Deno.env.set("DENO_DIR", denoDir);
  try {
    const r = await createApp("taken");
    assertStringIncludes(
      r.error ?? "",
      "already exists",
      `no reason reached the user: ${JSON.stringify(r)}`,
    );
  } finally {
    keys.forEach((k, i) => {
      const v = prev[i];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    });
    await dropTempDir(sandbox);
  }
});
