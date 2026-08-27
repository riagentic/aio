/**
 * @module
 * `am lab windows` / `am lab macos` — a real Windows or macOS desktop, in a
 * container, that a HUMAN drives from a browser.
 *
 * This is the manual counterpart to the two automated Windows/Linux gates:
 *
 * | tool                    | what it is                        | driven by |
 * | ----------------------- | --------------------------------- | --------- |
 * | `deno task test:wine`   | the .exe executed under Wine      | CI        |
 * | `deno task lab`         | install→create→dev in Ubuntu      | CI        |
 * | `am lab windows|macos`  | a REAL OS you click around in      | a person  |
 *
 * Nothing here is a gate and nothing here runs in `deno task test`: it boots a
 * VM, which takes tens of minutes and tens of gigabytes the first time. It
 * exists for the one question the automated tiers cannot answer — "does the
 * thing we ship actually look and behave right on that OS?"
 *
 * Mechanically it is a thin, honest wrapper over the `dockurr/windows` and
 * `dockurr/macos` images (QEMU + KVM + a browser viewer on container port
 * 8006). Everything shaped like a decision — the argv, where the disk lives,
 * what the preflight refuses — is a pure function below, so it is testable
 * without a VM (`tests/am-lab.test.ts`).
 *
 * ## Getting the build into the guest
 *
 * A lab you cannot put your app into is a screenshot of an operating system.
 * Both images bind-mount the host's `dist/` at `/shared` and export it over
 * virtio-9p — which Windows reads through the image's Samba (`\\host.lan\Data`)
 * and which macOS **cannot read at all**: Apple ships no 9p client, and the
 * macOS image ships no smbd. So the ONE mechanism that works in both guests is
 * neither: `am` runs a read-only file server INSIDE the lab container, on the
 * guest-facing bridge, serving that same directory at `http://host.lan:8007/`.
 *
 * `host.lan` is not ours — it is the image's own dnsmasq record
 * (`--address=/host.lan/<gateway>`), handed to the guest by the same DHCP lease
 * that gives it its address, and the gateway is the image's own
 * `/run/shm/qemu.gw`. So the guest resolves it with no configuration, both labs
 * name the artifact the same way, and nothing is published to the host.
 *
 * Measured end to end in BOTH guests — a real Windows 11 desktop and a real
 * macOS Sonoma one: `curl http://host.lan:8007/<file>` typed inside the guest
 * returns the bytes of the host's `dist/<file>`.
 */

import { join, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out, outError } from "./am-output.ts";

// ── The two labs ───────────────────────────────────────────

/** Which guest OS a lab runs. */
export type LabOs = "windows" | "macos";

/** Everything that differs between the two images, in one place. */
export type LabSpec = {
  readonly os: LabOs;
  readonly image: string;
  readonly container: string;
  readonly defaultVersion: string;
  readonly defaultRam: string;
  readonly defaultCpus: number;
  readonly defaultDisk: string;
  /** Where the host share turns up as a MOUNT inside the guest, in the guest's
   *  own vocabulary — or null when the guest cannot mount it at all. This is
   *  the extra, per-OS convenience; the hand-off that works in both guests is
   *  `SHARE_URL`, which needs no mount. */
  readonly guestShare: string | null;
  /** One line for the operator about that mount — including, for macOS, why
   *  there is none. */
  readonly shareNote: string;
  /** What the first run costs in wall-clock time, honestly. */
  readonly firstRun: string;
  /** What the guest calls the thing you paste the fetch command into. */
  readonly guestShell: string;
  /** Does the image keep one VM disk per VERSION under `/storage`? The macOS
   *  image does (`$STORAGE/<version>/data.img`, so `--version=15` next to an
   *  installed 14 is a second 40 GB install, not a boot); the Windows image
   *  keeps a single disk at the top level. */
  readonly versionedStorage: boolean;
};

export const LAB_SPECS: Readonly<Record<LabOs, LabSpec>> = {
  windows: {
    os: "windows",
    image: "dockurr/windows:latest",
    container: "aio-lab-windows",
    defaultVersion: "11",
    defaultRam: "8G",
    defaultCpus: 4,
    defaultDisk: "64G",
    guestShare: "\\\\host.lan\\Data",
    shareNote:
      'Windows can ALSO mount it: \\\\host.lan\\Data (the image runs Samba), live — rebuild on the host and press F5 in Explorer. If the name does not resolve, open "\\\\host.lan" first, or map it: net use Z: \\\\host.lan\\Data. Copy the .exe out of the share before running it: running off a network share is a more restricted Windows code path than your users are on.',
    firstRun:
      "Windows downloads an ~8.5 GB installer and then installs UNATTENDED, no clicking. Measured end to end on a fast link: 21 min download, 30 min total from `am lab windows` to a usable desktop. On a slower link the download is the whole story.",
    guestShell: "PowerShell",
    versionedStorage: false,
  },
  macos: {
    os: "macos",
    image: "dockurr/macos:latest",
    container: "aio-lab-macos",
    defaultVersion: "14",
    defaultRam: "8G",
    defaultCpus: 4,
    defaultDisk: "64G",
    // The image exports /shared over virtio-9p (mount_tag "shared") and ships
    // no smbd. macOS has a client for neither, so unlike Windows there is no
    // MOUNT path to name here — naming one would be a lie the operator only
    // discovers inside the VM. The hand-off is SHARE_URL, which needs none.
    guestShare: null,
    shareNote:
      "macOS cannot mount the host directory (no 9p client in macOS, no smbd in this image) — the http://host.lan share above is the hand-off, and it is the whole of it.",
    firstRun:
      "macOS is NOT unattended: it downloads Apple's recovery image, and then YOU drive the installer in the viewer — Disk Utility → erase the QEMU HARDDISK as APFS → quit → Reinstall macOS → wait. Budget 60+ min, most of it watching.",
    guestShell: "Terminal",
    versionedStorage: true,
  },
} as const;

/** Parse the OS argument, or say what the choices are. Pure. */
export function parseLabOs(arg: string | undefined): LabOs | null {
  if (arg === "windows" || arg === "win") return "windows";
  if (arg === "macos" || arg === "mac" || arg === "osx") return "macos";
  return null;
}

// ── Where the disk lives ───────────────────────────────────

/** aio's per-user lab root: `$XDG_CACHE_HOME/aio/labs` or `~/.cache/aio/labs`.
 *  Pure in its inputs — the env is passed in, so a test can place it. */
export function labRoot(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CACHE_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(
    xdg && xdg.length > 0 ? xdg : join(home, ".cache"),
    "aio",
    "labs",
  );
}

/** The three paths one lab owns. Pure. */
export function labDirs(
  os: LabOs,
  env: Record<string, string | undefined>,
): { root: string; storage: string } {
  const root = join(labRoot(env), os);
  return { root, storage: join(root, "storage") };
}

