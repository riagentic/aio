// `am lab windows|macos` — the MANUAL VM tier.
//
// Everything here runs without a VM, because everything shaped like a decision
// in am-cmd-lab.ts is a pure function: the docker argv, where the disk lives,
// what the preflight refuses and with which fix, how flags parse. The one test
// that actually boots Windows is behind AIO_VM_LAB=1 and is NOT part of
// `deno task test` — it costs tens of minutes and tens of gigabytes.
//
// The property that matters most here is the SHAPE OF A REFUSAL: a lab that
// cannot start must say the cause AND the exact command that fixes it. A raw
// `docker: Error response from daemon: …` is the failure mode this whole
// command exists to prevent, so the fix text is asserted, not just the error.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  adbBootArgv,
  adbInstallArgv,
  BOOT_DEADLINE_MS,
  BOOT_PROGRESS_MS,
  bootCompleted,
  bootTimeoutMessage,
  CONTAINER_SHARE_IP,
  diskDirs,
  fetchCommand,
  fileCost,
  freePort,
  gatewayArgv,
  handoffLines,
  human,
  imagePresentArgv,
  INSTALLED_MIN_BYTES,
  installVerdict,
  isInstalledDisk,
  isVmDisk,
  LAB_SPECS,
  labDirs,
  labRoot,
  lastGuestFetch,
  MACOS_LICENCE,
  MIN_GB,
  mountedShareArgv,
  NEED_GB,
  noticeStamp,
  parseDfAvailKb,
  parseIpv4,
  parseLabArgs,
  parseLabOs,
  phaseFromLogs,
  pickArtifact,
  preflight,
  rmArgv,
  runArgv,
  SHARE_HOST,
  SHARE_LOG,
  SHARE_PORT,
  SHARE_URL,
  shareLogArgv,
  shareProbeArgv,
  shareServeArgv,
  shareUrl,
  STOP_TIMEOUT_SEC,
  stopArgv,
  tunnelArgv,
  UNREACHABLE_FIX,
} from "../src/am/am-cmd-lab.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WIN = LAB_SPECS.windows;
const MAC = LAB_SPECS.macos;
const LIN = LAB_SPECS.linux;
const AND = LAB_SPECS.android;

const OK = {
  docker: "ok",
  kvm: "ok",
  tun: true,
  image: true,
  freeGb: 500,
} as const;

const opts = (over: Partial<Parameters<typeof runArgv>[0]> = {}) => ({
  spec: WIN,
  port: 45123,
  ram: "8G",
  cpus: 4,
  disk: "64G",
  version: "11",
  storage: "/labs/windows/storage",
  share: "/app/dist",
  tunnel: false,
  ...over,
});

// ── The argv ───────────────────────────────────────────────

Deno.test("runArgv: KVM, tun, NET_ADMIN and a graceful stop timeout", () => {
  const a = runArgv(opts());
  assert(a.includes("--device=/dev/kvm"), "no KVM = a 1/20th-speed emulator");
  assert(a.includes("--device=/dev/net/tun"), "no tun = no guest network");
  assertEquals(a[a.indexOf("--cap-add") + 1], "NET_ADMIN");
  // A guest killed mid-write comes back dirty — the timeout is the contract.
  assertEquals(a[a.indexOf("--stop-timeout") + 1], String(STOP_TIMEOUT_SEC));
  assertEquals(a[a.length - 1], WIN.image);
});

Deno.test("runArgv: the knobs reach the image under ITS names", () => {
  const a = runArgv(opts({ ram: "16G", cpus: 8, disk: "128G", version: "10" }));
  for (
    const e of ["VERSION=10", "RAM_SIZE=16G", "CPU_CORES=8", "DISK_SIZE=128G"]
  ) {
    assert(a.includes(e), `missing -e ${e} in: ${a.join(" ")}`);
  }
});

Deno.test("runArgv: the viewer is published on LOOPBACK only", () => {
  const a = runArgv(opts({ port: 45123 }));
  assertEquals(a[a.indexOf("-p") + 1], "127.0.0.1:45123:8006");
  // A manual-test VM has no viewer password. It must never face the LAN.
  assert(!a.some((x) => /^0\.0\.0\.0:|^:\d+:8006$/.test(x)));
});

Deno.test("runArgv: the port is never a constant — it is whatever it is told", () => {
  for (const p of [1024, 45123, 65535]) {
    assert(runArgv(opts({ port: p })).includes(`127.0.0.1:${p}:8006`));
  }
  // And nothing in the argv hardcodes the image's own 8006 as a HOST port.
  const a = runArgv(opts({ port: 45123 }));
  assert(!a.includes("127.0.0.1:8006:8006"));
});

Deno.test("freePort: asks the kernel, and does not repeat itself", () => {
  const seen = new Set([freePort(), freePort(), freePort()]);
  assert(seen.size >= 2, "freePort handed out one constant");
  for (const p of seen) assert(p > 0 && p < 65536);
});

Deno.test("runArgv --tunnel: publishes nothing — am owns the port", () => {
  const a = runArgv(opts({ tunnel: true, port: 45123 }));
  assert(!a.includes("-p"), "a tunnelled lab must not also publish a port");
  // Everything else is identical: the tunnel changes how the VIEWER is
  // served, never how the VM is run.
  assert(a.includes("--device=/dev/kvm") && a.includes("NET_ADMIN"));
  assert(a.includes("--device=/dev/net/tun"));
  // `--network host` is NOT the answer here: these images refuse it outright
  // ("ERROR: This container does not support host mode networking!" —
  // measured against dockurr/macos).
  assert(!a.includes("--network"));
});

Deno.test("tunnelArgv: one nc inside the image, per connection", () => {
  // `nc` ships in the image, so the tunnel needs no second image, no extra
  // capability, and nothing installed on the host.
  assertEquals(tunnelArgv("aio-lab-windows", WIN.viewerPort), [
    "exec",
    "-i",
    "aio-lab-windows",
    "nc",
    "127.0.0.1",
    "8006",
  ]);
});

Deno.test("runArgv: both volumes — the VM disk and the artifact hand-off", () => {
  const a = runArgv(opts({ storage: "/s", share: "/d" }));
  assert(a.includes("/s:/storage"), "VM disk not mounted");
  assert(a.includes("/d:/shared"), "dist/ not mounted — no artifact hand-off");
});

Deno.test("stop/rm/images argv", () => {
  assertEquals(stopArgv("c"), [
    "stop",
    "--time",
    String(STOP_TIMEOUT_SEC),
    "c",
  ]);
  assertEquals(rmArgv("c"), ["rm", "--force", "c"]);
  assertEquals(imagePresentArgv("i"), ["images", "--quiet", "i"]);
});

// ── Where the disk lives ───────────────────────────────────

Deno.test("labRoot: XDG_CACHE_HOME wins, ~/.cache/aio/labs otherwise", () => {
  assertEquals(
    labRoot({ XDG_CACHE_HOME: "/big", HOME: "/h" }),
    "/big/aio/labs",
  );
  assertEquals(labRoot({ HOME: "/h" }), "/h/.cache/aio/labs");
  assertEquals(
    labRoot({ XDG_CACHE_HOME: "", HOME: "/h" }),
    "/h/.cache/aio/labs",
  );
});

Deno.test("labDirs: one directory per OS, so --reset cannot cross them", () => {
  const env = { HOME: "/h" };
  assertEquals(labDirs("windows", env), {
    root: "/h/.cache/aio/labs/windows",
    storage: "/h/.cache/aio/labs/windows/storage",
  });
  assertEquals(labDirs("macos", env).root, "/h/.cache/aio/labs/macos");
});

// ── Preflight: cause AND fix, every time ───────────────────

Deno.test("preflight: a clean machine refuses nothing", () => {
  const v = preflight(WIN, OK);
  assertEquals(v.errors, []);
  assertEquals(v.warnings, []);
});

Deno.test("preflight: no docker names the install command", () => {
  const [e] = preflight(WIN, { ...OK, docker: "missing" }).errors;
  assertStringIncludes(e!, "not on PATH");
  assertStringIncludes(e!, "docker.io");
});

Deno.test("preflight: a refused docker socket is a GROUP problem, and says so", () => {
  const [e] = preflight(WIN, { ...OK, docker: "denied" }).errors;
  assertStringIncludes(e!, "usermod -aG docker");
  assertStringIncludes(e!, "newgrp docker");
});

Deno.test("preflight: a dead daemon names systemctl", () => {
  assertStringIncludes(
    preflight(WIN, { ...OK, docker: "down" }).errors[0]!,
    "systemctl start docker",
  );
});

