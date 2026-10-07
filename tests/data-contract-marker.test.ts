// `<binary> --aio-data-contract` is read by a program (`aio ship`, the git
// update source), and stdout is the contract "and nothing else" only as far
// as aio decides what is printed. An app's own module-level `console.log`
// runs before aio does and lands on the same stdout: that app's every publish
// was refused with "is not JSON", and nothing it could configure changed it.
// The contract is also printed on a marker line of its own, which a reader
// finds whatever surrounds it; a build older than the line is still read from
// its stdout.
import { writeProgram } from "./fake-program-helper.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  parseDataContract,
  probeArtifact,
  shipApp,
} from "../src/build/ship.ts";
import {
  DATA_CONTRACT_MARK,
  markedDataContract,
  PROBE_NONCE_ENV,
  probedFact,
  probeLine,
  probeNonce,
} from "../src/server/updates-core.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const CONTRACT = {
  schema: 1,
  cells: { notes: { version: 3, migratesFrom: 1 } },
};
const ONE_LINE = JSON.stringify(CONTRACT);
/** The plain marker line a binary prints for a contract. */
const dataContractLine = (c: unknown) =>
  probeLine("data-contract", JSON.stringify(c));

Deno.test("data contract marker: the marker line carries the contract, and the last one counts", () => {
  assertEquals(dataContractLine(CONTRACT), DATA_CONTRACT_MARK + ONE_LINE);
  assertEquals(markedDataContract(dataContractLine(CONTRACT)), ONE_LINE);
  const table: Array<[string, string, string | null]> = [
    ["no marker", `{"schema":1}\n`, null],
    ["nothing", "", null],
    [
      "between other lines",
      `boot\n${DATA_CONTRACT_MARK}{"a":1}\n[aio] app-id: x\n`,
      `{"a":1}`,
    ],
    [
      "windows line ends",
      `${DATA_CONTRACT_MARK}{"a":1}\r\nmore\r\n`,
      `{"a":1}`,
    ],
    [
      "the app printed one first",
      `${DATA_CONTRACT_MARK}{"fake":1}\n${DATA_CONTRACT_MARK}{"a":1}\n`,
      `{"a":1}`,
    ],
    // A line that only MENTIONS the marker is not the marker line.
    ["mid-line", `see ${DATA_CONTRACT_MARK}{"a":1}\n`, null],
  ];
  assertEquals(
    table.map(([what, text]) => [what, markedDataContract(text)]),
    table.map(([what, , want]) => [what, want]),
  );
});

Deno.test("data contract marker: a capture of stderr parses as the contract; a capture with neither form is named", () => {
  assertEquals(
    parseDataContract(
      `INFO boot\n${dataContractLine(CONTRACT)}\n[aio] app-id: notes\n`,
      "contract.json",
    ),
    CONTRACT,
  );
  assertEquals(parseDataContract(`${ONE_LINE}\n`, "contract.json"), CONTRACT);
  let said = "";
  try {
    parseDataContract(`hello\n${ONE_LINE}\n`, "contract.json");
  } catch (e) {
    said = (e as Error).message;
  }
  assertStringIncludes(said, "contract.json is not JSON");
  assertStringIncludes(said, "first line: hello");
  assertStringIncludes(said, "2> contract.json");
});

/** An executable that answers the probe with these shell lines. */
async function answering(dir: string, lines: string): Promise<string> {
  const bin = join(dir, "app.bin");
  await writeProgram(bin, `#!/bin/sh\n${lines}\nexit 0\n`);
  return bin;
}