// ── The docker argv ────────────────────────────────────────

/** Everything `docker run` needs, resolved. */
export type LabOpts = {
  readonly spec: LabSpec;
  readonly port: number;
  readonly ram: string;
  readonly cpus: number;
  readonly disk: string;
  readonly version: string;
  readonly storage: string;
  /** Host directory bind-mounted at /shared — the app's `dist/`. */
  readonly share: string;
  /** Serve the viewer through a `docker exec` tunnel instead of a published
   *  port — the escape hatch for hosts where docker's port publishing does not
   *  reach the host at all (see `UNREACHABLE_FIX`). Nothing is published, and
   *  `am` owns the port itself. */
  readonly tunnel: boolean;
};

/** How long docker waits for the guest to shut down cleanly. A VM killed
 *  mid-write comes back with a dirty disk, which on Windows means a repair
 *  cycle the operator gets to watch instead of the app they were testing. */
export const STOP_TIMEOUT_SEC = 120;

/** The full `docker run` argv. Pure — this is the function the tests pin. */
export function runArgv(o: LabOpts): string[] {
  const a = [
    "run",
    "--detach",
    "--name",
    o.spec.container,
    "--device=/dev/kvm",
    "--device=/dev/net/tun",
    "--cap-add",
    "NET_ADMIN",
    "--stop-timeout",
    String(STOP_TIMEOUT_SEC),
    "-e",
    `VERSION=${o.version}`,
    "-e",
    `RAM_SIZE=${o.ram}`,
    "-e",
    `CPU_CORES=${o.cpus}`,
    "-e",
    `DISK_SIZE=${o.disk}`,
  ];
  // Loopback only. A manual-testing VM with no password on its viewer is not
  // something to hand the LAN. Under `--tunnel` nothing is published at all —
  // `am` binds that port itself and forwards through `docker exec`.
  if (!o.tunnel) a.push("-p", `127.0.0.1:${o.port}:8006`);
  a.push(
    "-v",
    `${o.storage}:/storage`,
    "-v",
    `${o.share}:/shared`,
    o.spec.image,
  );
  return a;
}

/** The tunnel's other end: one `nc` inside the container per connection.
 *  `nc` and `python3` are both in the image, so this needs no second image, no
 *  extra capability and nothing installed on the host. Pure. */
export function tunnelArgv(container: string): string[] {
  return ["exec", "-i", container, "nc", "127.0.0.1", "8006"];
}

// ── The artifact hand-off ──────────────────────────────────
//
// One mechanism, both guests: a read-only file server inside the container,
// on the guest-facing bridge, serving the same host directory the lab already
// bind-mounts. See the module header for why neither 9p nor SMB can be it.

/** The share's port INSIDE the container. Never published to the host — the
 *  host already HAS the directory; the only client is the guest. The same
 *  number in both labs, on purpose: one grammar, one URL to remember. */
export const SHARE_PORT = 8007;

/** The name the guest resolves the container by. Not ours: the image's own
 *  dnsmasq answers `host.lan` with the gateway it hands the guest by DHCP,
 *  which is why this needs no setup inside either guest. */
export const SHARE_HOST = "host.lan";

/** The one URL both labs print, and the only one an operator has to remember. */
export const SHARE_URL = `http://${SHARE_HOST}:${SHARE_PORT}/`;

/** Where the share server's request log lives inside the container. Kept
 *  because "did the guest actually fetch it?" is otherwise unanswerable — a
 *  guest that cannot resolve `host.lan` looks exactly like a guest nobody has
 *  typed the command into yet. */
export const SHARE_LOG = "/run/shm/aio-share.log";

/** The image's own record of the address the guest sees as its gateway —
 *  written by `configureDNS()` in every network mode, and the same address
 *  dnsmasq answers `host.lan` with. Reading it (rather than deriving a subnet
 *  ourselves) keeps ONE decider for "where does the guest reach us". */
export function gatewayArgv(container: string): string[] {
  return ["exec", container, "cat", "/run/shm/qemu.gw"];
}

/** An IPv4 address out of a one-line file, or null. Pure. */
export function parseIpv4(stdout: string): string | null {
  const s = stdout.trim().split("\n")[0]?.trim() ?? "";
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  return s.split(".").every((o) => Number(o) <= 255) ? s : null;
}

/** Start the share, bound to the guest-facing address ONLY.
 *
 *  `--bind <gateway>` and not `0.0.0.0`: that address exists on the container's
 *  internal bridge, so the share is reachable from the guest and from nowhere
 *  else — not from the host, not from other containers on the docker network.
 *  Pure. */
export function shareServeArgv(container: string, ip: string): string[] {
  return [
    "exec",
    "--detach",
    container,
    "sh",
    "-c",
    `exec python3 -m http.server ${SHARE_PORT} --directory /shared ` +
    `--bind ${ip} >> ${SHARE_LOG} 2>&1`,
  ];
}

/** Is the share answering? Asked from INSIDE the container, like `insideOk` —
 *  nothing is published, so the host cannot ask. Pure. */
export function shareProbeArgv(container: string, ip: string): string[] {
  return [
    "exec",
    container,
    "curl",
    "-s",
    "-o",
    "/dev/null",
    "-m",
    "5",
    "-w",
    "%{http_code}",
    `http://${ip}:${SHARE_PORT}/`,
  ];
}

/** The recent request lines, so `--status` can say whether the GUEST has ever
 *  fetched anything. Deep enough to see past our own health probes: every
 *  `am lab` invocation writes one or two, and a window of three buried the one
 *  line that actually proves the hand-off works. Pure. */
export function shareLogArgv(container: string): string[] {
  return ["exec", container, "tail", "-200", SHARE_LOG];
}

/** A request line the GUEST made, not one of our own health probes: the probes
 *  come from the gateway address itself, the guest from anywhere else. Pure. */
export function lastGuestFetch(log: string, gatewayIp: string): string | null {
  const lines = log.trim().split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const ip = l.split(" ")[0] ?? "";
    if (ip && ip !== gatewayIp && /"GET .+" 2\d\d/.test(l)) return l.trim();
  }
  return null;
}

/** What `dist/` holds for THIS guest.
 *
 *  The point of the distinction is the macOS one: both lab guests are QEMU
 *  x86_64, so an `-macos-arm64` artifact cannot run in the macOS lab at all.
 *  Handing someone a fetch command for a binary that dies with "Bad CPU type
 *  in executable" — 40 minutes after they started installing an OS to try it —
 *  is the failure this exists to name up front. Pure. */
export type GuestArtifact =
  | { readonly kind: "one"; readonly file: string }
  | { readonly kind: "many"; readonly files: string[] }
  | { readonly kind: "wrong-arch"; readonly files: string[] }
  | { readonly kind: "none" };

