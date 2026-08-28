# VM labs — a real Windows, macOS, Linux or Android guest, by hand

`am lab windows`, `am lab macos`, `am lab linux` and `am lab android` boot a
real guest in a container and give you a browser viewer to drive it with. The
app's `dist/` is handed to the guest — served at `http://<guest-name>:8007/` in
every lab, and for Linux and Android put into the guest more directly — so you
can install and run what you actually ship, on the OS you actually ship it to,
and look at it.

This is the **manual** tier. Nothing here is a gate, nothing here runs in
`deno task test`, and nothing here has an assertion in it. It exists for the
question the automated tiers cannot answer: _does the thing we ship look and
behave right over there?_

## The labs

|                       | what it runs                                           | who drives it              | needs                    | cost                                 |
| --------------------- | ------------------------------------------------------ | -------------------------- | ------------------------ | ------------------------------------ |
| `deno task test:wine` | the Windows `.exe` under Wine, headless                | CI, opt-in                 | wine                     | seconds; not in `check:release`      |
| `deno task lab`       | install → create → dev → compile in Ubuntu containers  | CI                         | docker                   | minutes                              |
| `am lab windows`      | a **real** Windows 11 desktop in QEMU+KVM (a VM)       | **a person, in a browser** | docker, KVM, tun, 45 GB  | ~30 min unattended install, once     |
| `am lab macos`        | a **real** macOS desktop in QEMU+KVM (a VM)            | **a person, in a browser** | docker, KVM, tun, 45 GB  | 60+ min, you drive the install, once |
| `am lab linux`        | a **real** Ubuntu XFCE desktop — a container, not a VM | **a person, in a browser** | docker (no KVM, no disk) | seconds                              |
| `am lab android`      | the Android 14 **emulator** + a noVNC viewer           | **a person, in a browser** | docker, KVM, an APK      | 1-3 min boot; `am` installs the APK  |

Rules of thumb:

- **Did the binary execute at all, and did the health endpoint answer?** →
  `test:wine`. It is a gate; keep it green.
- **Does a stranger's one-liner install work on a clean machine?** →
  `deno task lab` ([onboarding lab](onboarding-lab.md)).
- **Does the installer dialog look right, does SmartScreen block it, does the
  tray icon render, does the window chrome look wrong at 150% scaling?** →
  `am lab`. Those are eyes-only questions, and Wine answers none of them.
- **Does the AppImage mount and open on a desktop that is not yours, with a file
  picker, a tray, a window manager?** → `am lab linux`.
- **Does the APK install, ask its permissions, draw its first screen on a
  phone-shaped device?** → `am lab android`.

## Start one

The grammar is the same for all four — `am lab <os>` boots it, hands `dist/` in,
prints the viewer URL; `--status`, `--stop`, `--reset`, `--port=N` (default: a
free one — never a constant), `--dist=<dir>` and `--tunnel` mean the same thing
everywhere. Re-running `am lab <os>` on a lab that is already up is safe and
useful: it re-prints the hand-off, starts the artifact share if it went away —
and on Android, re-installs the APK.

```sh
# Windows — a VM; the first run installs Windows 11 unattended (~30 min)
am lab windows              # boot it, mount dist/, print the viewer URL
am lab windows --status     # up? on which port? how big is the disk?
am lab windows --stop       # shut the guest down cleanly, then remove it
am lab windows --reset      # DELETE the VM disk and start over
# VM-only knobs: --ram=8G --cpus=4 --disk=64G --version=11

# macOS — a VM; the first run is YOURS to drive (60+ min, see below)
am lab macos
am lab macos --version=15   # a second disk beside 14 — a second install

# Linux — a container, not a VM: no KVM, no disk, up in seconds
am lab linux                # an Ubuntu XFCE desktop; dist/ is /shared inside
am lab linux --ram=16G      # refused: a container has no guest RAM to set

# Android — the emulator; needs /dev/kvm and an APK in dist/
am lab android              # boots, waits for sys.boot_completed, adb-installs
am lab android --apk=myapp.apk   # which one, when dist/ holds several
am lab android --status     # up? booted? on which port?
```