Deno.test({
  name:
    "data contract marker: the probe reads the marker line past anything on stdout, and an older build's bare stdout",
  fn: async () => {
    const dir = await tempDir("aio-contract-marker-");
    try {
      // Noise before and after, on both streams.
      const noisy = await answering(
        dir,
        `echo 'Starting up...'\necho '${ONE_LINE}'\necho 'bye'\n` +
          `echo 'warming' >&2\necho '${dataContractLine(CONTRACT)}' >&2\n` +
          `echo '[aio] app-id: notes' >&2`,
      );
      assertEquals(await probeArtifact(noisy), {
        contract: CONTRACT,
        appId: "notes",
      });
      // Before the marker: stdout is the contract.
      const old = await answering(dir, `echo '${ONE_LINE}'`);
      assertEquals(await probeArtifact(old), { contract: CONTRACT });
      // Before the marker AND printing: nothing to find — said, not guessed.
      const oldNoisy = await answering(
        dir,
        `echo 'Starting up...'\necho '${ONE_LINE}'`,
      );
      const err = await assertRejects(() => probeArtifact(oldNoisy), Error);
      assertStringIncludes(err.message, "is not JSON");
      assertStringIncludes(err.message, "first line: Starting up...");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "data contract marker: a real app that prints at module top level still publishes its contract",
  fn: async () => {
    const dir = await tempDir("aio-contract-banner-");
    const repo = fromFileUrl(new URL("../", import.meta.url));
    try {
      const entry = join(dir, "app.ts");
      await Deno.writeTextFile(
        entry,
        `console.log("demo starting");\n` +
          `import { aio, cell } from "${spec(repo)}mod.ts";\n` +
          `console.log({ loaded: true });\n` +
          `export const notes = cell("notes", {\n` +
          `  version: 3,\n` +
          `  state: { items: [] as string[] },\n` +
          `  onMigrate: (s: Record<string, unknown>) => s,\n` +
          `  methods: {},\n` +
          `});\n` +
          `await aio.run({ cells: [notes], appId: "notes", ` +
          `libraryMode: true, baseDir: "${dir}" });\n`,
      );
      const run = [
        "run",
        "-A",
        "--config",
        `${repo}deno.json`,
        entry,
      ];
      // What the app prints: stdout is NOT the contract alone…
      const out = await new Deno.Command(Deno.execPath(), {
        args: [...run, "--aio-data-contract"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, stderr);
      assertStringIncludes(stdout, "demo starting\n");
      assertStringIncludes(stdout, "{ loaded: true }\n");
      // …the bare JSON is still there for whoever reads that…
      assertEquals(JSON.parse(stdout.slice(stdout.indexOf("\n{\n"))), CONTRACT);
      // …and the marker line says the same thing.
      assertEquals(JSON.parse(markedDataContract(stderr) ?? "null"), CONTRACT);

      // The publish that was refused.
      const script = join(dir, "app.bin");
      await writeProgram(
        script,
        `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config ` +
          `"${repo}deno.json" "${entry}" "$@"\n`,
      );
      await Deno.mkdir(join(dir, "src"), { recursive: true });
      await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
      const m = await shipApp({
        binaryPath: script,
        sourceDir: join(dir, "src"),
        name: "notes",
        version: "1.0.0",
      });
      assertEquals(m.data, CONTRACT);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A fixed marker can be printed by anyone. The three facts a probe reads were
// each found by shape alone — and two of them by the FIRST line of that shape,
// so a line the app printed at import was taken for the framework's.
Deno.test("probe nonce: a fact is read off the line that carries the reader's own value — one rule for all three", () => {
  const N = "3f0c9a7e-1111-4222-8333-444455556666";
  assertEquals(
    [N, "short", "has space 12345", "a]b-c-d-e-f-g", undefined, ""]
      .map(probeNonce),
    [N, undefined, undefined, undefined, undefined, undefined],
  );
  assertEquals(probeLine("app-id", "notes"), "[aio] app-id: notes");
  assertEquals(probeLine("app-id", "notes", N), `[aio:${N}] app-id: notes`);
  const facts = ["data-contract", "persisting-cells", "app-id"] as const;
  // The app prints all three, before and after; the framework prints its own.
  const spoken = [
    ...facts.map((f) => probeLine(f, "forged-first")),
    ...facts.map((f) => probeLine(f, "forged", "another-nonce-0000")),
    probeLine("data-contract", "real-contract", N),
    probeLine("persisting-cells", "2", N),
    ...facts.map((f) => probeLine(f, "forged-last")),
  ].join("\n");
  assertEquals(facts.map((f) => probedFact(spoken, f, N)), [
    "real-contract",
    "2",
    // The framework left this one out (no id): a plain line is NOT the answer.
    null,
  ]);
  // A binary older than the nonce prints plain lines: the last of each.
  const old = [
    probeLine("app-id", "forged"),
    probeLine("persisting-cells", "9"),
    probeLine("app-id", "notes"),
    probeLine("persisting-cells", "2"),
  ].join("\r\n");
  assertEquals(facts.map((f) => probedFact(old, f, N)), [null, "2", "notes"]);
  assertEquals(facts.map((f) => probedFact(old, f)), [null, "2", "notes"]);
  // Asked without a nonce, a nonce line is nobody's.
  assertEquals(probedFact(spoken, "app-id"), "forged-last");
});

Deno.test({
  name:
    "probe nonce: the probe hands the binary a value, and lines of that shape the app printed are not the binary's answer",
  fn: async () => {
    const dir = await tempDir("aio-probe-nonce-");
    try {
      const forged = JSON.stringify({ schema: 9, cells: { evil: {} } });
      // What an app printing at import puts on stderr — before AND after.
      const noise = `echo '[aio] data-contract: ${forged}' >&2\n` +
        `echo '[aio] persisting-cells: 0' >&2\necho '[aio] app-id: evil' >&2`;
      const speaks = await answering(
        dir,
        `${noise}\necho '${ONE_LINE}'\n` +
          `echo "[aio:$${PROBE_NONCE_ENV}] data-contract: ${
            ONE_LINE.replaceAll('"', '\\"')
          }" >&2\n` +
          `echo "[aio:$${PROBE_NONCE_ENV}] persisting-cells: 1" >&2\n` +
          `echo "[aio:$${PROBE_NONCE_ENV}] app-id: notes" >&2\n${noise}`,
      );
      assertEquals(await probeArtifact(speaks), {
        contract: CONTRACT,
        appId: "notes",
      });
      // The count beside an EMPTY contract is what the publisher is warned
      // by — the binary's own count, not the app's line after it.
      const empty = JSON.stringify({ schema: 1, cells: {} });
      const persists = await answering(
        dir,
        `echo '${empty}'\n` +
          `echo "[aio:$${PROBE_NONCE_ENV}] persisting-cells: 2" >&2\n` +
          `echo '[aio] persisting-cells: 0' >&2`,
      );
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
      try {
        await probeArtifact(persists);
      } finally {
        console.warn = warn;
      }
      assertEquals(warned.length, 1, warned.join("\n"));
      assertStringIncludes(warned[0]!, "this build persists 2");
      // …a different value on every probe.
      const seen = join(dir, "seen");
      const echoes = await answering(
        dir,
        `echo "$${PROBE_NONCE_ENV}" >> '${seen}'\necho '${ONE_LINE}'`,
      );
      await probeArtifact(echoes);
      await probeArtifact(echoes);
      const nonces = (await Deno.readTextFile(seen)).trim().split("\n");
      assertEquals(new Set(nonces).size, 2, nonces.join(" "));
      assertEquals(nonces.map(probeNonce), nonces);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "probe nonce: a real app that prints forged marker lines at import publishes its own contract and id",
  fn: async () => {
    const dir = await tempDir("aio-probe-forged-");
    const repo = fromFileUrl(new URL("../", import.meta.url));
    try {
      const entry = join(dir, "app.ts");
      await Deno.writeTextFile(
        entry,
        // At import, and again as the process ends — after aio's own lines.
        `const forge = () => {\n` +
          `  console.error('[aio] data-contract: {"schema":9,"cells":{}}');\n` +
          `  console.error("[aio] persisting-cells: 0");\n` +
          `  console.error("[aio] app-id: evil");\n` +
          `};\n` +
          `forge();\n` +
          `globalThis.addEventListener("unload", forge);\n` +
          `import { aio, cell } from "${spec(repo)}mod.ts";\n` +
          `export const notes = cell("notes", {\n` +
          `  version: 3,\n` +
          `  state: { items: [] as string[] },\n` +
          `  onMigrate: (s: Record<string, unknown>) => s,\n` +
          `  methods: {},\n` +
          `});\n` +
          `await aio.run({ cells: [notes], appId: "notes", ` +
          `libraryMode: true, baseDir: "${dir}" });\n`,
      );
      const script = join(dir, "app.bin");
      await writeProgram(
        script,
        `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config ` +
          `"${repo}deno.json" "${entry}" "$@"\n`,
      );
      assertEquals(await probeArtifact(script), {
        contract: CONTRACT,
        appId: "notes",
      });
      // Asked by hand, with no value: the plain lines, as before.
      const plain = await new Deno.Command(script, {
        args: ["--aio-data-contract"],
        stdout: "piped",
        stderr: "piped",
        env: { [PROBE_NONCE_ENV]: "" },
      }).output();
      const err = new TextDecoder().decode(plain.stderr);
      assertEquals(err.includes("[aio:"), false, err);
      assertStringIncludes(err, `${dataContractLine(CONTRACT)}\n`);
      assertStringIncludes(err, "[aio] app-id: notes\n");
      // The forged lines really are the last ones: only the value tells.
      assertEquals(probedFact(err, "app-id"), "evil");
    } finally {
      await dropTempDir(dir);
    }
  },
});
