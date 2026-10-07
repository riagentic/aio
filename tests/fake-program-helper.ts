// A fake PROGRAM a test can execute, on every OS, from one `#!/bin/sh` text.
//
// The update and ship tests stand a shell script in for an app binary:
// `#!/bin/sh\necho 2.0.0\n`, written to `app.new` and executed by the product
// (the smoke test, the data-contract probe, a relaunch). Windows executes
// neither a shebang nor an extension-less text file ("%1 is not a valid Win32
// application"), and a `.cmd` only runs under that name — the product renames
// its artifacts (`app.exe.new-2.0.0`, `app.exe.old-1.0.0`), which Windows runs
// fine as long as the BYTES are a real executable.
//
// So on Windows the same script is appended to a tiny real executable that
// reads it back from its own file and runs it. That executable is compiled
// once per test process by the C# compiler every Windows carries (Windows
// PowerShell's `Add-Type -OutputAssembly`); it models exactly the shell this
// suite's fixtures use and exits 97, naming the line, on anything else — a
// fixture that outgrows it fails loudly instead of doing something different
// on one OS.
//
// What it models, one command per line:
//   echo WORDS            (to stdout; `>&2`, `> "file"`, `>> "file"`)
//   exit N
//   sleep N · exec sleep N
//   touch "file"
//   exec "program" ARGS   (run it with this process's stdio, exit with its code)
//   if [ "$1" = "X" ]; then CMD; CMD; fi
// with '…' and "…" quoting; `"$@"` / `$*` for the arguments, `$1`…`$9`, and
// `$NAME` for an environment variable. Inside "…" a backslash escapes `"`, `$`
// and a backtick; anywhere else it is a plain character (it is one in every
// Windows path).
import { tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const WIN = Deno.build.os === "windows";

/** What a program's file name ends with here. Windows resolves a name with no
 *  extension at all by appending `.exe`, so `app` must be `app.exe` there; a
 *  name that already has a dot (`app.new`, `app.bin`) runs as it is. */
export const EXE = WIN ? ".exe" : "";

const MARK = "\n#!fake-program\n";

const STUB_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

static class FakeProgram {
  static string[] argv;

  static int Main(string[] args) {
    argv = args;
    var utf8 = new UTF8Encoding(false);
    Console.OutputEncoding = utf8;
    Console.Out.NewLine = "\n";
    Console.Error.NewLine = "\n";
    byte[] b = File.ReadAllBytes(Process.GetCurrentProcess().MainModule.FileName);
    byte[] m = Encoding.ASCII.GetBytes("\n#!fake-program\n");
    int at = -1;
    for (int i = b.Length - m.Length; i >= 0 && at < 0; i--) {
      int j = 0;
      while (j < m.Length && b[i + j] == m[j]) j++;
      if (j == m.Length) at = i + m.Length;
    }
    if (at < 0) return Unmodelled("(no script after the executable)");
    foreach (string line in utf8.GetString(b, at, b.Length - at).Split('\n')) {
      int code = Run(line.Trim());
      if (code >= 0) return code;
    }
    return 0;
  }

  static int Unmodelled(string line) {
    Console.Error.WriteLine("fake program (tests/fake-program-helper.ts): this line is not modelled on Windows: " + line);
    return 97;
  }

  // -1: carry on with the next line; anything else: exit with it.
  static int Run(string line) {
    if (line.Length == 0 || line[0] == '#') return -1;
    const string IF = "if [ \"$1\" = ";
    if (line.StartsWith(IF)) {
      int then = line.IndexOf(" ]; then ");
      if (then < 0 || !line.EndsWith("; fi")) return Unmodelled(line);
      List<string> want = Words(line.Substring(IF.Length, then - IF.Length));
      if (want.Count != 1) return Unmodelled(line);
      if (argv.Length == 0 || argv[0] != want[0]) return -1;
      int from = then + " ]; then ".Length;
      string body = line.Substring(from, line.Length - from - "; fi".Length);
      foreach (string c in body.Split(new[] { "; " }, StringSplitOptions.None)) {
        int code = Run(c.Trim());
        if (code >= 0) return code;
      }
      return -1;
    }
    List<string> w = Words(line);
    if (w.Count == 0) return -1;
    bool exec = w[0] == "exec";
    if (exec) w.RemoveAt(0);
    if (w.Count == 0) return Unmodelled(line);
    string cmd = w[0];
    w.RemoveAt(0);
    if (cmd == "exit" && w.Count <= 1 && !exec) return w.Count == 0 ? 0 : int.Parse(w[0]);
    if (cmd == "sleep" && w.Count == 1) {
      Thread.Sleep((int)(double.Parse(w[0], System.Globalization.CultureInfo.InvariantCulture) * 1000));
      return exec ? 0 : -1;
    }
    if (cmd == "touch" && w.Count == 1 && !exec) {
      File.AppendAllText(w[0], "");
      return -1;
    }
    if (cmd == "echo" && !exec) {
      string to = null;
      bool append = false, err = false;
      var text = new List<string>();
      for (int i = 0; i < w.Count; i++) {
        if (w[i] == "\u0001>&2") err = true;
        else if ((w[i] == "\u0001>>" || w[i] == "\u0001>") && i + 1 < w.Count) {
          append = w[i] == "\u0001>>";
          to = w[++i];
        } else if (w[i].StartsWith("\u0001")) return Unmodelled(line);
        else text.Add(w[i]);
      }
      string s = string.Join(" ", text) + "\n";
      if (to != null) {
        if (append) File.AppendAllText(to, s, new UTF8Encoding(false));
        else File.WriteAllText(to, s, new UTF8Encoding(false));
      } else if (err) Console.Error.Write(s);
      else Console.Out.Write(s);
      return -1;
    }
    if (exec) {
      foreach (string a in w) if (a.StartsWith("\u0001")) return Unmodelled(line);
      var sb = new StringBuilder();
      foreach (string a in w) {
        if (sb.Length > 0) sb.Append(' ');
        sb.Append(Quote(a));
      }
      var si = new ProcessStartInfo(cmd, sb.ToString());
      si.UseShellExecute = false;
      using (Process p = Process.Start(si)) {
        p.WaitForExit();
        return p.ExitCode;
      }
    }
    return Unmodelled(line);
  }

  // Shell words. An unquoted redirection operator comes back prefixed with
  // U+0001, so a quoted ">" stays text.
  static List<string> Words(string s) {
    var o = new List<string>();
    var cur = new StringBuilder();
    bool has = false;
    int i = 0;
    while (i < s.Length) {
      char c = s[i];
      if (c == ' ' || c == '\t') {
        if (has) { o.Add(cur.ToString()); cur.Length = 0; has = false; }
        i++;
      } else if (c == '\'') {
        int e = s.IndexOf('\'', i + 1);
        if (e < 0) e = s.Length;
        cur.Append(s, i + 1, e - i - 1);
        has = true;
        i = e + 1;
      } else if (c == '"') {
        if (!has && string.CompareOrdinal(s, i, "\"$@\"", 0, 4) == 0 && (i + 4 >= s.Length || s[i + 4] == ' ')) {
          o.AddRange(argv);
          i += 4;
          continue;
        }
        i++;
        while (i < s.Length && s[i] != '"') {
          if (s[i] == '\\' && i + 1 < s.Length && (s[i + 1] == '"' || s[i + 1] == '$' || s[i + 1] == '\u0060')) {
            cur.Append(s[i + 1]);
            i += 2;
          } else if (s[i] == '$') i = Dollar(s, i, cur);
          else cur.Append(s[i++]);
        }
        i++;
        has = true;
      } else if (c == '>' && !has) {
        int e = i;
        while (e < s.Length && s[e] != ' ') e++;
        o.Add("\u0001" + s.Substring(i, e - i));
        i = e;
      } else if (c == '$') {
        i = Dollar(s, i, cur);
        has = true;
      } else {
        cur.Append(c);
        has = true;
        i++;
      }
    }
    if (has) o.Add(cur.ToString());
    return o;
  }

  // "$@" / "$*" (the arguments, joined), "$1".."$9", "$NAME" (the environment
  // variable, empty when unset); any other "$" is itself. Returns the index
  // after what it read.
  static int Dollar(string s, int i, StringBuilder cur) {
    int e = i + 1;
    if (e < s.Length && (s[e] == '@' || s[e] == '*')) {
      cur.Append(string.Join(" ", argv));
      return e + 1;
    }
    if (e < s.Length && s[e] >= '1' && s[e] <= '9') {
      int n = s[e] - '1';
      if (n < argv.Length) cur.Append(argv[n]);
      return e + 1;
    }
    while (e < s.Length && (char.IsLetterOrDigit(s[e]) || s[e] == '_')) e++;
    if (e == i + 1) {
      cur.Append('$');
      return e;
    }
    cur.Append(Environment.GetEnvironmentVariable(s.Substring(i + 1, e - i - 1)) ?? "");
    return e;
  }

  // One argument, quoted the way the MSVC runtime splits a command line.
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') sb.Append('\\', slashes * 2 + 1);
      else sb.Append('\\', slashes);
      slashes = 0;
      sb.Append(c);
    }
    sb.Append('\\', slashes * 2);
    sb.Append('"');
    return sb.ToString();
  }
}
`;

let stub: Promise<Uint8Array> | undefined;

/** The Windows executable a script is appended to — compiled once per test
 *  process, in a directory that is removed again. */
function windowsStub(): Promise<Uint8Array> {
  return stub ??= (async () => {
    const dir = await tempDir("aio-fake-program-");
    try {
      const src = join(dir, "stub.cs");
      const out = join(dir, "stub.exe");
      await Deno.writeTextFile(src, STUB_CS);
      const p = await new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition " +
          "(Get-Content -Raw -LiteralPath $env:AIO_FAKE_SRC) -OutputAssembly " +
          "$env:AIO_FAKE_OUT -OutputType ConsoleApplication",
        ],
        env: { AIO_FAKE_SRC: src, AIO_FAKE_OUT: out },
        stdin: "null",
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!p.success) {
        throw new Error(
          "could not compile the fake program's Windows executable: " +
            new TextDecoder().decode(p.stderr),
        );
      }
      return await Deno.readFile(out);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  })();
}

/** The bytes of a program that runs the `#!/bin/sh` script `sh`: the script
 *  itself on Unix; on Windows a real executable carrying it. Byte-for-byte
 *  different for different scripts, the same for the same one. */