Deno.test("preflight: missing /dev/kvm explains WHY it is fatal, not just that", () => {
  const [e] = preflight(WIN, { ...OK, kvm: "missing" }).errors;
  assertStringIncludes(e!, "/dev/kvm does not exist");
  assertStringIncludes(e!, "modprobe kvm_amd");
  assertStringIncludes(e!, "nested virtualisation");
});

Deno.test("preflight: an unreadable /dev/kvm is a PERMISSION fix, not a module one", () => {
  const [e] = preflight(WIN, { ...OK, kvm: "denied" }).errors;
  assertStringIncludes(e!, "setfacl -m u:$USER:rw /dev/kvm");
  assert(!e!.includes("modprobe kvm"), "wrong fix: it is present, just closed");
});

Deno.test("preflight: no /dev/net/tun names modprobe tun", () => {
  assertStringIncludes(
    preflight(WIN, { ...OK, tun: false }).errors[0]!,
    "modprobe tun",
  );
});

Deno.test("preflight: an unpulled image is refused, not pulled mid-start", () => {
  const [e] = preflight(WIN, { ...OK, image: false }).errors;
  assertStringIncludes(e!, "docker pull dockurr/windows");
  // The namespace typo costs a confused half hour: dockur/* does not exist.
  assertStringIncludes(e!, 'double r in "dockurr"');
});

Deno.test("preflight: disk — refuse below MIN, warn below NEED, silent above", () => {
  const tooSmall = preflight(WIN, { ...OK, freeGb: MIN_GB - 1 });
  assertEquals(tooSmall.warnings, []);
  assertStringIncludes(tooSmall.errors[0]!, "XDG_CACHE_HOME");
  assertStringIncludes(tooSmall.errors[0]!, "--reset");

  const tight = preflight(WIN, { ...OK, freeGb: NEED_GB - 1 });
  assertEquals(tight.errors, [], "a tight disk is a warning, not a refusal");
  assertStringIncludes(tight.warnings[0]!, `${NEED_GB} GB`);

  assertEquals(preflight(WIN, { ...OK, freeGb: NEED_GB }).warnings, []);
});

Deno.test("preflight: an unknown free space judges nothing", () => {
  assertEquals(preflight(WIN, { ...OK, freeGb: null }).errors, []);
  assertEquals(preflight(WIN, { ...OK, freeGb: null }).warnings, []);
});

Deno.test("preflight: every refusal carries a fix, not just a complaint", () => {
  const broken = {
    docker: "missing",
    kvm: "missing",
    tun: false,
    image: false,
    freeGb: 1,
  } as const;
  const { errors } = preflight(WIN, broken);
  assertEquals(errors.length, 5, "one refusal per broken fact");
  for (const e of errors) {
    assertStringIncludes(e, "Fix:", `no named fix in: ${e}`);
  }
});

Deno.test("parseDfAvailKb: the POSIX column, or null", () => {
  const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/mapper/x  2320000000 2210000000 113000000 96% /home`;
  assertEquals(parseDfAvailKb(df), 113000000);
  assertEquals(parseDfAvailKb(""), null);
  assertEquals(parseDfAvailKb("Filesystem only\n"), null);
});

// ── Flags ──────────────────────────────────────────────────

Deno.test("parseLabOs: the spellings people actually type", () => {
  assertEquals(parseLabOs("windows"), "windows");
  assertEquals(parseLabOs("win"), "windows");
  assertEquals(parseLabOs("macos"), "macos");
  assertEquals(parseLabOs("mac"), "macos");
  assertEquals(parseLabOs("osx"), "macos");
  assertEquals(parseLabOs("linux"), "linux");
  assertEquals(parseLabOs("ubuntu"), "linux");
  assertEquals(parseLabOs("android"), "android");
  assertEquals(parseLabOs("apk"), "android");
  assertEquals(parseLabOs("bsd"), null);
  assertEquals(parseLabOs(undefined), null);
});

Deno.test("parseLabArgs: defaults come from the spec", () => {
  const r = parseLabArgs(WIN, []);
  assert(r.ok);
  assertEquals(r.value.action, "start");
  assertEquals(r.value.ram, WIN.defaultRam);
  assertEquals(r.value.cpus, WIN.defaultCpus);
  assertEquals(r.value.version, WIN.defaultVersion);
  assertEquals(r.value.dist, null);
  assertEquals(r.value.tunnel, false);
});

Deno.test("parseLabArgs: the four actions", () => {
  for (
    const [flag, action] of [
      ["--stop", "stop"],
      ["--status", "status"],
      ["--reset", "reset"],
    ] as const
  ) {
    const r = parseLabArgs(WIN, [flag]);
    assert(r.ok);
    assertEquals(r.value.action, action);
  }
});

Deno.test("parseLabArgs: an unknown flag is an ERROR that lists the real ones", () => {
  // A silently dropped --ram=32G means an operator debugging a slow guest is
  // staring at a flag that never arrived.
  const r = parseLabArgs(WIN, ["--memory=32G"]);
  assert(!r.ok);
  assertStringIncludes(r.error, "--memory=32G");
  assertStringIncludes(r.error, "--ram=8G");
  assertStringIncludes(r.error, "--tunnel");
});

Deno.test("parseLabArgs: sizes must be sizes, cores must be cores", () => {
  for (const bad of ["--ram=8", "--ram=eight", "--disk=64GB", "--ram=8g"]) {
    const r = parseLabArgs(WIN, [bad]);
    assert(!r.ok, `${bad} was accepted`);
    assertStringIncludes(r.error, "8G");
  }
  for (const bad of ["--cpus=0", "--cpus=2.5", "--cpus=x"]) {
    const r = parseLabArgs(WIN, [bad]);
    assert(!r.ok, `${bad} was accepted`);
    assertStringIncludes(r.error, "--cpus");
  }
  assert(parseLabArgs(WIN, ["--ram=512M", "--disk=128G", "--cpus=16"]).ok);
});

// ── Honesty pins ───────────────────────────────────────────

Deno.test("the guest MOUNT is named for Windows and REFUSED for macOS", () => {
  // Windows: a real SMB path the operator can paste into Explorer.
  assertEquals(WIN.guestShare, "\\\\host.lan\\Data");
  // macOS: the image exports /shared over virtio-9p and ships no smbd; macOS
  // has a client for neither. Naming a path here would be a lie discovered
  // inside the VM — so there is none, and the note says why.
  assertEquals(MAC.guestShare, null);
  assertStringIncludes(MAC.shareNote, "9p");
  assertStringIncludes(MAC.shareNote, "smbd");
  // …and the hand-off that DOES work is named instead, in both labs.
  assertStringIncludes(MAC.shareNote, SHARE_HOST);
});

Deno.test("first-run text tells the truth about the wait, per OS", () => {
  assertStringIncludes(WIN.firstRun, "UNATTENDED");
  assertStringIncludes(WIN.firstRun, "30 min total");
  // macOS is the one a person has to sit through. Never imply otherwise.
  assertStringIncludes(MAC.firstRun, "NOT unattended");
});

Deno.test("the unreachable-viewer diagnosis is a diagnosis, with a fix", () => {
  // "connect succeeds, no bytes" reads exactly like "still booting" and has a
  // completely different cause: docker's published ports blocked between the
  // host and its own bridge. Measured on the machine this was built on.
  assertStringIncludes(UNREACHABLE_FIX, "INSIDE the container");
  assertStringIncludes(UNREACHABLE_FIX, "--tunnel");
  // …and it must send the operator at the HOST first: the workaround is a
  // workaround, the docker networking is the actual fault.
  assertStringIncludes(UNREACHABLE_FIX, "DOCKER-USER");
});

Deno.test("phaseFromLogs: the last real line, without the colour codes", () => {
  const logs =
    "\x1B[1;34m❯ \x1B[1;36mRequesting Windows 11...\x1B[0m\n\x1B[1;34m❯ Downloading Windows 11...\x1B[0m\n\n";
  assertEquals(phaseFromLogs(logs), "Downloading Windows 11...");
  assertEquals(phaseFromLogs(""), "");
});

Deno.test("fileCost: a SPARSE VM disk costs its blocks, not its size", () => {
  // data.img reports 64 GB the moment it is created and occupies a few. A
  // status line quoting the apparent size tells an operator with 100 GB free
  // that they are out of room.
  assertEquals(
    fileCost({ size: 68719476736, blocks: 6 * 1024 * 1024 * 2 }),
    6 * 1024 ** 3,
  );
  // No block count (a platform that does not report one): apparent size.
  assertEquals(fileCost({ size: 1234, blocks: null }), 1234);
});

Deno.test("isVmDisk: the installed disk, not the in-flight installer", () => {
  // "is this lab already installed?" decides whether the operator is told
  // "10-20 min" or "a minute" — a half-downloaded ISO must not count.
  for (const n of ["data.img", "data.raw", "data.qcow2"]) assert(isVmDisk(n));
  for (const n of ["win11x64.iso", "data.img.aria2", "tmp", "data2.img"]) {
    assert(!isVmDisk(n), `${n} counted as an installed disk`);
  }
});

Deno.test("human: bytes an operator can read", () => {
  assertEquals(human(0), "0 B");
  assertEquals(human(1024), "1.0 KB");
  assertEquals(human(34 * 1024 ** 3), "34 GB");
});

Deno.test("am lab is discoverable in `am help`", async () => {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}/src/am.ts`, "help"],
    stdout: "piped",
    stderr: "null",
    env: { ...Deno.env.toObject(), AIO_AM_NO_DELEGATE: "1" },
  }).output();
  const help = new TextDecoder().decode(p.stdout);
  assertStringIncludes(help, "lab windows");
  assertStringIncludes(help, "lab macos");
  assertStringIncludes(help, "lab linux");
  assertStringIncludes(help, "lab android");
  assertStringIncludes(help, "docs/testing/vm-labs.md");
});

