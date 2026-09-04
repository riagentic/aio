// The generated systemd unit must mean what it reads.
//
// systemd has no trailing-comment syntax — a `#` is a comment only at the
// start of a line — and the unit `writeServiceFile` produced carried two
// comments AFTER a directive:
//
//     ExecStart=/usr/local/bin/app --port=3000 …  # adjust path after install
//     RestartPreventExitStatus=143   # aio.stop() exits 143 to stay down
//
// Measured with `systemd-analyze verify` (systemd 255): the first line's
// command became `… --client=server-only # adjust path after install` — FIVE
// extra argv words handed to the binary on every start — and the second logged
// "Failed to parse value, ignoring: #" (and five more) on every daemon-reload.
// aio's own parser passes bare words through to the app, so the service booted
// and nothing said the unit was wrong: a broken file that happens to work, on
// a machine the build never sees.
//
// Two checks. The pure one reads the unit the way systemd does — a directive's
// value is everything after `=`, and a `#` in it is not a comment — and must
// find no comment text there. The second asks systemd itself, where there is
// one, so the rule cannot drift from the parser it is about.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { writeServiceFile } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function unitFor(
  opts: { doRemote: boolean; doHeadless: boolean },
): Promise<{ dir: string; unit: string }> {
  const dir = await tempDir("aio-unit-comments-");
  await writeServiceFile(
    {
      binaryName: "svc",
      appTitle: "Svc",
      outDir: dir,
      root: dir,
      ...opts,
    } as unknown as Parameters<typeof writeServiceFile>[0],
  );
  return { dir, unit: await Deno.readTextFile(join(dir, "svc.service")) };
}

/** `Key=value` lines, as systemd reads them: the value is the REST OF THE
 *  LINE, `#` included. */
function directives(unit: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of unit.split("\n")) {
    if (/^\s*[#;]/.test(line) || /^\s*\[/.test(line) || !line.trim()) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return out;
}

Deno.test("service unit: no directive carries a trailing comment — systemd would hand it to the binary", async () => {
  const { dir, unit } = await unitFor({ doRemote: true, doHeadless: true });
  try {
    const ds = directives(unit);
    assert(ds.length > 5, `no directives parsed from:\n${unit}`);
    for (const d of ds) {
      assert(
        !d.value.includes("#"),
        `${d.key}= carries "#" in its VALUE — systemd has no trailing ` +
          `comments, so this text reaches the directive:\n  ${d.key}=${d.value}`,
      );
    }
    // The two that were wrong, by name: the command line is exactly the
    // binary plus the runtime flags, and the exit status is exactly 143.
    const exec = ds.find((d) => d.key === "ExecStart")!;
    assertEquals(
      exec.value.trim(),
      "/usr/local/bin/svc --port=3000 --expose --client=server-only",
      `ExecStart must be the binary and its flags, nothing else: ${exec.value}`,
    );
    const rpes = ds.find((d) => d.key === "RestartPreventExitStatus")!;
    assertEquals(rpes.value.trim(), "143");
    // …and the advice the comments carried is still there, as comments.
    assert(/^#.*adjust/im.test(unit), "the install-path note survives");
    assert(/^#.*143/m.test(unit), "the exit-status note survives");
  } finally {
    await dropTempDir(dir);
  }
});

/** systemd's own verifier, when this machine has one. Null otherwise. */
async function systemdVerify(path: string): Promise<string | null> {
  try {
    const r = await new Deno.Command("systemd-analyze", {
      args: ["verify", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(r.stderr) +
      new TextDecoder().decode(r.stdout);
  } catch {
    // aio-ok: no systemd-analyze on this host — the pure check above is the
    // gate everywhere; this one only adds the real parser's verdict where it
    // exists.
    return null;
  }
}

Deno.test("service unit: systemd itself parses every value (where systemd-analyze exists)", async () => {
  const { dir, unit } = await unitFor({ doRemote: false, doHeadless: true });
  try {
    const verdict = await systemdVerify(join(dir, "svc.service"));
    if (verdict === null) return; // no systemd here — see systemdVerify
    // "Command … is not executable" is expected: the binary is not installed
    // on the test box. A PARSE complaint is the defect this test is about.
    assert(
      !/Failed to parse/i.test(verdict),
      `systemd could not parse the generated unit:\n${verdict}\n--- unit ---\n${unit}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});