export function pickArtifact(os: LabOs, names: string[]): GuestArtifact {
  const sorted = [...names].sort();
  if (os === "windows") {
    const hits = sorted.filter((n) => n.toLowerCase().endsWith(".exe"));
    if (hits.length === 1) return { kind: "one", file: hits[0]! };
    return hits.length ? { kind: "many", files: hits } : { kind: "none" };
  }
  // `artifactName()` (src/build/platforms.ts) writes `<name>-macos` for the
  // Intel target and `<name>-macos-arm64` for Apple Silicon; a macOS Electron
  // target lands as a .dmg/.pkg/.zip next to them.
  const arm = sorted.filter((n) => /-macos-arm64$/.test(n));
  const hits = sorted.filter((n) =>
    /-macos$/.test(n) || /\.(dmg|pkg)$/i.test(n)
  );
  if (hits.length === 1) return { kind: "one", file: hits[0]! };
  if (hits.length > 1) return { kind: "many", files: hits };
  if (arm.length) return { kind: "wrong-arch", files: arm };
  return { kind: "none" };
}

/** The line an operator PASTES into the guest, naming the actual file.
 *
 *  Prose ("download it from the share and run it") is what makes a lab feel
 *  like homework. This is the command, with the file in it. Pure. */
export function fetchCommand(os: LabOs, file: string): string {
  return os === "windows"
    // PowerShell aliases `curl` to Invoke-WebRequest, which does NOT take -O;
    // curl.exe is the real one and has shipped in Windows since 10 1803.
    ? `cd $HOME\\Downloads; curl.exe -fLO ${SHARE_URL}${file}; .\\${file}`
    : `cd ~/Downloads && curl -fLO ${SHARE_URL}${file} && chmod +x ${file} && ./${file}`;
}

/** Everything the operator is told about the hand-off, as lines. Pure, because
 *  this is the part they act on and it must be identical in both labs. */
export function handoffLines(
  spec: LabSpec,
  share: string,
  artifact: GuestArtifact,
): string[] {
  const lines = [`share: ${share} → ${SHARE_URL} (in the guest)`];
  switch (artifact.kind) {
    case "one":
      lines.push(
        `paste into the guest's ${spec.guestShell}:`,
        `  ${fetchCommand(spec.os, artifact.file)}`,
      );
      break;
    case "many":
      lines.push(
        `${artifact.files.length} candidates in that directory (${
          artifact.files.join(", ")
        }) — pick one in the guest's browser at ${SHARE_URL}, or:`,
        `  ${fetchCommand(spec.os, artifact.files[0]!)}`,
      );
      break;
    case "wrong-arch":
      lines.push(
        `NOTHING THIS GUEST CAN RUN: ${
          artifact.files.join(", ")
        } is Apple Silicon and this lab is QEMU x86_64. Build the Intel one: ` +
          `\`deno task build --platforms=macos\`, then re-run \`am lab macos\`.`,
      );
      break;
    case "none":
      lines.push(
        `that directory has no ${spec.os} artifact yet — build one ` +
          `(\`deno task build --platforms=${spec.os}\`) and it appears in the ` +
          `guest immediately; the share is live, not a copy.`,
      );
      break;
  }
  if (spec.os === "macos") {
    // Worth one line: it changes what is being tested, not just how.
    lines.push(
      "curl does NOT set the Gatekeeper quarantine flag — to see what a user " +
        `actually sees, download it in Safari from ${SHARE_URL} instead.`,
    );
  }
  if (spec.guestShare) lines.push(spec.shareNote);
  return lines;
}

// ── macOS licensing ────────────────────────────────────────

/** One line, once. Apple's SLA permits macOS virtualisation only on
 *  Apple-branded hardware; this command exists for a maintainer's own machine
 *  and must not be mistaken for a supported CI path. Not a refusal, not a
 *  lecture — the operator decides, but never by accident. */
export const MACOS_LICENCE =
  "macOS in a VM: Apple's licence permits this only on Apple-branded hardware " +
  "— a local testing lab is yours to judge, a CI path it is not.";

/** Where "they have been told" is remembered. Under the lab root, so `--reset`
 *  (which throws the whole OS away) shows the notice again. Pure. */
export function noticeStamp(root: string): string {
  return join(root, "licence-notice-shown");
}

// ── Where THIS lab's disk lives ────────────────────────────

/** The storage directories that could hold the installed disk, in the order
 *  the image itself looks: the top level first (the Windows layout, and a
 *  legacy macOS one), then `<version>/` (what the macOS image writes for a
 *  fresh install, so each version keeps its own disk). Pure. */
export function diskDirs(
  spec: LabSpec,
  storage: string,
  version: string,
): string[] {
  return spec.versionedStorage
    ? [storage, join(storage, version.toLowerCase())]
    : [storage];
}

export function stopArgv(container: string): string[] {
  return ["stop", "--time", String(STOP_TIMEOUT_SEC), container];
}

export function rmArgv(container: string): string[] {
  return ["rm", "--force", container];
}

export function inspectArgv(container: string): string[] {
  return [
    "inspect",
    container,
    "--format",
    "{{.State.Running}}|{{.State.StartedAt}}|{{.State.Status}}",
  ];
}

/** `docker images -q <image>` — empty output means "not pulled". */
export function imagePresentArgv(image: string): string[] {
  return ["images", "--quiet", image];
}

// ── Preflight ──────────────────────────────────────────────

/** What the preflight looked at. Gathered impurely by `probe()`, judged purely
 *  by `preflight()` — so every refusal is testable without the machine. */
export type LabFacts = {
  readonly docker: "ok" | "missing" | "denied" | "down";
  readonly kvm: "ok" | "missing" | "denied";
  readonly tun: boolean;
  readonly image: boolean;
  /** Free space on the filesystem holding the lab root, in GB. */
  readonly freeGb: number | null;
};

/** A first Windows run peaks around 20 GB (the 8.5 GB installer plus the disk
 *  being written beside it) and settles at 12 GB once the installer is deleted
 *  — both measured on a clean Windows 11. It grows with use, so 45 is what we
 *  actually want free, not what one install strictly needs. */
export const NEED_GB = 45;
/** Below this we refuse outright rather than let Setup die at 97%. */
export const MIN_GB = 25;

export type Verdict = {
  readonly errors: string[];
  readonly warnings: string[];
};

