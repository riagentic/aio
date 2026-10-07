// A relaunched successor inherited every descriptor its predecessor had — an
// AppImage runtime's keep-alive pipe among them, so the OLD version's runtime
// and its mount of the replaced file lived as long as the new version did
// (measured on a real AppImage update). On Linux the successor now starts
// through a shell (bash first), closing everything above stderr before the exec.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  CLOSE_FDS_EXEC,
  CLOSE_FDS_EXEC_ALL,
  CLOSE_FDS_EXEC_BASH,
  envRestoreArgs,
  relaunchCommand,
} from "../src/server/updates-apply.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APPLY = new URL("../src/server/updates-apply.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const has = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};

async function childFds(shell: string) {
  const dir = await tempDir("aio-relaunch-fds-");
  try {
    const script = join(dir, "s.ts");
    await Deno.writeTextFile(
      script,
      `import { relaunchCommand } from ${JSON.stringify(APPLY)};
const mine = [...Deno.readDirSync("/proc/self/fd")].map((e) => e.name);
const real = Deno.realPathSync(${JSON.stringify(shell)});
const [cmd, o] = relaunchCommand("/bin/ls", { args: ["-1", "/proc/self/fd"], stdout: "piped", stderr: "piped" }, "linux", () => ({ path: ${
        JSON.stringify(shell)
      }, name: real.slice(real.lastIndexOf("/") + 1) }));
const out = await new Deno.Command(cmd, o).output();
const d = new TextDecoder();
console.log(JSON.stringify({ mine, code: out.code, err: d.decode(out.stderr), child: d.decode(out.stdout).trim().split("\\n") }));
`,
    );
    // An environment that would end the handover if the shell obeyed it:
    // bash sources `$BASH_ENV` before `-c` (Lmod, some images set it), and a
    // `$BASH_VERSION` exported into a dash must not select bash's script.
    const bashEnv = join(dir, "bash-env.sh");
    await Deno.writeTextFile(bashEnv, "exit 3\n");
    // fds 7 and 12 open and NOT close-on-exec, as the AppImage runtime (or a
    // terminal, an IDE) leaves them.
    // bash sets them up: dash reads `12>` as an argument `12` and `>`.
    const out = await new Deno.Command("/bin/bash", {
      args: [
        "-c",
        `exec 7>/dev/null; exec 3>/dev/null; BASH_ENV="${bashEnv}" BASH_VERSION=5.2 "${Deno.execPath()}" run -A --config "${CONFIG}" "${script}" 12>/dev/null`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    assertEquals(out.code, 0, d.decode(out.stderr));
    const r = JSON.parse(d.decode(out.stdout)) as {
      mine: string[];
      code: number;
      err: string;
      child: string[];
    };
    assert(r.mine.includes("7") && r.mine.includes("12"), "setup: fds 7/12");
    // The successor STARTS, whatever the shell — a failed close never stops it.
    assertEquals(r.code, 0, `the successor did not start: ${r.err}`);
    return r.child;
  } finally {
    await dropTempDir(dir);
  }
}

/** busybox picks its applet by the name it was started as: an `sh` link, as
 *  Alpine's `/bin/sh` is. */
async function busyboxSh(dir: string) {
  const link = join(dir, "sh");
  await Deno.symlink("/usr/bin/busybox", link);
  return link;
}

for (const shell of ["/bin/bash", "/bin/dash", "/bin/sh", "busybox"]) {
  Deno.test({
    name:
      `relaunch: the successor does not inherit the predecessor's descriptors (an AppImage keep-alive pipe) — via ${shell}`,
    // the relaunch goes through a POSIX shell, and descriptors are read from /proc
    ignore: Deno.build.os !== "linux" || !has("/bin/bash") ||
      !has(shell === "busybox" ? "/usr/bin/busybox" : shell),
    fn: async () => {
      const dir = await tempDir("aio-relaunch-busybox-");
      try {
        const sh = shell === "busybox" ? await busyboxSh(dir) : shell;
        const child = await childFds(sh);
        assert(!child.includes("7"), `the successor inherited fd 7: ${child}`);
        // dash cannot close a two-digit fd; bash and busybox close them all.
        const name = Deno.realPathSync(sh).split("/").pop();
        if (name === "bash" || name === "busybox") {
          assert(
            !child.includes("12"),
            `the successor inherited fd 12: ${child}`,
          );
        }
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}

const sh = (path: string) => () => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
});
const noHop = () => null;

Deno.test("relaunch: bash first, then /bin/sh; started directly off Linux or with no shell", () => {
  const o = { args: ["--x"] };
  assertEquals(relaunchCommand("/a", o, "darwin", sh("/bin/sh")), ["/a", o]);
  assertEquals(relaunchCommand("/a", o, "linux", () => null), ["/a", o]);
  const [cmd, via] = relaunchCommand("/a", o, "linux", sh("/bin/dash"), noHop);
  assertEquals(cmd, "/bin/dash");
  assertEquals(via.args, ["-c", CLOSE_FDS_EXEC, "/a", "--x"]);
  // bash: `-p`, so `$BASH_ENV` is never sourced, and its own script.
  assertEquals(
    relaunchCommand("/a", o, "linux", sh("/bin/bash"), noHop)[1].args,
    ["-p", "-c", CLOSE_FDS_EXEC_BASH, "/a", "--x"],
  );
  // What the shell IS decides the script, not the path it is started by.
  const ash = relaunchCommand("/a", o, "linux", () => ({
    path: "/bin/sh",
    name: "busybox",
  }), noHop);
  assertEquals(ash, ["/bin/sh", {
    args: ["-c", CLOSE_FDS_EXEC_ALL, "/a", "--x"],
  }]);
  const nix = relaunchCommand("/a", o, "linux", () => ({
    path: "/bin/sh",
    name: "bash",
  }), noHop);
  assertEquals(nix[1].args?.slice(0, 3), ["-p", "-c", CLOSE_FDS_EXEC_BASH]);
  // The env hop goes between the script and the artifact — never for an
  // artifact `env` would read as an assignment.
  const hop = () => ({ bin: "/usr/bin/env", env: { A: "1" } });
  assertEquals(
    relaunchCommand("/a", o, "linux", sh("/bin/dash"), hop)[1].args,
    [
      "-c",
      CLOSE_FDS_EXEC,
      "/usr/bin/env",
      ...envRestoreArgs({ A: "1" }),
      "/a",
      "--x",
    ],
  );
  assertEquals(
    relaunchCommand("/a=b", o, "linux", sh("/bin/dash"), hop)[1].args,
    ["-c", CLOSE_FDS_EXEC, "/a=b", "--x"],
  );
  // The defaults, on the machine running this: a shell on Linux, direct off it.
  if (Deno.build.os !== "linux") {
    assertEquals(relaunchCommand("/a", o), ["/a", o]);
  } else if (has("/bin/bash")) {
    assertEquals(relaunchCommand("/a", o)[0], "/bin/bash");
  }
});

Deno.test("envRestoreArgs: the shell-owned names are set or unset as they were; other identifiers ride through untouched", () => {
  const args = envRestoreArgs({ IFS: "ab", "my-var": "1", HOME: "/h" });
  assert(args.includes("IFS=ab") && args.includes("my-var=1"), `${args}`);
  assert(!args.some((a) => a.startsWith("HOME=")), "a plain name went in argv");
  for (const k of ["PWD", "OLDPWD", "SHLVL", "SHELLOPTS", "BASHOPTS", "_"]) {
    assert(args.join(" ").includes(`-u ${k}`), `${k} not unset: ${args}`);
  }
});

// The successor's environment is the one a direct spawn would have given it:
// dash and busybox drop names that are not shell identifiers, every shell
// resets IFS and PWD, bash -p replaces SHELLOPTS/BASHOPTS, busybox bumps SHLVL.
for (const shell of ["/bin/bash", "/bin/dash", "busybox"]) {
  Deno.test({
    name:
      `relaunch: the successor gets the environment it would have inherited directly — via ${shell}`,
    // the relaunch goes through a POSIX shell, and descriptors are read from /proc
    ignore: Deno.build.os !== "linux" || !has("/usr/bin/env") ||
      !has(shell === "busybox" ? "/usr/bin/busybox" : shell),
    fn: async () => {
      const dir = await tempDir("aio-relaunch-env-");
      try {
        const path = shell === "busybox" ? await busyboxSh(dir) : shell;
        const real = Deno.realPathSync(path);
        const o: Deno.CommandOptions = {
          args: ["-0"],
          stdout: "piped",
          clearEnv: true,
          env: {
            PATH: "/usr/bin:/bin",
            "my-var": "1",
            "a.b": "2",
            "BASH_FUNC_f%%": "() { echo; }",
            SHELLOPTS: "xtrace",
            BASHOPTS: "extglob",
            SHLVL: "4",
            IFS: "ab",
            PWD: "/nowhere",
          },
        };
        const read = async (cmd: string, opts: Deno.CommandOptions) => {
          const out = await new Deno.Command(cmd, opts).output();
          assertEquals(out.code, 0);
          return new TextDecoder().decode(out.stdout).split("\0").sort();
        };
        const direct = await read("/usr/bin/env", o);
        const [cmd, via] = relaunchCommand("/usr/bin/env", o, "linux", () => ({
          path,
          name: real.slice(real.lastIndexOf("/") + 1),
        }));
        assertEquals(await read(cmd, via), direct);
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}

Deno.test({
  name:
    "relaunch: bash's -p does not ride an exported SHELLOPTS into the successor",
  // the relaunch goes through a POSIX shell, and descriptors are read from /proc
  ignore: Deno.build.os !== "linux" || !has("/bin/bash") ||
    !has("/usr/bin/env"),
  fn: async () => {
    // Without the env hop: `set +p` alone keeps -p out.
    const [cmd, o] = relaunchCommand(
      "/usr/bin/env",
      {
        args: [],
        stdout: "piped",
        env: { SHELLOPTS: "braceexpand:hashall:interactive-comments" },
      },
      "linux",
      sh("/bin/bash"),
      noHop,
    );
    const out = await new Deno.Command(cmd, o).output();
    assertEquals(out.code, 0);
    const env = new TextDecoder().decode(out.stdout);
    assert(env.includes("SHELLOPTS="), env);
    assert(!/SHELLOPTS=.*privileged/.test(env), env);
  },
});