// ── The artifact hand-off ──────────────────────────────────
//
// The half a VM lab lives or dies on: a guest you cannot put your build into
// is a screenshot of an operating system. Windows had a share and macOS had a
// paragraph of prose; now both have ONE mechanism, one URL and one command.
//
// The mechanism is a file server INSIDE the lab container, bound to the
// guest-facing bridge, serving the directory the lab already bind-mounts.
// Verified against real guests (a Windows 11 desktop and a macOS Sonoma one):
// `curl http://host.lan:8007/<file>` typed in the guest returns the bytes of
// the host's dist/<file>. Everything below is the pure part of that.

Deno.test("the share is ONE url, identical in both labs", () => {
  // A person who has run `am lab windows` must not have to learn a second
  // vocabulary for macOS. Same host name, same port, same URL.
  assertEquals(SHARE_URL, `http://${SHARE_HOST}:${SHARE_PORT}/`);
  assertEquals(SHARE_HOST, "host.lan");
  for (const spec of [WIN, MAC]) {
    const lines = handoffLines(spec, "/app/dist", {
      kind: "one",
      file: spec.os === "windows" ? "app-windows.exe" : "app-macos",
    });
    assertStringIncludes(lines[0]!, SHARE_URL);
  }
});

Deno.test("the share is NEVER published to the host", () => {
  // The host already HAS the directory; the only client is the guest. A
  // published 8007 would be one more unauthenticated port on the machine.
  const a = runArgv(opts());
  assert(!a.some((x) => x.includes(String(SHARE_PORT))), a.join(" "));
});

Deno.test("gatewayArgv reads the IMAGE's own record of the gateway", () => {
  // /run/shm/qemu.gw is written by the image's configureDNS() in every network
  // mode, and is the same address its dnsmasq answers `host.lan` with. Deriving
  // a subnet ourselves would be a second decider for one fact.
  assertEquals(gatewayArgv("c"), ["exec", "c", "cat", "/run/shm/qemu.gw"]);
});

Deno.test("parseIpv4: an address, or null — never a half-parsed one", () => {
  assertEquals(parseIpv4("172.30.0.1\n"), "172.30.0.1");
  assertEquals(parseIpv4(" 20.20.20.1 \nnoise\n"), "20.20.20.1");
  assertEquals(parseIpv4(""), null);
  assertEquals(parseIpv4("cat: no such file"), null);
  assertEquals(parseIpv4("172.30.0"), null);
  assertEquals(parseIpv4("172.30.0.256"), null);
});

Deno.test("shareServeArgv: bound to the GUEST's address, not 0.0.0.0", () => {
  const a = shareServeArgv("aio-lab-macos", "172.30.0.1");
  assertEquals(a[0], "exec");
  assert(a.includes("--detach"), "the share must outlive this am process");
  const cmd = a[a.length - 1]!;
  assertStringIncludes(cmd, `--bind 172.30.0.1`);
  assertStringIncludes(cmd, `--directory /shared`);
  assertStringIncludes(cmd, String(SHARE_PORT));
  // 0.0.0.0 inside the container would also expose dist/ to every other
  // container on the docker network. The bridge address is guest-only.
  assert(!cmd.includes("0.0.0.0"), cmd);
  // Logged, because "has the guest actually fetched it?" is otherwise
  // indistinguishable from "nobody has typed the command yet".
  assertStringIncludes(cmd, SHARE_LOG);
});

Deno.test("shareProbeArgv asks from INSIDE — nothing is published to ask from", () => {
  const a = shareProbeArgv("c", "172.30.0.1");
  assertEquals(a[0], "exec");
  assert(a.includes(`http://172.30.0.1:${SHARE_PORT}/`), a.join(" "));
  assert(a.includes("%{http_code}"));
  // Deep enough to see past our own probes: every `am lab` invocation writes
  // one or two, and a three-line window buried the guest fetch that is the
  // only proof the hand-off works.
  const log = shareLogArgv("c");
  assertEquals(log[0], "exec");
  assert(Number(log[log.indexOf("tail") + 1]!.replace("-", "")) >= 100);
});

Deno.test("lastGuestFetch: our own health probes are not a guest fetch", () => {
  // The probes come from the gateway address itself. Counting them would let
  // `--status` report a working hand-off on a guest that cannot resolve
  // host.lan at all — the exact failure this line exists to surface.
  const log = [
    '172.30.0.1 - - [27/Aug/2026 01:45:57] "GET / HTTP/1.1" 200 -',
    '172.30.0.2 - - [27/Aug/2026 01:42:19] "GET /demo-macos HTTP/1.1" 200 -',
    '172.30.0.1 - - [27/Aug/2026 01:45:58] "GET / HTTP/1.1" 200 -',
  ].join("\n");
  assertStringIncludes(lastGuestFetch(log, "172.30.0.1")!, "demo-macos");
  // A log with nothing but our own probes in it is NO guest fetch.
  const probesOnly = log.split("\n").filter((l) => l.startsWith("172.30.0.1"));
  assertEquals(lastGuestFetch(probesOnly.join("\n"), "172.30.0.1"), null);
  assertEquals(lastGuestFetch("", "172.30.0.1"), null);
  // A 404 is not a hand-off either.
  assertEquals(
    lastGuestFetch('172.30.0.2 - - [x] "GET /nope HTTP/1.1" 404 -', "1.2.3.4"),
    null,
  );
});

Deno.test("pickArtifact: the file the GUEST can run, per OS", () => {
  assertEquals(pickArtifact("windows", ["app-windows.exe", "app", "app.txt"]), {
    kind: "one",
    file: "app-windows.exe",
  });
  assertEquals(pickArtifact("macos", ["app-macos", "app-windows.exe", "app"]), {
    kind: "one",
    file: "app-macos",
  });
  assertEquals(pickArtifact("macos", ["App.dmg"]), {
    kind: "one",
    file: "App.dmg",
  });
  assertEquals(pickArtifact("macos", []), { kind: "none" });
  assertEquals(pickArtifact("windows", ["app-macos"]), { kind: "none" });
});

Deno.test("pickArtifact: an Apple Silicon build in an x86_64 lab is NAMED", () => {
  // Both lab guests are QEMU x86_64. Handing someone a fetch command for an
  // arm64 Mach-O — 40 minutes after they started installing an OS to try it —
  // ends in "Bad CPU type in executable" and no explanation.
  const r = pickArtifact("macos", ["app-macos-arm64", "app-linux"]);
  assertEquals(r, { kind: "wrong-arch", files: ["app-macos-arm64"] });
  // …and the Intel one wins outright when both are present.
  assertEquals(pickArtifact("macos", ["app-macos-arm64", "app-macos"]), {
    kind: "one",
    file: "app-macos",
  });
});

Deno.test("pickArtifact: ambiguity is reported, never guessed silently", () => {
  const r = pickArtifact("windows", ["a-windows.exe", "b-windows.exe"]);
  assertEquals(r.kind, "many");
  assertEquals((r as { files: string[] }).files, [
    "a-windows.exe",
    "b-windows.exe",
  ]);
});