Open the printed `http://127.0.0.1:<port>/` in a browser. That page is the
guest's screen, keyboard and mouse. It is bound to loopback on purpose: the
viewer has no password, and this guest should never face the LAN.

### The Android dev loop

The emulator is the one lab where `am` puts the build in itself, because the
container is the emulator's host and `adb` in there sees the device:

1. `am lab android` starts the container and polls
   `adb shell getprop sys.boot_completed` until it answers `1` — bounded at 5
   minutes, with a progress line every 15 s. A timeout names how to check
   (`--status` reports `booted: yes/no`), how to watch (`docker logs -f`) and
   the restart.
2. It then runs `adb install -r /shared/<file>.apk` and prints the result —
   `installed` in the JSON, the `INSTALL_FAILED_*` reason with its fix otherwise
   (an APK with no x86_64 native libraries is the likely one: the emulator is
   x86_64).
3. Rebuild, run `am lab android` again: `-r` replaces the installed copy. That
   is the whole loop — no restart, no uninstall, no drag-and-drop.

When `dist/` holds both the app APK (`<name>.apk`) and the remote client
(`<name>-client.apk`), the client is installed and the line says so, with the
`--apk=<name>.apk` that picks the other. `<name>-unsigned.apk` is never a
candidate — it cannot be installed. The emulator's own browser can also open the
share at `http://10.0.2.2:8007/` (the emulator's fixed alias for its host).

### Linux: FUSE, and a directory that is simply there

`am lab linux` runs `lscr.io/linuxserver/webtop:ubuntu-xfce` — a real XFCE
desktop served to the browser. Because the container **is** the guest, the
bind-mounted `dist/` is a plain local directory inside it, `/shared`, and the
hand-off is a copy rather than a download:

```sh
cp /shared/myapp-x64.AppImage ~/ && chmod +x ~/myapp-x64.AppImage && ~/myapp-x64.AppImage
```

An AppImage mounts itself through **FUSE**, which a default container cannot do,
so the lab starts it with `--device=/dev/fuse`, `--cap-add=SYS_ADMIN` and
`--security-opt=apparmor:unconfined` (plus `--shm-size=1g` for the browser
inside). The desktop runs as your uid/gid (`PUID`/`PGID`), so anything it writes
into `/shared` is yours. An AppImage wins over the bare `<name>` /
`<name>-linux` binary when both are there; anything `-arm64` is named as
wrong-arch, as on macOS. There is no VM disk: `--stop` discards the container
and `--reset` has nothing beyond that to delete.

## The artifact hand-off

Every lab hands the build over the **same way**: the app's `dist/` on your
machine, served read-only inside the lab container, on port **8007**, reached by
the name that guest resolves — `host.lan` in the two VMs, `localhost` in the
Linux desktop, `10.0.2.2` in the emulator:

```
http://host.lan:8007/
```

For the VMs that is the bridge address the image's own dnsmasq answers with; for
the containers it is their own loopback. `am` starts it, checks it answers, and
prints the command to paste — naming the actual file it found:

```sh
# macOS guest, in Terminal
cd ~/Downloads && curl -fLO http://host.lan:8007/myapp-macos && chmod +x myapp-macos && ./myapp-macos

# Windows guest, in PowerShell
cd $HOME\Downloads; curl.exe -fLO http://host.lan:8007/myapp-windows.exe; .\myapp-windows.exe

# Linux guest, in Terminal — /shared is local, so a copy, not a download
cp /shared/myapp-x64.AppImage ~/ && chmod +x ~/myapp-x64.AppImage && ~/myapp-x64.AppImage

# Android — am runs this for you, after the emulator reports booted
docker exec aio-lab-android adb install -r /shared/myapp.apk
```

Nothing to set up in the guest: `host.lan` is the image's own dnsmasq record,
handed to the guest by the same DHCP lease that gives it its address. Nothing is
published to your machine either — the host already has the directory, so the
share exists only on the guest's network. The mount is **live**: rebuild on the
host and the new file is there, no restart, no copy.

Verified by typing it in: a real Windows 11 desktop and a real macOS Sonoma one
both fetch the host's `dist/` over that URL.

Two things `am` will tell you rather than let you find out inside the VM:

- **Nothing this guest can run.** Every lab guest is **x86_64**, so a
  `-macos-arm64` binary or an `-arm64.AppImage` cannot run in it at all. If that
  is all `dist/` holds, the lab says so and names the build that fixes it
  (`deno task build --platforms=macos`, `--platforms=linux`) instead of handing
  you a command that ends in `Bad CPU type in executable`.
- **The share is not up.** The image builds the guest's network _after_ the
  installer download, so on a first run there is no share yet. `am lab <os>` on
  a lab that is already running brings it back and re-prints the command — that
  is also the fix after a `docker restart`.

`am lab <os> --status` reports whether the share is serving **and the last fetch
the guest made** — the only evidence that `host.lan` really resolves in there.

### The per-OS extras

- **Windows** can also mount it: **`\\host.lan\Data`** (the image runs Samba).
  Paste that into Explorer's address bar, or `net use Z: \\host.lan\Data`. If
  the name does not resolve, open `\\host.lan` on its own first. Copy the `.exe`
  out of the share before running it — running straight off a network share is a
  more restricted Windows code path than the one your users are on. The HTTP
  share avoids that entirely, which is why it is the one printed first.
- **macOS** has no mount and cannot have one: Apple ships no 9p client and the
  `dockurr/macos` image ships no smbd. `http://host.lan:8007/` is the hand-off,
  and it is the whole of it.
- **macOS and Gatekeeper.** `curl` does **not** set the `com.apple.quarantine`
  flag; Safari does. If the question is "what does a user actually see when they
  download this", open `http://host.lan:8007/` in Safari inside the guest
  instead of pasting the curl line.
- **Linux** sees the directory at `/shared`, live, and the printed line is a
  `cp` out of it; the http share is still up for the desktop's browser.
- **Android** cannot mount it; `am` installs over `adb`, and the emulator's
  browser reaches the share at `http://10.0.2.2:8007/`.

## What it costs, plainly

The two container labs cost nothing beyond the image pull (~1.5 GB for the
desktop, ~3 GB for the emulator): no disk survives `--stop`, and the preflight
has no space floor for them. Everything below is about the two VMs.

The VM disk lives in `~/.cache/aio/labs/<os>/storage/` (or
`$XDG_CACHE_HOME/aio/labs/<os>/storage/`) and **survives `--stop`**. That is the
point: the first start installs an operating system, every later start is a
boot. Measured on the same machine: `--stop` returned in **7 s**, the next start
served the viewer in **4 s** and reached the Windows desktop in **~60 s**, with
no repair cycle — which is what the 120-second graceful stop timeout buys.

- A Windows 11 install downloads an **~8.5 GB** installer and writes the
  installed disk beside it, so it peaks around **20 GB** during Setup; the
  installer is deleted afterwards, leaving **12 GB** measured on a clean
  Windows 11. It grows as you use the guest, so budget **40 GB**.
  `am lab windows --status` prints the current size — allocated blocks, so the
  sparse 64 GB `data.img` is reported at what it actually costs, not at its
  nominal size.
- A macOS install starts with a **753 MB** recovery image (measured, Sonoma),
  and then you install macOS onto the disk from it — budget the same **40 GB**.
  The macOS image keeps **one disk per version**, at
  `storage/<version>/data.img`, so `--version=15` beside an installed `14` is a
  second operating system from scratch, not a boot. `am lab macos` warns before
  it does that and names the version you already have; `--status` lists them.
- "The disk exists" is not "the OS is installed": QEMU creates `data.img` at its
  full nominal size with **zero** blocks allocated and fills it as the install
  runs. The lab counts a disk as installed only once it has real blocks in it,
  so an interrupted macOS install is still told it is a first run.
- `--reset` deletes that directory. There is no undo, and the next start
  reinstalls the OS from scratch — every version of it, for macOS.
- The preflight refuses below 25 GB free and warns below 45 GB. If your `$HOME`
  is small, put the cache somewhere else:
  `export XDG_CACHE_HOME=/mnt/big/cache`.

## First run, honestly

- **Windows** downloads (~~8.5 GB) and then installs **unattended** — you never
  touch Setup. Measured end to end on this machine (Ryzen 9950X, KVM, 8 GB / 4
  cores to the guest): viewer serving at **+40 s**, download done at **+21
  min**, first boot off the installed disk at **+26 min**, usable desktop at
  **~~+30 min**. On a slower link the download is the whole story.
- **macOS** is **not** unattended. Measured on the same machine: the 753 MB
  recovery image downloaded and the guest reached the **macOS Recovery** screen
  about **4 minutes** after `am lab macos`. Everything after that is yours to
  click, in the viewer:

  1. **Disk Utility** → select `QEMU HARDDISK Media` → **Erase** → format
     **APFS**, name it whatever you like → **Done** → quit Disk Utility.
  2. **Reinstall macOS Sonoma** → agree → pick the disk you just erased.
  3. Wait. It reboots itself several times; leave it alone. Budget an hour.
  4. Skip through Setup Assistant (an Apple ID is not needed).

  The artifact share is already up while you do all that — Recovery even has a
  Terminal (Utilities → Terminal) that can `curl http://host.lan:8007/`, which
  is a quick way to prove the hand-off before committing to the install.

`am lab` never sits silent through that. It polls the container and prints the
phase it is in (`Downloading Windows 11...`, `Booting Windows using QEMU...`) as
it changes, hands you the viewer URL the moment the page serves, and then tells
you roughly how long the rest takes. Watch the raw stream any time with
`docker logs -f aio-lab-windows`.

## Preflight

Every refusal names the cause and the exact command that fixes it. The lab never
forwards a raw docker error.

| refused because         | the fix it prints                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| no `docker` on PATH     | `sudo apt install -y docker.io` (or the Docker install docs)                                                      |
| docker socket denied    | `sudo usermod -aG docker $USER` + `newgrp docker`                                                                 |
| daemon down             | `sudo systemctl start docker`                                                                                     |
| no `/dev/kvm`           | enable AMD-V/VT-x in BIOS; `sudo modprobe kvm_amd` (or nested virt) — VMs and Android only; Linux runs without it |
| `/dev/kvm` not writable | `sudo setfacl -m u:$USER:rw /dev/kvm`                                                                             |
| no `/dev/net/tun`       | `sudo modprobe tun` — the two VMs only                                                                            |
| image not pulled        | `docker pull <image>` — for `dockurr/*` note the **double r**; `dockur/*` does not exist                          |
| under 25 GB free        | free space, `--reset` an old lab, or `export XDG_CACHE_HOME=…` — the two VMs only                                 |

A container lab refuses a VM knob (`--ram`, `--cpus`, `--disk`, `--version`)
outright rather than ignore it: a flag that silently did nothing is the shape of
bug the preflight exists to remove.

There is one more that is not a docker error and looks exactly like a hang: the
viewer serves **inside** the container but the host cannot reach the published
port, because a firewall sits between the host and the docker bridge.
`docker
run -p` binds happily and then swallows every byte, so a browser shows a
connection that opens and never answers — indistinguishable from "still
booting". The lab detects it (it curls the viewer from inside the container) and
says so. Confirm the host is the fault, not aio:

```sh
docker run --rm -d -p 127.0.0.1:18099:80 --name nt nginx:alpine
curl -m3 http://127.0.0.1:18099/    # no answer here = every published port on
docker rm -f nt                      #   this machine is dead, aio or not
```

The real fix is the host's docker networking (its `DOCKER-USER`/`FORWARD`
rules). The workaround is `--tunnel`:

