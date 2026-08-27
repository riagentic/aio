# VM labs — a real Windows or macOS desktop, by hand

`am lab windows` and `am lab macos` boot a real guest OS in a container and give
you a browser viewer to drive it with. The app's `dist/` is handed to the guest
at `http://host.lan:8007/` — the same URL in both labs — so you can install and
run what you actually ship, on the OS you actually ship it to, and look at it.

This is the **manual** tier. Nothing here is a gate, nothing here runs in
`deno task test`, and nothing here has an assertion in it. It exists for the
question the automated tiers cannot answer: _does the thing we ship look and
behave right over there?_

## Which of the three do I want

|                         | what it runs                                          | who drives it              | cost                                 |
| ----------------------- | ----------------------------------------------------- | -------------------------- | ------------------------------------ |
| `deno task test:wine`   | the Windows `.exe` under Wine, headless               | CI                         | seconds; part of `test:build`        |
| `deno task lab`         | install → create → dev → compile in Ubuntu containers | CI                         | minutes                              |
| `am lab windows\|macos` | a **real** Windows/macOS desktop in QEMU+KVM          | **a person, in a browser** | tens of minutes and tens of GB, once |

Rules of thumb:

- **Did the binary execute at all, and did the health endpoint answer?** →
  `test:wine`. It is a gate; keep it green.
- **Does a stranger's one-liner install work on a clean machine?** →
  `deno task lab` ([onboarding lab](onboarding-lab.md)).
- **Does the installer dialog look right, does SmartScreen block it, does the
  tray icon render, does the window chrome look wrong at 150% scaling?** →
  `am lab`. Those are eyes-only questions, and Wine answers none of them.

## Start one

```sh
am lab windows              # boot it, mount dist/, print the viewer URL
am lab windows --status     # up? on which port? how big is the disk?
am lab windows --stop       # shut the guest down cleanly, then remove it
am lab windows --reset      # DELETE the VM disk and start over
```

Flags: `--port=N` (default: a free one — never a constant), `--ram=8G`,
`--cpus=4`, `--disk=64G`, `--version=11`, `--dist=<dir>`, `--tunnel`.

Open the printed `http://127.0.0.1:<port>/` in a browser. That page is the
guest's screen, keyboard and mouse. It is bound to loopback on purpose: the
viewer has no password, and this VM should never face the LAN.

Running `am lab <os>` on a lab that is already up is safe and useful: it starts
the artifact share if it went away and re-prints the command to paste.

## The artifact hand-off

Both labs hand the build over the **same way**, with the same URL:

```
http://host.lan:8007/
```

That is the app's `dist/` on your machine, served read-only inside the lab
container on the guest-facing bridge. `am` starts it, checks it answers, and
prints the command to paste — naming the actual file it found:

```sh
# macOS guest, in Terminal
cd ~/Downloads && curl -fLO http://host.lan:8007/myapp-macos && chmod +x myapp-macos && ./myapp-macos

# Windows guest, in PowerShell
cd $HOME\Downloads; curl.exe -fLO http://host.lan:8007/myapp-windows.exe; .\myapp-windows.exe
```

Nothing to set up in the guest: `host.lan` is the image's own dnsmasq record,
handed to the guest by the same DHCP lease that gives it its address. Nothing is
published to your machine either — the host already has the directory, so the
share exists only on the guest's network. The mount is **live**: rebuild on the
host and the new file is there, no restart, no copy.

Verified by typing it in: a real Windows 11 desktop and a real macOS Sonoma one
both fetch the host's `dist/` over that URL.

Two things `am` will tell you rather than let you find out inside the VM:

- **Nothing this guest can run.** Both lab guests are QEMU **x86_64**, so an
  `-macos-arm64` artifact cannot run in the macOS lab at all. If that is all
  `dist/` holds, the lab says so and names the build that fixes it
  (`deno task build --platforms=macos`) instead of handing you a command that
  ends in `Bad CPU type in executable`.
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

## What it costs, plainly

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

| refused because         | the fix it prints                                                                |
| ----------------------- | -------------------------------------------------------------------------------- |
| no `docker` on PATH     | `sudo apt install -y docker.io` (or the Docker install docs)                     |
| docker socket denied    | `sudo usermod -aG docker $USER` + `newgrp docker`                                |
| daemon down             | `sudo systemctl start docker`                                                    |
| no `/dev/kvm`           | enable AMD-V/VT-x in BIOS; `sudo modprobe kvm_amd` (or nested virt)              |
| `/dev/kvm` not writable | `sudo setfacl -m u:$USER:rw /dev/kvm`                                            |
| no `/dev/net/tun`       | `sudo modprobe tun`                                                              |
| image not pulled        | `docker pull dockurr/windows` — note the **double r**; `dockur/*` does not exist |
| under 25 GB free        | free space, `--reset` an old lab, or `export XDG_CACHE_HOME=…`                   |

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

`--network host` is _not_ an option here: both images refuse it outright
("ERROR: This container does not support host mode networking!").

## macOS licensing

Apple's software licence permits running macOS in a virtual machine only on
Apple-branded hardware. `am lab macos` prints that as a one-line notice the
first time you start it on a machine, and then never again — it is a local
testing lab, and it is not a supported CI path. `--reset` makes the notice
appear once more, since it throws the whole guest away.

## Under the hood

Thin wrappers over [`dockurr/windows`](https://github.com/dockur/windows) and
[`dockurr/macos`](https://github.com/dockur/macos) — QEMU with KVM, a browser
viewer on container port 8006. The lab adds `--device /dev/kvm`,
`--device /dev/net/tun`, `--cap-add NET_ADMIN`, a 120-second stop timeout (a
guest killed mid-write comes back dirty and repairs itself while you watch), the
two volumes, and a loopback port publish.

The artifact share is one more `docker exec`: a Python file server on container
port **8007**, bound to the address in the image's own `/run/shm/qemu.gw` — the
guest-facing bridge, and the same address its dnsmasq answers `host.lan` with.
So the share is reachable from the guest and from nowhere else: not from your
machine, not from other containers. It needs no second image, no extra
capability and nothing installed on the host, and it leaves the guest's own
networking untouched — the same properties that make `--tunnel` work.

Ports, in one place: **8006** is the viewer (published to `127.0.0.1` on a free
port, or tunnelled), **8007** is the artifact share (never published). Both
labs, same numbers.

Everything shaped like a decision — the argv, the disk path, each preflight
refusal, the flag grammar — is a pure function in `src/am/am-cmd-lab.ts` and is
tested without a VM in `tests/am-lab.test.ts`. The one test that boots a real
guest is behind `AIO_VM_LAB=1` and is not part of `deno task test`.