Deno.test("fetchCommand: the guest's OWN shell, not a shell it does not have", () => {
  const w = fetchCommand("windows", "app-windows.exe");
  // PowerShell aliases `curl` to Invoke-WebRequest, which has no -O: a plain
  // `curl -O` there fails with a parameter error, not a download.
  assertStringIncludes(w, "curl.exe -fLO");
  assert(!/(^|[^.])curl -/.test(w), w);
  assertStringIncludes(w, SHARE_URL + "app-windows.exe");

  const m = fetchCommand("macos", "app-macos");
  assertStringIncludes(m, "curl -fLO");
  // A downloaded Mach-O without +x is a permission error, not a test.
  assertStringIncludes(m, "chmod +x app-macos");
  assertStringIncludes(m, SHARE_URL + "app-macos");
});

Deno.test("handoffLines: a COMMAND to paste, never a paragraph to interpret", () => {
  for (const spec of [WIN, MAC]) {
    const file = spec.os === "windows" ? "app-windows.exe" : "app-macos";
    const lines = handoffLines(spec, "/app/dist", { kind: "one", file });
    assert(
      lines.some((l) => l.includes(fetchCommand(spec.os, file))),
      `${spec.os}: no pasteable command in ${lines.join(" | ")}`,
    );
    assert(
      lines.some((l) => l.includes(spec.guestShell)),
      `${spec.os}: the operator is not told WHERE to paste it`,
    );
  }
});

Deno.test("handoffLines: an empty dist/ says what to build, not 'no files'", () => {
  const lines = handoffLines(MAC, "/app/dist", { kind: "none" }).join(" ");
  assertStringIncludes(lines, "--platforms=macos");
  // …and that a rebuild needs no lab restart, because the mount is live.
  assertStringIncludes(lines, "live");
});

Deno.test("handoffLines: wrong-arch names the build that would fix it", () => {
  const lines = handoffLines(MAC, "/app/dist", {
    kind: "wrong-arch",
    files: ["app-macos-arm64"],
  }).join(" ");
  assertStringIncludes(lines, "x86_64");
  assertStringIncludes(lines, "--platforms=macos");
  // No fetch command: there is nothing worth fetching.
  assert(!lines.includes("curl -fLO"), lines);
});

Deno.test("handoffLines: macOS is told curl DODGES Gatekeeper", () => {
  // curl does not set com.apple.quarantine; Safari does. That is a different
  // thing being tested, and a person testing "what my users see" has to know.
  const mac = handoffLines(MAC, "/d", { kind: "one", file: "a-macos" }).join(
    " ",
  );
  assertStringIncludes(mac, "quarantine");
  assertStringIncludes(mac, "Safari");
  // Windows keeps its extra SMB mount; macOS has none to mention.
  const win = handoffLines(WIN, "/d", { kind: "one", file: "a.exe" }).join(" ");
  assertStringIncludes(win, "host.lan\\Data");
  assert(!mac.includes("\\\\host.lan"), mac);
});

Deno.test("mountedShareArgv reads the LIVE mount back, not what was asked for", () => {
  // A bind mount is fixed at `docker run`: `--dist=` against a running lab
  // changes nothing, and must not look like it did.
  const a = mountedShareArgv("c");
  assertEquals(a[0], "inspect");
  assertStringIncludes(a[a.length - 1]!, "/shared");
});

// ── macOS: licence, versions, and a disk that is not an install ──

Deno.test("the macOS licence notice is ONE line and names the restriction", () => {
  assertEquals(MACOS_LICENCE.includes("\n"), false, "one line, not a lecture");
  assertStringIncludes(MACOS_LICENCE, "Apple");
  assertStringIncludes(MACOS_LICENCE, "hardware");
  // It must not read as a blessing for CI.
  assertStringIncludes(MACOS_LICENCE, "CI");
  // Shown once per lab: the stamp lives under the lab root, so --reset (which
  // throws the OS away) shows it again.
  assertEquals(
    noticeStamp("/h/.cache/aio/labs/macos"),
    "/h/.cache/aio/labs/macos/licence-notice-shown",
  );
});

Deno.test("diskDirs: macOS keeps one disk per VERSION, Windows one disk", () => {
  // The macOS image sets STORAGE=$STORAGE/<version> for a fresh install, so
  // looking only at the top level told every returning operator "first run".
  assertEquals(diskDirs(MAC, "/s", "14"), ["/s", "/s/14"]);
  assertEquals(diskDirs(MAC, "/s", "Sonoma"), ["/s", "/s/sonoma"]);
  assertEquals(diskDirs(WIN, "/s", "11"), ["/s"]);
});

Deno.test("isInstalledDisk: a 64 GB hole in the filesystem is not an OS", () => {
  // Measured: QEMU creates data.img at its full nominal size and allocates
  // ZERO blocks until something is written; an installed Windows 11 allocates
  // 15 GB. Existence is not installation, and on macOS — where the install is
  // manual and interruptible — the difference is an hour of somebody's day.
  assertEquals(isInstalledDisk("data.img", 0), false);
  assertEquals(isInstalledDisk("data.img", INSTALLED_MIN_BYTES - 1), false);
  assertEquals(isInstalledDisk("data.img", 15 * 1024 ** 3), true);
  // Still only the disk, never the installer media beside it.
  assertEquals(isInstalledDisk("base.dmg", 15 * 1024 ** 3), false);
  assert(isVmDisk("data.img"));
});

// ── linux + android: an OS is a ROW, not a branch ──────────
//
// The two container labs share every mechanism with the two VMs — the same
// flags, the same viewer/share/status grammar — and differ only in fields of
// LAB_SPECS. These pin the fields that matter and the two hand-offs.

Deno.test("LAB_SPECS: every lab is a row with the same shape, and the kinds are honest", () => {
  assertEquals(
    Object.keys(LAB_SPECS).length,
    4,
    "four labs: windows, macos, linux, android",
  );
  for (const spec of Object.values(LAB_SPECS)) {
    assertEquals(spec.container, `aio-lab-${spec.os}`);
    assert(spec.viewerPort > 0);
    // aio-ok: the hint is prose; what matters is that it names a `deno task build` a person can run
    assert(
      spec.buildHint.includes("deno task build"),
      `${spec.os}: the build hint names the command`,
    );
    // A container installs nothing, so it can neither keep a disk per version
    // nor need a 9p/DHCP guest network.
    if (spec.kind === "container") {
      assertEquals(spec.versionedStorage, false);
      assertEquals(spec.needsTun, false);
    }
  }
  assertEquals(WIN.kind, "vm");
  assertEquals(MAC.kind, "vm");
  assertEquals(LIN.kind, "container");
  assertEquals(AND.kind, "container");
  // The emulator is KVM-accelerated; a desktop in a container is not a VM.
  assertEquals(LIN.needsKvm, false);
  assertEquals(AND.needsKvm, true);
  assertEquals(WIN.viewerPort, 8006);
  assertEquals(MAC.viewerPort, 8006);
  assertEquals(LIN.viewerPort, 3000);
  assertEquals(AND.viewerPort, 6080);
});

Deno.test("runArgv linux: no KVM, no tun — FUSE, shm, the desktop port, the host user", () => {
  const a = runArgv(
    opts({ spec: LIN, port: 45123, owner: { uid: 1000, gid: 1000 } }),
  );
  assert(!a.includes("--device=/dev/kvm"), "a webtop is not a VM");
  assert(!a.includes("--device=/dev/net/tun") && !a.includes("NET_ADMIN"));
  // AppImages mount themselves through FUSE: the device, SYS_ADMIN and an
  // unconfined AppArmor profile are what fusermount needs in a container.
  for (
    const x of [
      "--shm-size=1g",
      "--device=/dev/fuse",
      "--cap-add=SYS_ADMIN",
      "--security-opt=apparmor:unconfined",
    ]
  ) assert(a.includes(x), `missing ${x} in: ${a.join(" ")}`);
  assertEquals(a[a.indexOf("-p") + 1], "127.0.0.1:45123:3000");
  // PUID/PGID: what the desktop writes into /shared is the operator's own.
  assert(a.includes("PUID=1000") && a.includes("PGID=1000"), a.join(" "));
  assert(a.includes("TITLE=aio lab"));
  // No VM knobs and no VM disk reach a container.
  assert(!a.some((x) => /^(VERSION|RAM_SIZE|CPU_CORES|DISK_SIZE)=/.test(x)));
  assert(!a.includes("/labs/windows/storage:/storage"));
  assert(a.includes("/app/dist:/shared"), "dist/ not mounted");
  assertEquals(a[a.length - 1], LIN.image);
});