```sh
am lab windows --tunnel     # publishes nothing; holds the viewer open
```

`--tunnel` publishes no port at all. `am` binds the port itself and forwards
each connection through `docker exec … nc 127.0.0.1 8006` — a stream the docker
daemon serves directly, so it works wherever docker does. It needs no second
image, no extra capability and nothing installed on the host, and the guest's
own networking is untouched. **That process is the tunnel**: leave it running
and Ctrl-C when you are done. The VM keeps running either way — stop it with
`--stop`. `am lab <os> --tunnel` on a lab that is already up just opens a fresh
tunnel to it.

`--network host` is _not_ an option here: the VM images refuse it outright
("ERROR: This container does not support host mode networking!").

## macOS licensing

Apple's software licence permits running macOS in a virtual machine only on
Apple-branded hardware. `am lab macos` prints that as a one-line notice the
first time you start it on a machine, and then never again — it is a local
testing lab, and it is not a supported CI path. `--reset` makes the notice
appear once more, since it throws the whole guest away.

## Under the hood

Thin wrappers over four images, one row of `LAB_SPECS` each — every per-OS
difference is a field of that row, never a branch elsewhere:

| lab       | image                                                                                         | kind      | viewer port | needs              |
| --------- | --------------------------------------------------------------------------------------------- | --------- | ----------- | ------------------ |
| `windows` | [`dockurr/windows`](https://github.com/dockur/windows)                                        | VM        | 8006        | KVM, tun, a disk   |
| `macos`   | [`dockurr/macos`](https://github.com/dockur/macos)                                            | VM        | 8006        | KVM, tun, a disk   |
| `linux`   | [`lscr.io/linuxserver/webtop:ubuntu-xfce`](https://docs.linuxserver.io/images/docker-webtop/) | container | 3000        | FUSE for AppImages |
| `android` | [`budtmo/docker-android:emulator_14.0`](https://github.com/budtmo/docker-android)             | container | 6080        | KVM                |

For the VMs the lab adds `--device /dev/kvm`, `--device /dev/net/tun`,
`--cap-add NET_ADMIN`, a 120-second stop timeout (a guest killed mid-write comes
back dirty and repairs itself while you watch), the two volumes, and a loopback
port publish. For the containers: the `/shared` volume only, the image's own
extras (`--shm-size`, FUSE, `PUID`/`PGID`, `EMULATOR_DEVICE`, `WEB_VNC`), and
the same loopback publish of their own viewer port.

The artifact share is one more `docker exec`: a Python file server on container
port **8007**, bound to the address in the image's own `/run/shm/qemu.gw` — the
guest-facing bridge, and the same address its dnsmasq answers `host.lan` with.
So the share is reachable from the guest and from nowhere else: not from your
machine, not from other containers. It needs no second image, no extra
capability and nothing installed on the host, and it leaves the guest's own
networking untouched — the same properties that make `--tunnel` work.

Ports, in one place: the viewer is the image's own (**8006**, **3000**, **6080**
— published to `127.0.0.1` on a free port, or tunnelled), **8007** is the
artifact share (never published). Every lab, the same share port.

Everything shaped like a decision — the argv, the disk path, each preflight
refusal, the flag grammar, which artifact is picked, when the emulator counts as
booted and what an `adb install` result means — is a pure function in
`src/am/am-cmd-lab.ts` and is tested without a VM in `tests/am-lab.test.ts`. The
one test that boots a real guest is behind `AIO_VM_LAB=1` and is not part of
`deno task test`.