/** Judge the facts. Every message names the CAUSE and the exact FIX. Pure. */
export function preflight(spec: LabSpec, f: LabFacts): Verdict {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (f.docker === "missing") {
    errors.push(
      "docker is not on PATH — a VM lab is a container. Fix: install Docker " +
        "(Ubuntu/Debian: `sudo apt install -y docker.io`, or " +
        "https://docs.docker.com/engine/install/), then `docker info` must work.",
    );
  } else if (f.docker === "denied") {
    errors.push(
      "the docker socket refused this process — you are not in the `docker` " +
        "group (or the shell predates being added). Fix: " +
        "`sudo usermod -aG docker $USER` then `newgrp docker` (a new shell), " +
        "or run this once as `sg docker -c 'am lab …'`.",
    );
  } else if (f.docker === "down") {
    errors.push(
      "the docker daemon is not answering. Fix: `sudo systemctl start docker`, " +
        "then re-run.",
    );
  }

  if (f.kvm === "missing") {
    errors.push(
      "/dev/kvm does not exist — without hardware virtualisation this VM would " +
        "emulate at roughly 1/20th speed, which is not a lab. Fix: enable " +
        "AMD-V/VT-x in the BIOS/UEFI, and `sudo modprobe kvm_amd` (Intel: " +
        "`kvm_intel`). Inside a VM already? Enable nested virtualisation on the " +
        "host.",
    );
  } else if (f.kvm === "denied") {
    errors.push(
      "/dev/kvm exists but this user cannot read+write it. Fix: " +
        "`sudo setfacl -m u:$USER:rw /dev/kvm` (per-user, immediate), or " +
        "`sudo usermod -aG kvm $USER` + `newgrp kvm`.",
    );
  }

  if (!f.tun) {
    errors.push(
      "/dev/net/tun does not exist — the guest gets no network without it. " +
        "Fix: `sudo modprobe tun` (and add `tun` to /etc/modules to keep it " +
        "across reboots).",
    );
  }

  if (!f.image) {
    errors.push(
      `the image ${spec.image} is not pulled, and pulling it during a lab ` +
        `start would look like a hang. Fix: \`docker pull ${spec.image}\` ` +
        `(note the double r in "dockurr" — "dockur/${spec.os}" does not exist).`,
    );
  }

  if (f.freeGb !== null) {
    if (f.freeGb < MIN_GB) {
      errors.push(
        `only ${f.freeGb} GB free where the VM disk goes, and a first ` +
          `${spec.os} run needs about ${NEED_GB} GB (an ~8.5 GB installer plus ` +
          `the installed disk). Fix: free space, drop an old lab with ` +
          `\`am lab ${spec.os} --reset\`, or point the cache at a bigger ` +
          `filesystem: \`export XDG_CACHE_HOME=/somewhere/big\`.`,
      );
    } else if (f.freeGb < NEED_GB) {
      warnings.push(
        `${f.freeGb} GB free where the VM disk goes — a first ${spec.os} run ` +
          `wants about ${NEED_GB} GB and the disk grows as the guest is used. ` +
          `Set XDG_CACHE_HOME to a bigger filesystem if Setup runs out.`,
      );
    }
  }

  return { errors, warnings };
}

/** `df -Pk <dir>` → available GB. Pure parse of the POSIX format. */
export function parseDfAvailKb(stdout: string): number | null {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const cols = lines[lines.length - 1]!.trim().split(/\s+/);
  const avail = Number(cols[3]);
  return Number.isFinite(avail) ? avail : null;
}

// ── Progress ───────────────────────────────────────────────

/** Turn the image's log tail into one line an operator can act on. Pure. */
export function phaseFromLogs(logs: string): string {
  // deno-lint-ignore no-control-regex
  const plain = logs.replace(/\x1B\[[0-9;]*m/g, ""); // the image colours its log
  const last = plain.trimEnd().split("\n").filter((l) => l.trim()).pop() ?? "";
  return last.replace(/^[❯>*\s]+/, "").trim();
}

/** The one diagnosis that is NOT a docker error and would otherwise read as a
 *  hang: the container serves the viewer, but the host cannot reach a
 *  published port because the docker bridge is firewalled off from the host. */
export const UNREACHABLE_FIX =
  "the viewer is serving INSIDE the container but the host cannot reach the " +
  "published port — on this machine docker's port publishing does not reach " +
  "the host (a firewall between the host and the docker bridge). Confirm it " +
  "is the host and not aio: `docker run --rm -d -p 127.0.0.1:18099:80 " +
  "--name nt nginx:alpine && curl -m3 http://127.0.0.1:18099/ ; docker rm -f " +
  "nt` — no answer there means every published port on this machine is dead. " +
  "Fix: repair the host's docker networking (its DOCKER-USER / FORWARD " +
  "rules), or work around it with `am lab <os> --tunnel`, which publishes " +
  "nothing and forwards the viewer through `docker exec` instead.";

// ── Impure edges ───────────────────────────────────────────

/** A free TCP port, taken the only way that cannot collide: ask the kernel.
 *  A constant default port is what makes two labs (or a lab and the app under
 *  test) fight over 8006 and blame each other. */
export function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function docker(
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = await new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: p.code,
      out: new TextDecoder().decode(p.stdout),
      err: new TextDecoder().decode(p.stderr),
    };
  } catch (e) {
    return { code: 127, out: "", err: String(e) };
  }
}

async function accessible(path: string, write: boolean): Promise<boolean> {
  try {
    const f = await Deno.open(path, { read: true, write });
    f.close();
    return true;
  } catch {
    return false;
  }
}