Deno.test("runArgv linux: no host uid (a Windows host) → the image's default user, no lie", () => {
  const a = runArgv(opts({ spec: LIN, owner: null }));
  assert(!a.some((x) => x.startsWith("PUID=")), a.join(" "));
});

Deno.test("runArgv android: KVM (once), 2g shm, the noVNC port, the emulator env", () => {
  const a = runArgv(opts({ spec: AND, port: 45123 }));
  assertEquals(
    a.filter((x) => x === "--device=/dev/kvm").length,
    1,
    "KVM once — the spec's runExtra names it and needsKvm does too",
  );
  assert(!a.includes("--device=/dev/net/tun"));
  assert(a.includes("--shm-size=2g"));
  assertEquals(a[a.indexOf("-p") + 1], "127.0.0.1:45123:6080");
  assert(a.includes("EMULATOR_DEVICE=Samsung Galaxy S10"), a.join(" "));
  assert(a.includes("WEB_VNC=true"));
  assert(!a.some((x) => x.startsWith("PUID=")));
  assert(!a.includes("/storage") && !a.some((x) => x.endsWith(":/storage")));
  assertEquals(a[a.length - 1], AND.image);
});

Deno.test("runArgv: windows/macos are byte-identical to before the table grew", () => {
  // The refactor moved every branch onto a field; the VM argv must not move.
  assertEquals(runArgv(opts()), [
    "run",
    "--detach",
    "--name",
    "aio-lab-windows",
    "--device=/dev/kvm",
    "--device=/dev/net/tun",
    "--cap-add",
    "NET_ADMIN",
    "--stop-timeout",
    String(STOP_TIMEOUT_SEC),
    "-e",
    "VERSION=11",
    "-e",
    "RAM_SIZE=8G",
    "-e",
    "CPU_CORES=4",
    "-e",
    "DISK_SIZE=64G",
    "-p",
    "127.0.0.1:45123:8006",
    "-v",
    "/labs/windows/storage:/storage",
    "-v",
    "/app/dist:/shared",
    WIN.image,
  ]);
});

Deno.test("tunnelArgv follows the spec's viewer port", () => {
  assertEquals(tunnelArgv("c", LIN.viewerPort).at(-1), "3000");
  assertEquals(tunnelArgv("c", AND.viewerPort).at(-1), "6080");
});

Deno.test("preflight linux: a container needs docker and the image, nothing else", () => {
  // No KVM, no tun, 3 GB free: a VM would refuse three times; a webtop runs.
  const v = preflight(LIN, { ...OK, kvm: "missing", tun: false, freeGb: 3 });
  assertEquals(v.errors, []);
  assertEquals(v.warnings, []);
  const [e] = preflight(LIN, { ...OK, image: false }).errors;
  assertStringIncludes(e!, `docker pull ${LIN.image}`);
  // The dockurr typo note is for dockurr images only.
  assert(!e!.includes("dockurr"), e);
  assertStringIncludes(
    preflight(LIN, { ...OK, docker: "missing" }).errors[0]!,
    "Fix:",
  );
});

Deno.test("preflight android: refuses without KVM — the emulator is KVM-accelerated", () => {
  const [e] = preflight(AND, { ...OK, kvm: "missing", tun: false }).errors;
  assertStringIncludes(e!, "/dev/kvm does not exist");
  assertStringIncludes(e!, "emulator");
  assertStringIncludes(e!, "modprobe kvm_amd");
  assertEquals(
    preflight(AND, { ...OK, kvm: "missing", tun: false }).errors.length,
    1,
  );
  assertStringIncludes(
    preflight(AND, { ...OK, kvm: "denied" }).errors[0]!,
    "setfacl",
  );
  // No tun, no disk floor for the emulator either.
  assertEquals(preflight(AND, { ...OK, tun: false, freeGb: 1 }).errors, []);
});

Deno.test("diskDirs: a container has no disk to look for", () => {
  assertEquals(diskDirs(LIN, "/s", ""), []);
  assertEquals(diskDirs(AND, "/s", ""), []);
});

Deno.test("parseLabArgs: VM knobs on a container lab are REFUSED, not ignored", () => {
  for (const bad of ["--ram=16G", "--cpus=8", "--disk=1G", "--version=22.04"]) {
    const r = parseLabArgs(LIN, [bad]);
    assert(!r.ok, `${bad} was silently accepted by a container lab`);
    assertStringIncludes(r.error, "container, not a VM");
    assertStringIncludes(r.error, bad);
  }
  // …while the shared flags work the same.
  const r = parseLabArgs(LIN, ["--dist=out", "--tunnel", "--status"]);
  assert(r.ok);
  assertEquals(r.value.dist, "out");
  assertEquals(r.value.tunnel, true);
  assertEquals(r.value.action, "status");
});

Deno.test("parseLabArgs: --apk is android's, and names a file not a path", () => {
  const r = parseLabArgs(AND, ["--apk=app-client.apk"]);
  assert(r.ok);
  assertEquals(r.value.apk, "app-client.apk");
  assert(!parseLabArgs(AND, ["--apk=dist/app.apk"]).ok);
  assert(!parseLabArgs(AND, ["--apk="]).ok);
  const lin = parseLabArgs(LIN, ["--apk=x.apk"]);
  assert(!lin.ok, "--apk on a lab that installs nothing must be refused");
  assert(!parseLabArgs(WIN, ["--apk=x.apk"]).ok);
  const win = parseLabArgs(WIN, []);
  assert(win.ok);
  assertEquals(win.value.apk, null);
});

Deno.test("pickArtifact linux: an AppImage over the bare binary, arm64 is wrong-arch", () => {
  assertEquals(pickArtifact("linux", ["app-x64.AppImage", "app", "app.txt"]), {
    kind: "one",
    file: "app-x64.AppImage",
  });
  // The bare host-platform name (`artifactName` keeps it bare on the host)…
  assertEquals(pickArtifact("linux", ["app", "app-windows.exe", "app-macos"]), {
    kind: "one",
    file: "app",
  });
  // …and the cross-built one.
  assertEquals(pickArtifact("linux", ["app-linux"]), {
    kind: "one",
    file: "app-linux",
  });
  assertEquals(
    pickArtifact("linux", ["app-linux-arm64", "app-arm64.AppImage"]),
    {
      kind: "wrong-arch",
      files: ["app-arm64.AppImage", "app-linux-arm64"],
    },
  );
  assertEquals(pickArtifact("linux", ["app-linux-arm64", "app-linux"]), {
    kind: "one",
    file: "app-linux",
  });
  assertEquals(pickArtifact("linux", ["app-windows.exe", "notes.md"]), {
    kind: "none",
  });
});

Deno.test("pickArtifact android: the client APK is preferred and the choice is VISIBLE", () => {
  assertEquals(pickArtifact("android", ["app.apk", "app-windows.exe"]), {
    kind: "one",
    file: "app.apk",
  });
  // App + client: the client wins, the app is named as the other option.
  assertEquals(pickArtifact("android", ["app.apk", "app-client.apk"]), {
    kind: "one",
    file: "app-client.apk",
    others: ["app.apk"],
  });
  // --apk picks; a name that is not there is 'absent', never a silent fallback.
  assertEquals(
    pickArtifact("android", ["app.apk", "app-client.apk"], "app.apk"),
    {
      kind: "one",
      file: "app.apk",
    },
  );
  assertEquals(pickArtifact("android", ["app.apk"], "nope.apk"), {
    kind: "absent",
    file: "nope.apk",
    files: ["app.apk"],
  });
  // An unsigned APK cannot be installed: not a candidate.
  assertEquals(pickArtifact("android", ["app-unsigned.apk"]), { kind: "none" });
  assertEquals(pickArtifact("android", ["a.apk", "b.apk"]).kind, "many");
});

Deno.test("fetchCommand linux: a COPY out of /shared, +x, run — no download", () => {
  const c = fetchCommand("linux", "app-x64.AppImage");
  assertEquals(
    c,
    "cp /shared/app-x64.AppImage ~/ && chmod +x ~/app-x64.AppImage && ~/app-x64.AppImage",
  );
  assert(!c.includes("curl"), "the directory is local in this guest");
});

Deno.test("shareUrl: one port, the name THIS guest resolves", () => {
  assertEquals(shareUrl(WIN), SHARE_URL);
  assertEquals(shareUrl(MAC), SHARE_URL);
  assertEquals(shareUrl(LIN), `http://localhost:${SHARE_PORT}/`);
  // 10.0.2.2 is the emulator's fixed alias for its host's loopback.
  assertEquals(shareUrl(AND), `http://10.0.2.2:${SHARE_PORT}/`);
  assertEquals(CONTAINER_SHARE_IP, "127.0.0.1");
});