export async function programBytes(sh: string): Promise<Uint8Array> {
  const text = new TextEncoder().encode(WIN ? MARK + sh : sh);
  if (!WIN) return text;
  const exe = await windowsStub();
  const all = new Uint8Array(exe.length + text.length);
  all.set(exe);
  all.set(text, exe.length);
  return all;
}

/** Write {@linkcode programBytes} to `path`, executable. On Windows the name
 *  needs an extension — see {@linkcode EXE}. */
export async function writeProgram(path: string, sh: string): Promise<void> {
  await Deno.writeFile(path, await programBytes(sh));
  if (!WIN) await Deno.chmod(path, 0o755);
}

/** A program at `path` (given WITHOUT {@linkcode EXE}; the path it returns
 *  has it) whose body is `source` — JavaScript the real deno runs with the
 *  program's own arguments. For a stand-in the modelled shell above cannot
 *  express (a loop, a file test, a `case`): the same body runs on every OS. */
export async function writeDenoProgram(
  path: string,
  source: string,
): Promise<string> {
  // Windows: the program above is this script's PARENT (there is no `exec`
  // in place), and ending it does not end its children — so a body that
  // never returns ends itself once the program it stands in for is gone.
  const orphanWatch = WIN
    ? "Deno.unrefTimer(setInterval(() => { try { Deno.kill(Deno.ppid, 0); } " +
      "catch { Deno.exit(1); } }, 200));\n"
    : "";
  await Deno.writeTextFile(`${path}.js`, orphanWatch + source);
  await writeProgram(
    path + EXE,
    `#!/bin/sh\nexec "${Deno.execPath()}" run -A --no-config "${path}.js" "$@"\n`,
  );
  return path + EXE;
}