async function probe(spec: LabSpec, labDir: string): Promise<LabFacts> {
  const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
  const dockerState: LabFacts["docker"] = info.code === 0
    ? "ok"
    : info.code === 127
    ? "missing"
    : /permission denied|got permission denied/i.test(info.err)
    ? "denied"
    : /cannot connect|is the docker daemon running/i.test(info.err)
    ? "down"
    : "down";

  let kvm: LabFacts["kvm"] = "missing";
  try {
    await Deno.stat("/dev/kvm");
    kvm = (await accessible("/dev/kvm", true)) ? "ok" : "denied";
  } catch { /* missing */ }

  let tun = false;
  try {
    await Deno.stat("/dev/net/tun");
    tun = true;
  } catch { /* missing */ }

  const img = dockerState === "ok"
    ? await docker(imagePresentArgv(spec.image))
    : { code: 1, out: "", err: "" };

  // df the nearest EXISTING ancestor — the lab dir itself may not be made yet.
  let probeDir = labDir;
  for (let i = 0; i < 8; i++) {
    try {
      await Deno.stat(probeDir);
      break;
    } catch {
      probeDir = resolve(probeDir, "..");
    }
  }
  const df = await new Deno.Command("df", {
    args: ["-Pk", probeDir],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  const availKb = df
    ? parseDfAvailKb(new TextDecoder().decode(df.stdout))
    : null;

  return {
    docker: dockerState,
    kvm,
    tun,
    image: img.code === 0 && img.out.trim().length > 0,
    freeGb: availKb === null ? null : Math.floor(availKb / 1024 / 1024),
  };
}

type State = { running: boolean; startedAt: string; status: string } | null;

async function containerState(container: string): Promise<State> {
  const r = await docker(inspectArgv(container));
  if (r.code !== 0) return null;
  const [running, startedAt, status] = r.out.trim().split("|");
  return {
    running: running === "true",
    startedAt: startedAt ?? "",
    status: status ?? "",
  };
}

/** Published host port, read back from docker rather than remembered — the
 *  container outlives this process, and a remembered port would go stale. */
async function publishedPort(container: string): Promise<number | null> {
  const r = await docker(["port", container, "8006/tcp"]);
  if (r.code !== 0) return null;
  const m = r.out.trim().split("\n")[0]?.match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

async function reachable(port: number, ms: number): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Does the viewer answer INSIDE the container? The one question that tells
 *  "still booting" apart from "this host cannot reach a published port" —
 *  they look identical from a browser and have opposite fixes. */
async function insideOk(container: string): Promise<boolean> {
  const r = await docker([
    "exec",
    container,
    "curl",
    "-s",
    "-o",
    "/dev/null",
    "-m",
    "5",
    "-w",
    "%{http_code}",
    "http://127.0.0.1:8006/",
  ]);
  return r.out.trim() === "200";
}

/** What the artifact share is doing right now. `ip` is the address the guest
 *  reaches us at; `reason` is filled in ONLY when `serving` is false, and
 *  always names the next command. */
type ShareState = {
  readonly ip: string | null;
  readonly serving: boolean;
  readonly reason: string | null;
};

/** Look, do not touch — what `--status` needs. */
async function shareLook(spec: LabSpec): Promise<ShareState> {
  const container = spec.container;
  const g = await docker(gatewayArgv(container));
  const ip = g.code === 0 ? parseIpv4(g.out) : null;
  if (!ip) {
    return {
      ip: null,
      serving: false,
      reason:
        "the guest's network does not exist yet — the image builds it AFTER " +
        "the installer download, so this is normal on a first run and never " +
        `normal on a booted guest. Re-run \`am lab ${spec.os}\` once the ` +
        "desktop is up and the share starts with it.",
    };
  }
  const p = await docker(shareProbeArgv(container, ip));
  const serving = p.out.trim() === "200";
  return {
    ip,
    serving,
    // A `reason` is owed whenever `serving` is false — "not serving, no idea
    // why" is the shape of message this whole command exists to not print.
    reason: serving
      ? null
      : "not started yet (a `docker restart` also takes it away). Bring it " +
        `back with \`am lab ${spec.os}\` on the running lab — that re-prints ` +
        "the fetch command too.",
  };
}

/** Start the artifact share if it is not already up, and PROVE it answers
 *  before promising the operator a URL.
 *
 *  Idempotent by probe, not by memory: the container outlives this process,
 *  a `docker restart` takes the exec'd server with it, and a URL printed for a
 *  server that is not there is exactly the "looks like it worked" failure the
 *  lab exists to avoid. */
async function ensureShare(spec: LabSpec): Promise<ShareState> {
  const container = spec.container;
  const seen = await shareLook(spec);
  if (seen.serving || !seen.ip) return seen;

  const started = await docker(shareServeArgv(container, seen.ip));
  if (started.code !== 0) {
    return {
      ip: seen.ip,
      serving: false,
      reason: `could not start the artifact share: ${
        started.err.trim() || started.out.trim()
      } — start it by hand with \`docker ${
        shareServeArgv(container, seen.ip).join(" ")
      }\`.`,
    };
  }
  // `docker exec --detach` returns before the process has bound: measured, the
  // first probe lands a second early and says 000. Retry rather than declare a
  // failure that is only a race.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await docker(shareProbeArgv(container, seen.ip));
    if (p.out.trim() === "200") {
      return { ip: seen.ip, serving: true, reason: null };
    }
  }
  const log = await docker(shareLogArgv(container));
  return {
    ip: seen.ip,
    serving: false,
    reason:
      `the artifact share was started but never answered on ${seen.ip}:${SHARE_PORT} ` +
      `inside the container. Its output: ${
        (log.out + log.err).trim() || "(none)"
      } — reproduce it with \`docker exec ${container} python3 -m http.server ` +
      `${SHARE_PORT} --directory /shared --bind ${seen.ip}\`.`,
  };
}

/** Forward 127.0.0.1:<port> into the container's viewer, one `docker exec nc`
 *  per connection. BLOCKS until interrupted — the tunnel is the process.
 *
 *  This exists because a published port is not always reachable: on a host
 *  whose firewall sits between it and the docker bridge, `docker run -p` binds
 *  and then swallows every byte. `docker exec` is a stream the daemon serves
 *  directly, so it works wherever docker itself does — no second image, no
 *  capability, nothing installed on the host, and the guest's own networking
 *  untouched. */
async function serveTunnel(container: string, port: number): Promise<void> {
  const l = Deno.listen({ hostname: "127.0.0.1", port });
  for await (const conn of l) {
    (async () => {
      let child: Deno.ChildProcess | undefined;
      try {
        child = new Deno.Command("docker", {
          args: tunnelArgv(container),
          stdin: "piped",
          stdout: "piped",
          stderr: "null",
        }).spawn();
        await Promise.race([
          conn.readable.pipeTo(child.stdin),
          child.stdout.pipeTo(conn.writable),
        ]);
      } catch {
        // A viewer tab closing mid-stream is normal, not an incident.
      } finally {
        try {
          child?.kill();
        } catch { /* already gone */ }
        try {
          conn.close();
        } catch { /* already closed */ }
      }
    })();
  }
}

// ── Flag parsing ───────────────────────────────────────────

export type LabAction = "start" | "stop" | "status" | "reset";

export type LabArgs = {
  readonly action: LabAction;
  readonly ram: string;
  readonly cpus: number;
  readonly disk: string;
  readonly version: string;
  readonly dist: string | null;
  readonly tunnel: boolean;
};

/** Parse the lab-specific flags. Unknown flags are an ERROR, never ignored —
 *  a silently dropped `--ram=32G` means an operator debugging a slow guest is
 *  looking at a flag that never arrived. Pure. */
export function parseLabArgs(
  spec: LabSpec,
  args: string[],
): { ok: true; value: LabArgs } | { ok: false; error: string } {
  let action: LabAction = "start";
  let ram = spec.defaultRam;
  let cpus = spec.defaultCpus;
  let disk = spec.defaultDisk;
  let version = spec.defaultVersion;
  let dist: string | null = null;
  let tunnel = false;

  for (const a of args) {
    if (a === "--stop") action = "stop";
    else if (a === "--status") action = "status";
    else if (a === "--reset") action = "reset";
    else if (a === "--tunnel") tunnel = true;
    else if (a.startsWith("--ram=")) ram = a.slice(6);
    else if (a.startsWith("--disk=")) disk = a.slice(7);
    else if (a.startsWith("--version=")) version = a.slice(10);
    else if (a.startsWith("--dist=")) dist = a.slice(7);
    else if (a.startsWith("--cpus=")) {
      const n = Number(a.slice(7));
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, error: `--cpus needs a whole number ≥ 1: ${a}` };
      }
      cpus = n;
    } else {
      return {
        ok: false,
        error: `unknown flag for \`am lab\`: ${a} — accepted: --stop, ` +
          `--status, --reset, --port=N, --ram=8G, --cpus=4, --disk=64G, ` +
          `--version=${spec.defaultVersion}, --dist=<dir>, --tunnel`,
      };
    }
  }
  for (const [flag, v] of [["--ram", ram], ["--disk", disk]] as const) {
    if (!/^\d+[MG]$/.test(v)) {
      return {
        ok: false,
        error: `${flag}=${v} is not a size the image understands — use e.g. ` +
          `${flag}=8G or ${flag}=512M`,
      };
    }
  }
  return {
    ok: true,
    value: { action, ram, cpus, disk, version, dist, tunnel },
  };
}