Deno.test("handoffLines linux: the cp line, where to paste it, and the /shared note", () => {
  const lines = handoffLines(LIN, "/app/dist", {
    kind: "one",
    file: "app-x64.AppImage",
  });
  assertStringIncludes(lines[0]!, shareUrl(LIN));
  assert(
    lines.some((l) => l.includes(fetchCommand("linux", "app-x64.AppImage"))),
  );
  assert(lines.some((l) => l.includes(LIN.guestShell)));
  const all = lines.join(" ");
  assertStringIncludes(all, "/shared");
  assert(!all.includes("quarantine"), "the Gatekeeper line is macOS's");
  // arm64 → the build that fixes it, and no cp line.
  const wrong = handoffLines(LIN, "/d", {
    kind: "wrong-arch",
    files: ["app-linux-arm64"],
  }).join(" ");
  assertStringIncludes(wrong, "x86_64");
  assertStringIncludes(wrong, "--platforms=linux");
  assert(!wrong.includes("cp /shared"), wrong);
  assertStringIncludes(
    handoffLines(LIN, "/d", { kind: "none" }).join(" "),
    "--platforms=linux",
  );
});

Deno.test("handoffLines android: am INSTALLS — the adb line is what it ran, not homework", () => {
  const lines = handoffLines(AND, "/app/dist", {
    kind: "one",
    file: "app-client.apk",
    others: ["app.apk"],
  });
  const all = lines.join(" ");
  assertStringIncludes(all, "am installs it for you");
  assertStringIncludes(
    all,
    `docker exec ${AND.container} adb install -r /shared/app-client.apk`,
  );
  // Which was chosen and how to get the other.
  assertStringIncludes(all, "chose app-client.apk");
  assertStringIncludes(all, "--apk=app.apk");
  assert(!all.includes("paste"), all);
  // Several: no guess, a flag.
  const many = handoffLines(AND, "/d", {
    kind: "many",
    files: ["a.apk", "b.apk"],
  }).join(" ");
  assertStringIncludes(many, "--apk=a.apk");
  assert(!many.includes("adb install"), many);
  // A --apk that is not there says what IS.
  const absent = handoffLines(AND, "/d", {
    kind: "absent",
    file: "x.apk",
    files: ["a.apk"],
  }).join(" ");
  assertStringIncludes(absent, "--apk=x.apk is not in that directory");
  assertStringIncludes(absent, "a.apk");
  assertStringIncludes(
    handoffLines(AND, "/d", { kind: "none" }).join(" "),
    "--targets=android-client",
  );
});

Deno.test("adb: the boot poll, the install, and what their answers mean", () => {
  assertEquals(adbBootArgv("aio-lab-android"), [
    "exec",
    "aio-lab-android",
    "adb",
    "shell",
    "getprop",
    "sys.boot_completed",
  ]);
  assertEquals(bootCompleted("1\n"), true);
  assertEquals(bootCompleted("1\r\n"), true);
  // Early in the boot getprop answers nothing; adb may print an error with
  // the same exit code. Neither is 'booted'.
  assertEquals(bootCompleted(""), false);
  assertEquals(bootCompleted("0"), false);
  assertEquals(bootCompleted("error: device offline"), false);
  assertEquals(bootCompleted("11"), false);
  // -r: replace — re-running `am lab android` after a rebuild IS the dev loop.
  assertEquals(adbInstallArgv("c", "app.apk"), [
    "exec",
    "c",
    "adb",
    "install",
    "-r",
    "/shared/app.apk",
  ]);
  // Bounded, with progress: ~5 min, a line every 15 s.
  assertEquals(BOOT_DEADLINE_MS, 300_000);
  assertEquals(BOOT_PROGRESS_MS, 15_000);
});

Deno.test("installVerdict: Success is success; every failure names its fix", () => {
  const ok = installVerdict({
    code: 0,
    out: "Performing Streamed Install\nSuccess\n",
    err: "",
  }, "a.apk");
  assertEquals(ok.ok, true);
  assertStringIncludes(ok.message, "a.apk");
  // Exit 0 without Success is NOT success (adb has done that).
  assertEquals(
    installVerdict({ code: 0, out: "", err: "" }, "a.apk").ok,
    false,
  );
  const abi = installVerdict(
    {
      code: 1,
      out: "",
      err:
        "adb: failed to install /shared/a.apk: Failure [INSTALL_FAILED_NO_MATCHING_ABIS]",
    },
    "a.apk",
  );
  assertEquals(abi.ok, false);
  assertStringIncludes(abi.message, "x86_64");
  assertStringIncludes(abi.message, "INSTALL_FAILED_NO_MATCHING_ABIS");
  const unsigned = installVerdict(
    { code: 1, out: "", err: "Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES]" },
    "a-unsigned.apk",
  );
  assertStringIncludes(unsigned.message, "unsigned");
  const gone = installVerdict({
    code: 1,
    out: "",
    err: "adb: no devices/emulators found",
  }, "a.apk");
  assertStringIncludes(gone.message, "--status");
});

Deno.test("bootTimeoutMessage: names how to check, how to watch, and the restart", () => {
  const m = bootTimeoutMessage(AND, "");
  assertStringIncludes(m, "5 min");
  assertStringIncludes(m, "am lab android --status");
  assertStringIncludes(m, `docker logs -f ${AND.container}`);
  assertStringIncludes(m, "--stop");
  assertStringIncludes(bootTimeoutMessage(AND, "0"), "last answer: 0");
});

// ── The CLI, against a FAKE docker on PATH ─────────────────

/** A `docker` shim that answers from a script the test writes. */
async function fakeDocker(body: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-lab-fake-" });
  const bin = `${dir}/docker`;
  await Deno.writeTextFile(bin, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(bin, 0o755);
  return dir;
}

async function am(args: string[], env: Record<string, string>) {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}/src/am.ts`, ...args],
    env: {
      ...Deno.env.toObject(),
      AIO_AM_NO_DELEGATE: "1",
      ...env,
    },
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("am lab (no OS) prints the usage and fails", async () => {
  const r = await am(["lab"], {});
  assertEquals(r.code, 1);
  // The usage goes to stderr so it never pollutes --json stdout; the error
  // itself follows am's rule and lands on stdout in machine-readable mode.
  assertStringIncludes(r.err, "am lab <windows|macos|linux|android>");
  assertStringIncludes(r.out + r.err, "needs an OS");
});

Deno.test("am lab bsd: an unknown OS names the two that exist", async () => {
  const r = await am(["lab", "bsd"], {});
  assertEquals(r.code, 1);
  assertStringIncludes(r.out + r.err, "bsd"); // quoted in the message
  assertStringIncludes(r.out + r.err, "am lab windows");
  assertStringIncludes(r.out + r.err, "am lab android");
});

Deno.test("am lab --status: absent container, against a fake docker", async () => {
  const dir = await fakeDocker(`
case "$1" in
  inspect) echo "no such object" >&2; exit 1;;
  *) exit 1;;
esac`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const r = await am(["lab", "windows", "--status", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  const j = JSON.parse(r.out);
  assertEquals(j.running, false);
  assertEquals(j.status, "absent");
  assertEquals(j.viewer, null);
  assertEquals(j.storage, `${home}/aio/labs/windows/storage`);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --status: a running container reports its ACTUAL port", async () => {
  // Read back from docker, never remembered: the container outlives am, and a
  // remembered port goes stale the moment someone restarts it by hand.
  const dir = await fakeDocker(`
case "$1" in
  inspect) echo "true|2026-08-27T00:00:00Z|running";;
  port) echo "127.0.0.1:45123";;
  *) exit 1;;
esac`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const r = await am(["lab", "windows", "--status", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  const j = JSON.parse(r.out);
  assertEquals(j.running, true);
  assertEquals(j.viewer, "http://127.0.0.1:45123/");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --stop: graceful stop THEN remove, in that order", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const log = `${home}/calls`;
  const dir = await fakeDocker(`
echo "$@" >> ${log}
case "$1" in
  inspect) echo "true|2026-08-27T00:00:00Z|running";;
  *) exit 0;;
