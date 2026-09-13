// A `worker: true` cell's thread takes the OWNER's appId — it never re-derives it.
//
// The worker re-runs the app's entry, and that entry's `aio.run()` resolves the
// identity again. Inside a Deno worker `Deno.mainModule` is undefined (in
// `deno run` AND in a compiled binary), so `resolveAppId` could see neither the
// embedded deno.json nor the entry's directory — only the CWD. Measured on a
// compiled app with no explicit appId: launched from `/` it died at boot with
// `cell worker "heavy" crashed: … cannot infer an appId`; launched from another
// project's directory its worker took THAT project's identity. The build e2e
// passed an explicit appId, so it never saw either.
//
// Both halves reproduce under plain `deno run`, which is what this drives.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { aioTestDir } from "../src/testing/test-strict.ts";
import {
  cellWorkerName,
  parseCellWorkerName,
} from "../src/server/cell-worker-protocol.ts";

const AIO_ROOT = new URL("..", import.meta.url).pathname;

/** The probe app: one worker cell whose method reports the identity the
 *  WORKER resolves, and a main isolate that reports its own, optionally after
 *  moving the process into another project's directory. */
const APP = `import { aio, cell, isCellWorker } from "${
  join(AIO_ROOT, "mod.ts")
}";
import { resolveAppId } from "${
  join(AIO_ROOT, "src/server/single-instance-lock.ts")
}";
export const idProbe = cell("idProbe", {
  worker: true,
  state: { n: 0 },
  methods: {
    who(_s: { n: number }) {
      return { id: resolveAppId(), inWorker: isCellWorker() };
    },
  },
});
await aio.run({ cells: [idProbe] });
if (!isCellWorker()) {
  const main = resolveAppId();
  const to = Deno.env.get("PROBE_CHDIR");
  if (to) Deno.chdir(to);
  const worker = await idProbe.who();
  console.log("IDPROBE " + JSON.stringify({ main, worker }));
  Deno.exit(0);
}
`;

async function probe(
  opts: { entry: string; cwd: string; chdir?: string },
): Promise<{ main: string; worker: { id: string; inWorker: boolean } }> {
  const port = await freePort();
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      `--config=${join(AIO_ROOT, "deno.json")}`,
      opts.entry,
      `--port=${port}`,
      "--client=server-only",
    ],
    cwd: opts.cwd,
    env: {
      AIO_APPS_DIR: aioTestDir("wk-appid-"),
      ...(opts.chdir ? { PROBE_CHDIR: opts.chdir } : {}),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  const line = out.split("\n").find((l) => l.startsWith("IDPROBE "));
  if (!line) {
    throw new Error(
      `probe app printed no identity (exit ${r.code}).\nstdout:\n${out}\n` +
        `stderr:\n${new TextDecoder().decode(r.stderr)}`,
    );
  }
  return JSON.parse(line.slice("IDPROBE ".length));
}

async function project(): Promise<{ root: string; entry: string }> {
  const root = await Deno.makeTempDir({ prefix: "aio-wkid-own-" });
  await Deno.mkdir(join(root, "src"));
  const entry = join(root, "src", "app.ts");
  await Deno.writeTextFile(entry, APP);
  // Its own identity, so a boot FROM the project root resolves cleanly on
  // both isolates — the foreign case then isolates the re-derivation alone.
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ title: "wkid own probe" }),
  );
  return { root, entry };
}

Deno.test("worker cell: no appId, launched from a dir with no deno.json — the worker boots with main's identity", async () => {
  const { root, entry } = await project();
  const empty = await Deno.makeTempDir({ prefix: "aio-wkid-empty-" });
  try {
    const got = await probe({ entry, cwd: empty });
    assert(got.worker.inWorker, "the method must really run in the worker");
    assertEquals(got.worker.id, got.main);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("worker cell: a foreign project's deno.json in the cwd never becomes the worker's identity", async () => {
  const { root, entry } = await project();
  const foreign = await Deno.makeTempDir({ prefix: "aio-wkid-foreign-" });
  await Deno.writeTextFile(
    join(foreign, "deno.json"),
    JSON.stringify({ title: "someone else's app" }),
  );
  try {
    // Boot where main's inference is unambiguous, then put the process in the
    // foreign project — the state a compiled binary is in from its first line.
    const got = await probe({ entry, cwd: root, chdir: foreign });
    assert(got.worker.inWorker, "the method must really run in the worker");
    assertEquals(got.main, "wkid-own-probe");
    assertEquals(got.worker.id, got.main);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(foreign, { recursive: true });
  }
});

Deno.test("cellWorkerName round-trips the cell and the owner's appId", () => {
  assertEquals(parseCellWorkerName(cellWorkerName("heavy-1", "my-app-2")), {
    cell: "heavy-1",
    appId: "my-app-2",
  });
  // No identity to hand over → the historical name, unchanged.
  assertEquals(cellWorkerName("heavy"), "aio-cell:heavy");
  assertEquals(parseCellWorkerName("aio-cell:heavy"), {
    cell: "heavy",
    appId: null,
  });
  assertEquals(parseCellWorkerName("some-other-worker"), null);
});