export const LAB_USAGE = `am lab <windows|macos> [options]

  A REAL Windows or macOS desktop in a container, driven by a human from a
  browser. Not a gate: nothing here runs in \`deno task test\`.

  am lab windows              start it, mount dist/, print the viewer URL
  am lab windows --status     is it up, on which port, how big is the disk
  am lab windows --stop       shut the guest down cleanly, then remove it
  am lab windows --reset      DELETE the VM disk (tens of GB) and start over

  --port=N        viewer port on 127.0.0.1 (default: a free one)
  --ram=8G        guest RAM            --cpus=4     guest cores
  --disk=64G      virtual disk size    --version=11 guest OS version
  --dist=<dir>    host dir shared into the guest (default: <app>/dist)
  --tunnel        publish nothing; forward the viewer through \`docker exec\`
                  and hold it open — for hosts where docker's published ports
                  do not reach the host at all

  The VM disk lives in ~/.cache/aio/labs/<os>/ and SURVIVES --stop, so the
  second start is a boot, not an install.

  Both labs hand the build over the same way: the shared directory is served
  to the guest at ${SHARE_URL} (Windows can also mount \\\\host.lan\\Data).
  Re-running \`am lab <os>\` on a live lab re-prints the fetch command and
  brings the share back if it went away. See docs/testing/vm-labs.md.`;

// ── The command ────────────────────────────────────────────

export async function cmdLab(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const os = parseLabOs(args[0]);
  if (!os) {
    // The usage IS the fix here — printing "see --help" when `am <x> --help`
    // is intercepted upstream into the global help would send them nowhere.
    console.error(LAB_USAGE + "\n"); // stderr — never pollutes --json stdout
    fail(
      `am lab needs an OS: \`am lab windows\` or \`am lab macos\`` +
        (args[0] ? ` (got "${args[0]}")` : ""),
      mode,
    );
  }
  const spec = LAB_SPECS[os];
  const parsed = parseLabArgs(spec, args.slice(1));
  if (!parsed.ok) fail(parsed.error, mode);
  const opt = parsed.value;
  const dirs = labDirs(os, Deno.env.toObject());

  if (opt.action === "status") return await labStatus(spec, dirs, mode);
  if (opt.action === "stop") return await labStop(spec, mode);
  if (opt.action === "reset") return await labReset(spec, dirs, mode);
  return await labStart(spec, opt, dirs, flags, mode);
}

async function labStatus(
  spec: LabSpec,
  dirs: { root: string; storage: string },
  mode: ReturnType<typeof detectMode>,
): Promise<void> {
  const st = await containerState(spec.container);
  const port = st?.running ? await publishedPort(spec.container) : null;
  const size = await diskSize(dirs.storage);
  // Look, never start: `--status` reporting a share into existence would make
  // "is it up?" and "make it up" the same command.
  const share = st?.running
    ? await shareLook(spec)
    : { ip: null, serving: false, reason: null };
  const fetched = share.serving && share.ip
    ? lastGuestFetch(
      (await docker(shareLogArgv(spec.container))).out,
      share.ip,
    )
    : null;
  const versions = spec.versionedStorage
    ? await installedVersions(dirs.storage)
    : [];
  const data = {
    os: spec.os,
    running: st?.running ?? false,
    status: st?.status ?? "absent",
    startedAt: st?.startedAt ?? null,
    viewer: port ? `http://127.0.0.1:${port}/` : null,
    storage: dirs.storage,
    diskBytes: size,
    installedVersions: versions,
    share: {
      url: SHARE_URL,
      serving: share.serving,
      lastGuestFetch: fetched,
      reason: share.reason,
    },
  };
  if (mode === "json") return out(data, mode);
  const disk = `\n  disk ${human(size)} at ${dirs.storage}` +
    (versions.length ? ` (installed: ${versions.join(", ")})` : "");
  out(
    st?.running
      ? `● ${spec.os} lab running${
        port ? ` — http://127.0.0.1:${port}/` : ""
      }` + disk +
        `\n  share ${
          share.serving
            ? `${SHARE_URL} serving${
              fetched
                ? ` — last guest fetch: ${fetched}`
                : " — no guest fetch yet"
            }`
            : `NOT serving — ${share.reason ?? "start the lab to bring it up"}`
        }` +
        (port ? "" : `\n  (no published port — started with --tunnel?)`)
      : `○ ${spec.os} lab ${data.status}` + disk +
        `\n  start it: am lab ${spec.os}`,
    mode,
  );
}

/** Which macOS versions already have a disk on this machine. The macOS image
 *  keeps one per version, so this is the difference between `--version=15`
 *  being a boot and being a second 40 GB install. */
async function installedVersions(storage: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const e of Deno.readDir(storage)) {
      if (e.isDirectory && await hasDisk([join(storage, e.name)])) {
        found.push(e.name);
      }
    }
  } catch { /* absent */ }
  return found.sort();
}

async function labStop(
  spec: LabSpec,
  mode: ReturnType<typeof detectMode>,
): Promise<void> {
  const st = await containerState(spec.container);
  if (!st) {
    out(`○ no ${spec.os} lab container to stop`, mode);
    return;
  }
  if (st.running) {
    console.error(
      `▸ asking ${spec.os} to shut down (up to ${STOP_TIMEOUT_SEC}s) — killing ` +
        `a guest mid-write leaves a dirty disk and a repair cycle on next boot`,
    );
    const r = await docker(stopArgv(spec.container));
    if (r.code !== 0) {
      outError(
        `docker stop failed: ${r.err.trim() || r.out.trim()} — ` +
          `force it with \`docker rm -f ${spec.container}\` (the VM disk is ` +
          `in the volume and survives).`,
        mode,
      );
    }
  }
  const rm = await docker(rmArgv(spec.container));
  if (rm.code !== 0) {
    fail(
      `docker rm failed: ${rm.err.trim() || rm.out.trim()} — ` +
        `retry with \`docker rm -f ${spec.container}\`.`,
      mode,
    );
  }
  out(
    mode === "json"
      ? { stopped: true, os: spec.os }
      : `✓ ${spec.os} lab stopped — the VM disk is kept; \`am lab ${spec.os}\` boots it back`,
    mode,
  );
}