esac`);
  const r = await am(["lab", "windows", "--stop", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  assertEquals(JSON.parse(r.out).stopped, true);
  const calls = (await Deno.readTextFile(log)).trim().split("\n");
  const stop = calls.findIndex((c) => c.startsWith("stop "));
  const rm = calls.findIndex((c) => c.startsWith("rm "));
  assert(stop >= 0 && rm > stop, `stop must precede rm: ${calls.join(" / ")}`);
  assertStringIncludes(calls[stop]!, `--time ${STOP_TIMEOUT_SEC}`);
  // The operator has to be told a clean shutdown takes a moment, or they ^C it.
  assertStringIncludes(r.err, "shut down");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --stop: nothing to stop is not an error", async () => {
  const dir = await fakeDocker(`exit 1`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const r = await am(["lab", "windows", "--stop"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --reset: refuses under a LIVE VM, and names the fix", async () => {
  const dir = await fakeDocker(`
case "$1" in
  inspect) echo "true|2026-08-27T00:00:00Z|running";;
  *) exit 0;;
esac`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  await Deno.mkdir(`${home}/aio/labs/windows/storage`, { recursive: true });
  const r = await am(["lab", "windows", "--reset"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.out + r.err, "--stop");
  // …and the disk is still there.
  assertEquals(
    (await Deno.stat(`${home}/aio/labs/windows/storage`)).isDirectory,
    true,
  );
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --reset: a stopped lab loses its disk, and only its own", async () => {
  const dir = await fakeDocker(`
case "$1" in
  inspect) exit 1;;
  *) exit 0;;
esac`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  await Deno.mkdir(`${home}/aio/labs/windows/storage`, { recursive: true });
  await Deno.writeTextFile(
    `${home}/aio/labs/windows/storage/data.img`,
    "x".repeat(1024),
  );
  await Deno.mkdir(`${home}/aio/labs/macos/storage`, { recursive: true });
  const r = await am(["lab", "windows", "--reset", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  // Allocated blocks, not apparent size (see fileCost) — so this is "at least
  // the file", never an exact byte count.
  assert(JSON.parse(r.out).freedBytes >= 1024, r.out);
  assertEquals(await exists(`${home}/aio/labs/windows`), false);
  assertEquals(await exists(`${home}/aio/labs/macos/storage`), true);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --reset: nothing installed yet is not an error", async () => {
  const dir = await fakeDocker(`exit 1`);
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const r = await am(["lab", "macos", "--reset"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab: preflight refusal reaches the CLI before any docker run", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const log = `${home}/calls`;
  // docker is alive but the image was never pulled.
  const dir = await fakeDocker(`
echo "$@" >> ${log}
case "$1" in
  info) echo "29.1.3";;
  inspect) exit 1;;
  images) echo -n "";;
  *) exit 0;;
esac`);
  const r = await am(["lab", "windows"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.out + r.err, "preflight failed");
  assertStringIncludes(r.out + r.err, "docker pull dockurr/windows");
  const calls = await Deno.readTextFile(log);
  assert(!calls.includes("\nrun "), "a refused preflight must not start a VM");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --tunnel: the process HOLDS the port open", async () => {
  // Regression: --tunnel printed "started" and then exited, leaving the
  // operator with a URL that answers nothing. The tunnel IS the process, so
  // "did it stay alive and bind the port" is the whole contract.
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const dir = await fakeDocker(`
case "$1" in
  info) echo "29.1.3";;
  images) echo "sha256:abc";;
  inspect) if [ -f ${home}/ran ]; then echo "true|2026-08-27T00:00:00Z|running"; else exit 1; fi;;
  run) touch ${home}/ran; echo "cid";;
  exec) echo -n "200";;
  logs) echo "booting";;
  *) exit 0;;
esac`);
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      `${REPO}/src/am.ts`,
      "lab",
      "windows",
      "--tunnel",
      `--port=${port}`,
      `--dist=${home}/dist`,
    ],
    env: {
      ...Deno.env.toObject(),
      AIO_AM_NO_DELEGATE: "1",
      PATH: `${dir}:${Deno.env.get("PATH")}`,
      XDG_CACHE_HOME: home,
    },
    cwd: REPO,
    stdout: "null",
    stderr: "null",
  }).spawn();

  let bound = false;
  for (let i = 0; i < 60 && !bound; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const c = await Deno.connect({ hostname: "127.0.0.1", port });
      c.close();
      bound = true;
    } catch { /* not yet */ }
  }
  child.kill("SIGKILL");
  await child.status;
  assert(bound, `--tunnel exited without binding ${port}`);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

/** A fake docker for a lab that is UP with a working share: it answers the
 *  state, the published port, the image's gateway file, the in-container health
 *  probe and the share log — i.e. everything the hand-off reads. */
function upWithShare(dist: string): string {
  return `
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) echo "${dist}";;
      *) echo "true|2026-08-27T00:00:00Z|running";;
    esac;;
  port) echo "127.0.0.1:45123";;
  exec)
    case "$*" in
      *qemu.gw*) echo "172.30.0.1";;
      *curl*) echo -n "200";;
      *tail*) echo '172.30.0.2 - - [27/Aug/2026 01:42:19] "GET /app-macos HTTP/1.1" 200 -';;
      *) exit 0;;
    esac;;
  *) exit 0;;
esac`;
}

Deno.test("am lab macos: the hand-off is a COMMAND, in the machine output too", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const dist = `${home}/dist`;
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(`${dist}/app-macos`, "mach-o");
  const dir = await fakeDocker(upWithShare(dist));
  const r = await am(["lab", "macos", `--dist=${dist}`, "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  const j = JSON.parse(r.out);
  assertEquals(j.shareServing, true);
  assertEquals(j.shareUrl, SHARE_URL);
  assertEquals(j.artifact.file, "app-macos");
  // The whole point: a line to paste, naming the actual file.
  assertEquals(j.fetchCommand, fetchCommand("macos", "app-macos"));
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab macos: the licence line is printed ONCE, on stderr", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const dist = `${home}/dist`;
  await Deno.mkdir(dist, { recursive: true });
  const dir = await fakeDocker(upWithShare(dist));
  const env = {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  };
  const first = await am(["lab", "macos", `--dist=${dist}`, "--json"], env);
  // stderr, so --json stdout stays parseable — the notice must never be data.
  assertStringIncludes(first.err, MACOS_LICENCE);
  assert(!first.out.includes("Apple"), first.out);
  JSON.parse(first.out);

  const second = await am(["lab", "macos", `--dist=${dist}`, "--json"], env);
  assert(
    !second.err.includes(MACOS_LICENCE),
    "a notice shown every time is a notice nobody reads",
  );
  // Windows never shows it at all.
  const win = await am(["lab", "windows", `--dist=${dist}`, "--json"], env);
  assert(!win.err.includes("Apple"), win.err);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab --status: the share is REPORTED, never started", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const log = `${home}/calls`;
  const dir = await fakeDocker(`
echo "$@" >> ${log}
${upWithShare(`${home}/dist`).trim()}`);
  const r = await am(["lab", "macos", "--status", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertEquals(r.code, 0);
  const j = JSON.parse(r.out);
  assertEquals(j.share.serving, true);
  assertEquals(j.share.url, SHARE_URL);
  // …and it says whether the GUEST has ever fetched anything, which is the
  // only evidence that host.lan resolves in there.
  assertStringIncludes(j.share.lastGuestFetch, "app-macos");
  // `--status` must not be a command that changes things.
  const calls = await Deno.readTextFile(log);
  assert(!calls.includes("--detach"), `--status started something: ${calls}`);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab: --dist on a LIVE lab warns instead of pretending", async () => {
  // A bind mount is fixed at `docker run`. Silently reporting the requested
  // directory would send someone to build into a folder the guest cannot see.
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const mounted = `${home}/mounted`;
  const asked = `${home}/asked`;
  await Deno.mkdir(mounted, { recursive: true });
  await Deno.mkdir(asked, { recursive: true });
  const dir = await fakeDocker(upWithShare(mounted));
  const r = await am(["lab", "windows", `--dist=${asked}`, "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  assertStringIncludes(r.err, mounted);
  assertStringIncludes(r.err, "--stop");
  assertEquals(JSON.parse(r.out).share, mounted);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab: a share that will not serve is SAID, with the next command", async () => {
  // The macOS first run reaches this: the image builds the guest network only
  // after the installer download, so there is no gateway yet. Printing a URL
  // that answers nothing is the failure the whole command exists to avoid.
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const dir = await fakeDocker(`
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) echo "${home}/dist";;
      *) echo "true|2026-08-27T00:00:00Z|running";;
    esac;;
  port) echo "127.0.0.1:45123";;
  exec) exit 1;;
  *) exit 0;;
