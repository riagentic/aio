// The dev checkpoint (`logs/checkpoint.json`) never holds a field that
// `persist: { exclude }` keeps off disk — top-level or dot path — and restoring
// it brings those fields back exactly as a restart does.
//
// The docs promise an excluded field is "not written to disk"
// (docs/auth/secrets-and-observability.md). The checkpoint wrote raw state —
// excluded API keys and nested per-account secrets included — on purpose, "so a
// restored checkpoint keeps them". A restart already brings them back as the
// declared default; a checkpoint restore now does the same. Driven as a real
// app in a subprocess that dies without a clean stop (`Deno.exit(0)`).
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const url = (rel: string) => toFileUrl(join(REPO, rel)).href;

const PROBE = `// deno-lint-ignore-file no-explicit-any
const step = Deno.args[0];
const { cell } = await import(${
  JSON.stringify(url("src/state/cell-create.ts"))
});
const { aio } = await import(${JSON.stringify(url("mod.ts"))});
const { freePort } = await import(${
  JSON.stringify(url("src/testing/server-test.ts"))
});
const vault = cell("vault", {
  state: {
    name: "",
    apiKey: "DEFAULT-KEY",
    accounts: {} as Record<string, { label: string; encSecKey?: string }>,
  },
  persist: { exclude: ["apiKey", "accounts.encSecKey"] },
  visible: { exclude: ["apiKey", "accounts.encSecKey"] },
  methods: {
    setup(s: any) {
      s.name = "alice";
      s.apiKey = "TOP-SECRET-5501";
      s.accounts.a1 = { label: "main", encSecKey: "NESTED-SECRET-7702" };
    },
  },
});
const app: any = await aio.run({
  cells: [vault], appId: "cp-exclude", appDir: Deno.env.get("DIR"),
  client: "server-only", libraryMode: true, port: freePort(),
  diagnostics: { dev: { actionLog: false, checkpoint: { debounce: 0 } } },
  onCheckpointRestore: (cp: any) => cp.state,
} as any);
if (step === "write") {
  await (vault as any).setup();
  await new Promise((r) => setTimeout(r, 300));
}
console.log("STATE " + JSON.stringify(app.getState()));
Deno.exit(0);
`;

async function run(
  probe: string,
  dir: string,
  step: string,
): Promise<Record<string, unknown>> {
  const out = await new Deno.Command("deno", {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), probe, step],
    env: { DIR: dir, AIO_APPS_DIR: dir, AIO_NO_OPEN: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const line = text.split("\n").find((l) => l.startsWith("STATE "));
  assert(
    line,
    `${step}: no state line (exit ${out.code})\n${text}\n` +
      new TextDecoder().decode(out.stderr).slice(-4000),
  );
  return JSON.parse(line.slice(6));
}

type Vault = {
  name: string;
  apiKey: string;
  accounts: Record<string, { label: string; encSecKey?: string }>;
};

Deno.test("checkpoint: persist-excluded fields (top-level + nested) never reach checkpoint.json; restore gives restart values", async () => {
  const dir = await tempDir("cp-exclude-");
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(probe, PROBE);
  const w = await run(probe, dir, "write");
  assertEquals((w.vault as Vault).apiKey, "TOP-SECRET-5501", "control: set");

  const cp = await Deno.readTextFile(join(dir, "logs", "checkpoint.json"));
  assert(cp.includes("alice"), `control: checkpoint written: ${cp}`);
  assert(!cp.includes("TOP-SECRET-5501"), `top-level excluded field: ${cp}`);
  assert(!cp.includes("NESTED-SECRET-7702"), `nested excluded field: ${cp}`);

  const r = (await run(probe, dir, "read")).vault as Vault;
  assertEquals(r.name, "alice", "control: persisted field restored");
  assertEquals(r.apiKey, "DEFAULT-KEY", "excluded field = declared default");
  assertEquals(r.accounts, { a1: { label: "main" } }, "nested excluded field");
});

Deno.test("checkpoint: a raw checkpoint an OLDER build wrote never hands back persist-excluded fields, and is rewritten", async () => {
  const dir = await tempDir("cp-exclude-raw-");
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(probe, PROBE);
  await run(probe, dir, "read"); // creates the data layout
  const file = join(dir, "logs", "checkpoint.json");
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      ts: Date.now(),
      state: {
        vault: {
          name: "raw",
          apiKey: "RAW-SECRET-1",
          accounts: { a1: { label: "x", encSecKey: "RAW-SECRET-2" } },
        },
      },
      recentActions: [],
      cells: {},
    }),
    { mode: 0o600 },
  );
  const r = (await run(probe, dir, "read")).vault as Vault;
  assertEquals(r.name, "raw", "control: the checkpoint restored");
  assertEquals(r.apiKey, "DEFAULT-KEY", "excluded field from a raw checkpoint");
  assertEquals(r.accounts, { a1: { label: "x" } }, "nested, raw checkpoint");
  const cp = await Deno.readTextFile(file);
  assert(!cp.includes("RAW-SECRET"), `old checkpoint left on disk: ${cp}`);
});