async function labReset(
  spec: LabSpec,
  dirs: { root: string; storage: string },
  mode: ReturnType<typeof detectMode>,
): Promise<void> {
  const st = await containerState(spec.container);
  if (st?.running) {
    fail(
      `the ${spec.os} lab is still running — deleting the disk under a live ` +
        `VM corrupts it. Fix: \`am lab ${spec.os} --stop\` first, then --reset.`,
      mode,
    );
  }
  if (st) await docker(rmArgv(spec.container));
  const size = await diskSize(dirs.storage);
  try {
    await Deno.remove(dirs.root, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      fail(
        `could not delete ${dirs.root}: ${e} — the image writes as root, so ` +
          `try \`sudo rm -rf ${dirs.root}\`.`,
        mode,
      );
    }
  }
  out(
    mode === "json"
      ? { reset: true, os: spec.os, freedBytes: size }
      : `✓ ${spec.os} lab reset — freed ${
        human(size)
      }; the next start reinstalls the OS`,
    mode,
  );
}

async function labStart(
  spec: LabSpec,
  opt: LabArgs,
  dirs: { root: string; storage: string },
  flags: GlobalFlags,
  mode: ReturnType<typeof detectMode>,
): Promise<void> {
  // One line, once, before anything is downloaded or installed.
  if (spec.os === "macos") await licenceNotice(dirs.root);

  // The artifact hand-off: the app's own dist/ (`<root>/dist`, build-config.ts).
  const wanted = opt.dist
    ? resolve(Deno.cwd(), opt.dist)
    : join(Deno.cwd(), "dist");

  const existing = await containerState(spec.container);
  if (existing?.running) {
    // A lab that is already up is the normal way back in — and the share is
    // ensured HERE too, because a `docker restart` takes the exec'd server
    // with it and the operator's fix for everything else is "run it again".
    const mounted = await mountedShare(spec.container) ?? wanted;
    if (opt.dist && mounted !== wanted) {
      console.error(
        `⚠ this lab was started with ${mounted} mounted, not ${wanted} — a ` +
          `bind mount cannot be changed on a live container. Restart it to ` +
          `swap: am lab ${spec.os} --stop && am lab ${spec.os} --dist=${wanted}`,
      );
    }
    const hand = await handoff(spec, mounted);
    if (opt.tunnel) {
      const p = flags.port ?? freePort();
      const u = `http://127.0.0.1:${p}/`;
      out(
        mode === "json"
          ? {
            started: false,
            already: true,
            viewer: u,
            share: mounted,
            ...hand.data,
          }
          : `● ${spec.os} lab already running — tunnelling it to ${u}\n` +
            hand.lines.map((l) => `  ${l}`).join("\n") +
            `\n  this process IS the tunnel: leave it running, Ctrl-C when done`,
        mode,
      );
      await serveTunnel(spec.container, p);
      return;
    }
    const p = await publishedPort(spec.container);
    out(
      mode === "json"
        ? {
          started: false,
          already: true,
          viewer: p && `http://127.0.0.1:${p}/`,
          share: mounted,
          ...hand.data,
        }
        : `● ${spec.os} lab already running${
          p ? ` — http://127.0.0.1:${p}/` : " (no published port — --tunnel)"
        }\n` + hand.lines.map((l) => `  ${l}`).join("\n") +
          `\n  restart it: am lab ${spec.os} --stop && am lab ${spec.os}`,
      mode,
    );
    return;
  }

  const facts = await probe(spec, dirs.root);
  const verdict = preflight(spec, facts);
  for (const w of verdict.warnings) console.error(`⚠ ${w}`);
  if (verdict.errors.length) {
    fail(
      `${spec.os} lab preflight failed:\n  - ` + verdict.errors.join("\n  - "),
      mode,
    );
  }

  // A stopped leftover would hold the name and the old port mapping.
  if (existing) await docker(rmArgv(spec.container));

  // Created if absent so the mount is LIVE — build afterwards and the guest
  // sees it without restarting the lab.
  const share = wanted;
  await Deno.mkdir(share, { recursive: true });
  await Deno.mkdir(dirs.storage, { recursive: true });

  const port = flags.port ?? freePort();
  const argv = runArgv({
    spec,
    port,
    ram: opt.ram,
    cpus: opt.cpus,
    disk: opt.disk,
    version: opt.version,
    storage: dirs.storage,
    share,
    tunnel: opt.tunnel,
  });
  // Asked BEFORE the run: once QEMU is up it creates the disk image, and a
  // first run would then report itself as a returning one.
  const fresh = !(await hasDisk(diskDirs(spec, dirs.storage, opt.version)));
  // The macOS image keeps one disk per version, so asking for a version you do
  // not have installed is a SECOND install of an entire operating system —
  // tens of GB and an hour, silently, on a machine that already has one.
  if (fresh && spec.versionedStorage) {
    const have = await installedVersions(dirs.storage);
    if (have.length) {
      console.error(
        `⚠ no ${spec.os} disk for version "${opt.version}" — this installs a ` +
          `SECOND ${spec.os} from scratch (tens of GB, an hour of it manual). ` +
          `Already installed: ${have.join(", ")}. Boot one of those with ` +
          `\`am lab ${spec.os} --version=${have[0]}\`.`,
      );
    }
  }
  const run = await docker(argv);
  if (run.code !== 0) {
    fail(
      `docker run failed: ${run.err.trim() || run.out.trim()}\n  argv: ` +
        `docker ${argv.join(" ")}`,
      mode,
    );
  }

  const url = `http://127.0.0.1:${port}/`;
  console.error(
    `▸ ${spec.os} lab starting — viewer will be ${url}\n` +
      `  share: ${share}  →  ${SHARE_URL} in the guest`,
  );
  if (fresh) console.error(`▸ first run: ${spec.firstRun}`);

  // Poll rather than sleep: the operator gets the URL the moment it serves,
  // and a line of real progress every few seconds until then. A 20-minute
  // silent wait is the failure mode this exists to avoid.
  //
  // Under --tunnel the question is whether the viewer serves INSIDE the
  // container, because nothing is published for the host to reach yet.
  const deadline = Date.now() + 180_000;
  let up = false;
  let lastPhase = "";
  while (Date.now() < deadline) {
    if (
      opt.tunnel ? await insideOk(spec.container) : await reachable(port, 2000)
    ) {
      up = true;
      break;
    }
    const st = await containerState(spec.container);
    if (st && !st.running) {
      const logs = await docker(["logs", "--tail", "20", spec.container]);
      fail(
        `the ${spec.os} lab container exited (${st.status}). Its last output:\n` +
          logs.out + logs.err,
        mode,
      );
    }
    const logs = await docker(["logs", "--tail", "5", spec.container]);
    const phase = phaseFromLogs(logs.out + logs.err);
    if (phase && phase !== lastPhase) {
      lastPhase = phase;
      console.error(`  … ${phase}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!up) {
    // Distinguish "still booting" from "the host cannot reach it at all".
    if (!opt.tunnel && await insideOk(spec.container)) {
      fail(UNREACHABLE_FIX, mode);
    }
    outError(
      `the viewer has not answered yet (${lastPhase || "no output yet"}). ` +
        `It usually does within a minute. Watch it with ` +
        `\`docker logs -f ${spec.container}\`, then open ${url}.`,
      mode,
    );
    return;
  }

  // The viewer answering is not the same as the lab being usable: the share
  // lives on the guest's network, which the image builds AFTER the installer
  // download. So this is asked last, and its failure is reported, never hidden.
  const hand = await handoff(spec, share);

  out(
    mode === "json"
      ? {
        started: true,
        os: spec.os,
        viewer: url,
        share,
        guestShare: spec.guestShare,
        firstRun: fresh,
        ...hand.data,
      }
      : `✓ ${spec.os} lab viewer: ${url}\n` +
        (fresh ? `  the desktop is not there yet — ${spec.firstRun}\n` : "") +
        hand.lines.map((l) => `  ${l}`).join("\n") +
        `\n  stop:  am lab ${spec.os} --stop`,
    mode,
  );

  if (opt.tunnel) {
    console.error(
      `▸ tunnel open on ${url} — THIS PROCESS IS THE TUNNEL: leave it running, ` +
        `Ctrl-C when you are done. The VM keeps running either way; stop it ` +
        `with \`am lab ${spec.os} --stop\`.`,
    );
    await serveTunnel(spec.container, port);
  }
}