esac`);
  const r = await am(["lab", "macos", "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  const j = JSON.parse(r.out);
  assertEquals(j.shareServing, false);
  assertEquals(j.fetchCommand, null);
  assertStringIncludes(j.shareReason, "am lab macos");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab linux: starts a CONTAINER — fuse+shm, no kvm, port 3000, no storage", async () => {
  // Through the CLI and the fake docker: the whole chain from parseLabOs to
  // the `docker run` line, for the lab that is not a VM. `/dev/kvm` may not
  // exist on this host — for a webtop that must not matter.
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const log = `${home}/calls`;
  const dist = `${home}/dist`;
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(`${dist}/app-x64.AppImage`, "elf");
  const dir = await fakeDocker(`
echo "$@" >> ${log}
case "$1" in
  info) echo "29.1.3";;
  images) echo "sha256:abc";;
  inspect)
    case "$*" in
      *Mounts*) echo "${dist}";;
      *) if [ -f ${home}/ran ]; then echo "true|2026-08-28T00:00:00Z|running"; else exit 1; fi;;
    esac;;
  run) touch ${home}/ran; echo "cid";;
  port) echo "127.0.0.1:45123";;
  exec) echo -n "200";;
  logs) echo "starting";;
  *) exit 0;;
esac`);
  // The lab polls the published viewer port until it answers; stand in for
  // the desktop with a 200 on a port of our choosing.
  const port = freePort();
  const viewer = Deno.serve(
    { hostname: "127.0.0.1", port, onListen() {} },
    () => new Response("ok"),
  );
  const r = await am(
    ["lab", "linux", `--dist=${dist}`, `--port=${port}`, "--json"],
    { PATH: `${dir}:${Deno.env.get("PATH")}`, XDG_CACHE_HOME: home },
  );
  await viewer.shutdown();
  assertEquals(r.code, 0, r.err);
  const calls = (await Deno.readTextFile(log)).trim().split("\n");
  const run = calls.find((c) => c.startsWith("run "))!;
  assert(run, `no docker run in: ${calls.join(" / ")}`);
  assertStringIncludes(run, "--device=/dev/fuse");
  assertStringIncludes(run, "--shm-size=1g");
  assertStringIncludes(run, ":3000");
  assertStringIncludes(run, `PUID=${Deno.uid()}`);
  assert(!run.includes("/dev/kvm"), run);
  assert(!run.includes(":/storage"), run);
  assert(!run.includes("RAM_SIZE"), run);
  assertEquals(await exists(`${home}/aio/labs/linux/storage`), false);
  const j = JSON.parse(r.out);
  assertEquals(j.artifact.file, "app-x64.AppImage");
  assertEquals(j.fetchCommand, fetchCommand("linux", "app-x64.AppImage"));
  assertEquals(j.shareUrl, shareUrl(LIN));
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab linux --ram=16G: refused at the CLI, before docker is asked", async () => {
  const dir = await fakeDocker(`exit 1`);
  const r = await am(["lab", "linux", "--ram=16G"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.out + r.err, "container, not a VM");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("am lab android: on a booted emulator, am INSTALLS and reports it", async () => {
  // The lab is already up (so no preflight against this host's /dev/kvm):
  // re-running `am lab android` is the dev loop — poll boot, adb install -r,
  // print the result in the machine output too.
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const log = `${home}/calls`;
  const dist = `${home}/dist`;
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(`${dist}/app.apk`, "zip");
  await Deno.writeTextFile(`${dist}/app-client.apk`, "zip");
  const dir = await fakeDocker(`
echo "$@" >> ${log}
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) echo "${dist}";;
      *) echo "true|2026-08-28T00:00:00Z|running";;
    esac;;
  port) echo "127.0.0.1:45123";;
  exec)
    case "$*" in
      *getprop*) echo "1";;
      *"adb install"*) echo "Success";;
      *curl*) echo -n "200";;
      *) exit 0;;
    esac;;
  *) exit 0;;
esac`);
  const env = { PATH: `${dir}:${Deno.env.get("PATH")}`, XDG_CACHE_HOME: home };
  const r = await am(["lab", "android", `--dist=${dist}`, "--json"], env);
  assertEquals(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assertEquals(
    j.artifact.file,
    "app-client.apk",
    "the client APK is preferred",
  );
  assertEquals(j.installed, true);
  assertStringIncludes(j.installResult, "app-client.apk");
  const calls = await Deno.readTextFile(log);
  assertStringIncludes(calls, "adb shell getprop sys.boot_completed");
  assertStringIncludes(calls, "adb install -r /shared/app-client.apk");
  // --apk picks the other one.
  await Deno.writeTextFile(log, "");
  const r2 = await am([
    "lab",
    "android",
    `--dist=${dist}`,
    "--apk=app.apk",
    "--json",
  ], env);
  assertEquals(JSON.parse(r2.out).artifact.file, "app.apk");
  assertStringIncludes(
    await Deno.readTextFile(log),
    "adb install -r /shared/app.apk",
  );
  // --status says booted, and does not install.
  await Deno.writeTextFile(log, "");
  const st = await am(["lab", "android", "--status", "--json"], env);
  assertEquals(JSON.parse(st.out).booted, true);
  assert(!(await Deno.readTextFile(log)).includes("adb install"));
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

Deno.test("am lab android: a failed install is SAID in the output, exit stays usable", async () => {
  const home = await Deno.makeTempDir({ prefix: "aio-lab-home-" });
  const dist = `${home}/dist`;
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(`${dist}/app.apk`, "zip");
  const dir = await fakeDocker(`
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) echo "${dist}";;
      *) echo "true|2026-08-28T00:00:00Z|running";;
    esac;;
  port) echo "127.0.0.1:45123";;
  exec)
    case "$*" in
      *getprop*) echo "1";;
      *"adb install"*) echo "Failure [INSTALL_FAILED_NO_MATCHING_ABIS]" >&2; exit 1;;
      *curl*) echo -n "200";;
      *) exit 0;;
    esac;;
  *) exit 0;;
esac`);
  const r = await am(["lab", "android", `--dist=${dist}`, "--json"], {
    PATH: `${dir}:${Deno.env.get("PATH")}`,
    XDG_CACHE_HOME: home,
  });
  const j = JSON.parse(r.out);
  assertEquals(j.installed, false);
  assertStringIncludes(j.installResult, "NO_MATCHING_ABIS");
  assertStringIncludes(j.installResult, "x86_64");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(home, { recursive: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── The one test that boots a real VM (opt-in) ─────────────

Deno.test({
  name:
    "AIO_VM_LAB=1: a real Windows lab starts, serves its viewer and its share",
  ignore: Deno.env.get("AIO_VM_LAB") !== "1",
  // aio-ok: a real Windows VM lab (docker + QEMU child) stays up past the test; its viewer/share sockets are the container's, not the test's
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    // Costs tens of minutes and tens of GB on a cold cache — never in
    // `deno task test`.
    const r = await am(["lab", "windows", "--json"], {});
    assert(r.code === 0, r.err);
    const j = JSON.parse(r.out);
    assert(j.viewer.startsWith("http://127.0.0.1:"), r.out);
    const res = await fetch(j.viewer);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    // The viewer answering is not the same as the lab being usable.
    assertEquals(j.shareServing, true, j.shareReason ?? r.out);
    assertEquals(j.shareUrl, SHARE_URL);
  },
});

Deno.test({
  // Separate value, because a macOS lab cannot be created unattended: someone
  // has to drive Disk Utility and the installer once. This checks the half a
  // machine CAN check — that the hand-off is live in whatever macOS guest is
  // already there, recovery included.
  name: "AIO_VM_LAB=macos: the macOS lab's artifact share is serving",
  ignore: Deno.env.get("AIO_VM_LAB") !== "macos",
  // aio-ok: a real macOS VM lab (docker + QEMU child) stays up past the test; its share socket is the container's, not the test's
  sanitizeOps: false,
  sanitizeResources: false, // aio-ok: see above
  fn: async () => {
    const start = await am(["lab", "macos", "--json"], {});
    assert(start.code === 0, start.err);
    const j = JSON.parse(start.out);
    assertEquals(j.shareServing, true, j.shareReason ?? start.out);

    const st = await am(["lab", "macos", "--status", "--json"], {});
    const s = JSON.parse(st.out);
    assertEquals(s.running, true);
    assertEquals(s.share.serving, true);
    assertEquals(s.share.url, SHARE_URL);
  },
});