/** Where the LIVE container actually has its share mounted. Read back rather
 *  than assumed: a bind mount is fixed at `docker run`, so `--dist=` against an
 *  already-running lab changes nothing and must not look like it did. */
export function mountedShareArgv(container: string): string[] {
  return [
    "inspect",
    container,
    "--format",
    '{{range .Mounts}}{{if eq .Destination "/shared"}}{{.Source}}{{end}}{{end}}',
  ];
}

async function mountedShare(container: string): Promise<string | null> {
  const r = await docker(mountedShareArgv(container));
  const p = r.out.trim();
  return r.code === 0 && p.length > 0 ? p : null;
}

/** Bring the share up and say — in the operator's own next action — how to get
 *  the build into the guest. Both labs, same shape, same URL. */
async function handoff(
  spec: LabSpec,
  shareDir: string,
): Promise<{ lines: string[]; data: Record<string, unknown> }> {
  const state = await ensureShare(spec);
  const artifact = pickArtifact(spec.os, await listNames(shareDir));
  const lines = state.serving ? handoffLines(spec, shareDir, artifact) : [
    `share: ${shareDir} → ${SHARE_URL} — NOT SERVING: ${
      state.reason ?? "unknown"
    }`,
  ];
  return {
    lines,
    data: {
      shareUrl: SHARE_URL,
      shareServing: state.serving,
      shareReason: state.reason,
      artifact,
      fetchCommand: artifact.kind === "one" && state.serving
        ? fetchCommand(spec.os, artifact.file)
        : null,
    },
  };
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) names.push(e.name);
  } catch { /* absent */ }
  return names;
}

/** Print `MACOS_LICENCE` the first time a macOS lab is started on this machine,
 *  and remember. stderr, so `--json` stdout stays parseable. */
async function licenceNotice(root: string): Promise<void> {
  const stamp = noticeStamp(root);
  try {
    await Deno.stat(stamp);
    return;
  } catch { /* not shown yet */ }
  console.error(`▸ ${MACOS_LICENCE}`);
  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(stamp, new Date().toISOString() + "\n");
  } catch {
    // A notice we cannot remember is a notice shown twice — never a failure
    // that stops a lab from starting.
  }
}

// ── Small helpers ──────────────────────────────────────────

/** Is this file the guest's installed VM disk? The image writes
 *  `$STORAGE/data.{img,raw,qcow2}` (`disk.sh`: DISK_NAME defaults to "data"),
 *  and the in-flight installer ISO lives in a `tmp/` subdirectory — so seeing
 *  one of these at the top level is what "this lab is already installed"
 *  means. Pure, because the answer decides whether we promise the operator a
 *  20-minute install or a 1-minute boot. */
export function isVmDisk(name: string): boolean {
  return /^data\.(img|raw|qcow2)$/.test(name);
}

/** Below this, `data.img` is a hole in the filesystem and nothing else.
 *  Measured: the file is created at its full nominal size (64 GB apparent) the
 *  moment QEMU starts and allocates ZERO blocks until an OS is written to it,
 *  while an installed Windows 11 allocates 15 GB. Existence is therefore not
 *  installation — and on macOS, where the install is manual and interruptible,
 *  the difference is a whole hour of somebody's afternoon. */
export const INSTALLED_MIN_BYTES = 256 * 1024 * 1024;

/** Is this an installed OS, or the empty file QEMU makes on its way to one?
 *  `cost` is `fileCost()`, i.e. allocated blocks. Pure. */
export function isInstalledDisk(name: string, cost: number): boolean {
  return isVmDisk(name) && cost >= INSTALLED_MIN_BYTES;
}

/** Is an installed OS in ANY of these directories? A list, because the macOS
 *  image keeps one per version (`diskDirs`) and looking only at the top level
 *  told every returning macOS operator to budget another hour. */
async function hasDisk(dirs: string[]): Promise<boolean> {
  for (const d of dirs) {
    try {
      for await (const e of Deno.readDir(d)) {
        if (!e.isFile || !isVmDisk(e.name)) continue;
        const cost = fileCost(await Deno.stat(join(d, e.name)));
        if (isInstalledDisk(e.name, cost)) return true;
      }
    } catch { /* absent, or raced */ }
  }
  return false;
}

/** What one file actually costs on disk. The VM disk is SPARSE: `data.img`
 *  reports its full 64 GB from the moment it is created while occupying a few
 *  GB, and a status line quoting that number would tell an operator with 100 GB
 *  free that they are out of room. Allocated blocks are the truth; apparent
 *  size is the fallback where the platform does not report them. Pure. */
export function fileCost(
  info: { size: number; blocks: number | null },
): number {
  return info.blocks !== null && info.blocks >= 0
    ? info.blocks * 512
    : info.size;
}

/** Everything the lab occupies, recursively — the in-flight installer ISO lives
 *  in a `tmp/` subdirectory while it downloads, and a status line that ignored
 *  it would report "0 B" while 8 GB was landing. */
async function diskSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) total += await diskSize(p);
      else if (e.isFile) {
        try {
          total += fileCost(await Deno.stat(p));
        } catch { /* raced */ }
      }
    }
  } catch { /* absent */ }
  return total;
}

/** Bytes → the unit a human reads. Pure. */
export function human(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
