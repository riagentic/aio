#!/bin/sh
# aio — run any aio app from source with ONE line. No questions asked.
#
#   In an aio app repo:      curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh
#   Dev instead of prod:     curl -fsSL .../run.sh | sh -s -- --dev
#   From a repo link:        curl -fsSL .../run.sh | sh -s owner/repo
#                            curl -fsSL .../run.sh | sh -s https://github.com/owner/repo
#
# What it does, in order: ensure git + deno + aio/am are installed AND current
# (install.sh runs every time — it updates am in place), clone the repo if one was given,
# `am fix` whatever the checkout needs, then PRODUCTION-build the app's default
# target and run the artifact (`--dev` runs the dev server instead).
# Args after `--` are passed to the app itself.
#
# Flags: --dev · --git <url> · --no-run (build only) · --no-install (run from
#        dist/ instead of installing) · -- <app args…>
# Installs to ~/app/<name>/ by default (AIO_INSTALL_ROOT overrides), with a
# stable symlink beside the versioned file, a .desktop entry for GUI clients
# and a ~/.local/bin symlink for headless ones.
# Env:   AIO_HOME / AIO_REPO / AIO_BRANCH (as install.sh) ·
#        AIO_RAW (raw base for fetching install.sh) ·
#        AIO_INSTALL (local install.sh path — offline/tests)
# Windows: use run.ps1 (`irm .../run.ps1 | iex`).
# macOS: a desktop (Electron) app is installed as its bundle —
#        ~/app/<name>/versions/<version>/<Title>.app, linked from
#        ~/app/<name>/<Title>.app — and opened with `open`. Never into
#        /Applications (the app offers that move itself), and no .desktop
#        entry: that is a Linux convention.
#
# `set -u`: with $HOME unset every `$HOME/...` path below silently becomes a
# path under the filesystem root. Fail instead.
set -eu

[ -n "${HOME:-}" ] || {
  printf "\033[31m✗\033[0m %s\n" "\$HOME is not set, so there is nowhere to install to. Set it (export HOME=/home/you) and re-run." >&2
  exit 1
}

AIO_HOME="${AIO_HOME:-$HOME/.local/lib/aio}"
AIO_BRANCH="${AIO_BRANCH:-main}"
AIO_RAW="${AIO_RAW:-https://raw.githubusercontent.com/riagentic/aio/$AIO_BRANCH}"

# ── How this script talks ────────────────────────────────────────────────
# The SAME vocabulary the framework uses everywhere else (src/diagnostics/
# fmt.ts): `·` a step, `✓` something that now exists, `!` an advisory, `✗` a
# refusal — warnings and refusals on stderr, so `installer 2>/dev/null` keeps
# working and a wrapper can tell output from trouble.
#
# And the SAME colour rule, which this script did not have: it painted escapes
# into every pipe, log file and CI transcript unconditionally. FORCE_COLOR
# wins, NO_COLOR (https://no-color.org) turns it off, otherwise colour only
# when stdout is a terminal.
if [ -n "${FORCE_COLOR:-}" ]; then _color=1
elif [ -n "${NO_COLOR:-}" ]; then _color=0
elif [ -t 1 ]; then _color=1
else _color=0
fi
if [ "$_color" = 1 ]; then
  bold="\033[1m"; dim="\033[2m"; cyan="\033[36m"; green="\033[32m"
  red="\033[31m"; yellow="\033[33m"; reset="\033[0m"
else
  bold=""; dim=""; cyan=""; green=""; red=""; yellow=""; reset=""
fi
info() { printf "${dim}·${reset} %s\n" "$1"; }
ok()   { printf "${green}✓${reset} %s\n" "$1"; }
warn() { printf "${yellow}!${reset} %s\n" "$1" >&2; }
fail() { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────
DEV=0; NO_RUN=0; NO_INSTALL=0; GIT_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) DEV=1 ;;
    --no-run) NO_RUN=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --git) shift; GIT_URL="${1:-}"; [ -n "$GIT_URL" ] || fail "--git needs a URL" ;;
    --git=*) GIT_URL="${1#--git=}" ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (flags: --dev, --git <url>, --no-run, --no-install, -- <app args>)" ;;
    *) [ -n "$GIT_URL" ] && fail "unexpected argument: $1"; GIT_URL="$1" ;;
  esac
  shift
done
# Everything left in "$@" is forwarded to the app.

# ── prerequisites: git, deno, aio+am (install.sh owns the how) ───────
command -v git >/dev/null 2>&1 || fail "git is required — install git and re-run"

# am may live in a deno bin dir that isn't on PATH yet.
export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
PATH="$DENO_INSTALL/bin:$HOME/.deno/bin:${DENO_INSTALL_ROOT:-$HOME/.deno}/bin:$PATH"
export PATH

# Is the deno on this box new enough for the framework we are about to build
# with? Existence was the only question this script used to ask, so a machine
# with an old deno went all the way to a failing BUILD, whose error described a
# syntax or API problem rather than the version behind it. The required version
# comes from the framework itself (one decider, `src/server/deno-version.ts`);
# an empty answer means we have no checkout yet, which the install step below
# is about to fix.
deno_ok() {
  command -v deno >/dev/null 2>&1 || return 1
  _want=$(sed -n 's/.*MIN_DENO = "\([^"]*\)".*/\1/p' \
    "$AIO_HOME/src/server/deno-version.ts" 2>/dev/null | head -1)
  [ -n "$_want" ] || return 0   # nothing to compare against yet
  _have=$(deno --version 2>/dev/null | head -1 | awk '{print $2}')
  _h="${_have%%[-+]*}"; _w="${_want%%[-+]*}"
  _hM="${_h%%.*}"; _hr="${_h#*.}"; _hm="${_hr%%.*}"; _hp="${_hr#*.}"
  _wM="${_w%%.*}"; _wr="${_w#*.}"; _wm="${_wr%%.*}"; _wp="${_wr#*.}"
  case "$_hM$_hm$_hp$_wM$_wm$_wp" in *[!0-9]*) return 1 ;; esac
  [ "$_hM" -ne "$_wM" ] && { [ "$_hM" -gt "$_wM" ]; return; }
  [ "$_hm" -ne "$_wm" ] && { [ "$_hm" -gt "$_wm" ]; return; }
  [ "$_hp" -ge "$_wp" ]
}

# ALWAYS, not only when something is missing. This block used to run only when
# deno/am/the checkout was absent — so a box that had installed aio once kept
# that am forever: the one-liner said "am ready" with a months-old framework,
# `am fix` repaired with rules that had since been fixed, and the build ran on
# whatever that old am linked. install.sh is idempotent (fetch, check out the
# latest tag, reinstall am; a failed fetch keeps what is there; a DEV checkout
# — on a branch, or with local changes — is never git-mutated), and the
# framework the APP builds with is still its own pin — updating am never moves
# an app. There is no reason to run the newest installer and keep the oldest am.
if deno_ok && command -v am >/dev/null 2>&1 && [ -d "$AIO_HOME/.git" ]; then
  info "updating aio + am (already installed)..."
else
  info "setting up aio (deno + framework + am)..."
fi
if [ -n "${AIO_INSTALL:-}" ]; then
  sh "$AIO_INSTALL" || fail "install failed ($AIO_INSTALL)"
else
  # DOWNLOAD, THEN RUN. `curl … | sh || fail` cannot detect a failure: in a
  # POSIX pipeline the exit status is the LAST command's — `sh`'s — and there
  # is no `pipefail` in /bin/sh. A 404, a dropped connection, an empty body:
  # `sh` reads nothing, exits 0, `|| fail` never fires, and run.sh went on to
  # announce "updating aio + am" having installed nothing at all. The
  # truncation case is worse still and is handled on install.sh's own side
  # (its body is wrapped in `main()`), but a status we can actually read
  # belongs here.
  _installer="${TMPDIR:-/tmp}/aio-install.$$.sh"
  curl -fsSL "$AIO_RAW/install.sh" -o "$_installer" \
    || { rm -f "$_installer"; fail "could not download the installer from $AIO_RAW/install.sh — check the network, or set AIO_RAW/AIO_BRANCH"; }
  [ -s "$_installer" ] \
    || { rm -f "$_installer"; fail "the installer downloaded from $AIO_RAW/install.sh is EMPTY — refusing to run it"; }
  if sh "$_installer"; then
    rm -f "$_installer"
  else
    _rc=$?
    rm -f "$_installer"
    fail "install failed ($AIO_RAW/install.sh, exit $_rc)"
  fi
fi
PATH="$DENO_INSTALL/bin:$HOME/.deno/bin:${DENO_INSTALL_ROOT:-$HOME/.deno}/bin:$PATH"
export PATH
hash -r 2>/dev/null || :
command -v deno >/dev/null 2>&1 || fail "deno still not found after install"
command -v am >/dev/null 2>&1 || fail "am still not found after install"
# install.sh owns the upgrade; if the box STILL has an old deno, say so here
# rather than failing later inside a build with an unrelated-looking error.
deno_ok || fail "deno $(deno --version | head -1 | awk '{print $2}') is older than this framework requires — install.sh could not upgrade it. Run: curl -fsSL https://deno.land/install.sh | sh"
ok "deno $(deno --version | head -1 | awk '{print $2}') · am ready"

# ── clone (when a repo was given) ────────────────────────────────────
if [ -n "$GIT_URL" ]; then
  case "$GIT_URL" in
    http://*|https://*|git@*|ssh://*|file://*|/*|./*|../*) : ;;
    */*) GIT_URL="https://github.com/$GIT_URL" ;;  # owner/repo shorthand
    *) fail "not a git URL or owner/repo: $GIT_URL" ;;
  esac
  name=$(basename "$GIT_URL" .git)
  if [ -d "$name/.git" ]; then
    info "updating existing clone ./$name"
    git -C "$name" pull --ff-only 2>/dev/null \
      || info "pull skipped (local changes or diverged) — running what's there"
  elif [ -e "$name" ]; then
    fail "./$name exists and is not a git clone — move it or cd elsewhere"
  else
    info "cloning $GIT_URL → ./$name"
    git clone -q "$GIT_URL" "$name" || fail "git clone failed — check the URL"
  fi
  cd "$name"
fi

# ── sanity: is this an aio app? ──────────────────────────────────────
[ -f deno.json ] || [ -f deno.jsonc ] || fail "no deno.json here — not an aio app ($(pwd))"
CFG=deno.json; [ -f deno.json ] || CFG=deno.jsonc
is_aio=$(deno eval "
  const t = Deno.readTextFileSync('$CFG');
  const c = JSON.parse(t.replace(/^\\s*\\/\\/.*$/gm, ''));
  const imports = c.imports ?? {};
  console.log('aio' in imports || 'aioVersion' in c ? 'yes' : 'no');
" 2>/dev/null || echo no)
[ "$is_aio" = "yes" ] || fail "$(pwd) doesn't look like an aio app (no \"aio\" import in $CFG). Scaffold one with: am create my-app"

# ── repair: whatever the checkout needs (import paths, env, config…) ──
info "am fix (checking the checkout)..."
am fix || info "am fix reported issues it couldn't auto-repair — continuing"

# ── dev: just run the dev server ─────────────────────────────────────
has_task() {
  deno eval "
    const t = Deno.readTextFileSync('$CFG');
    const c = JSON.parse(t.replace(/^\\s*\\/\\/.*$/gm, ''));
    console.log((c.tasks ?? {})['$1'] ? 'yes' : 'no');
  " 2>/dev/null || echo no
}
# Heap ceiling for this machine: 25% of RAM, never below 4 GB (V8's default,
# which is ~4 GB whatever the machine — the reason an app died of "out of
# memory" on a 32 GB box with 28 GB free). V8 fixes the ceiling at startup, so
# only a launcher can set it; the framework owns the RULE, this just asks.
# A compiled artifact bakes its own at build time and ignores DENO_V8_FLAGS,
# so this applies to the dev path.
if [ -z "${DENO_V8_FLAGS:-}" ] && [ -r /proc/meminfo ]; then
  _kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  _mb=$((_kb / 1024 / 4))
  [ "$_mb" -lt 4096 ] && _mb=4096
  [ "$_kb" -gt 0 ] && export DENO_V8_FLAGS="--max-old-space-size=$_mb"
fi

if [ "$DEV" = 1 ]; then
  if [ "$(has_task dev)" = "yes" ]; then
    info "dev run: deno task dev $*"
    exec deno task dev "$@"
  fi
  info "dev run: deno run -A src/app.ts $*"
  exec deno run -A src/app.ts "$@"
fi

# ── prod: build the default target, then run the artifact ────────────
# The artifact is found by TIME, not by name: everything executable that the
# build created after this marker is a candidate. That way this script never
# re-implements the framework's binary-naming rules (and never goes stale).
#
# The marker lives OUTSIDE the app: an untracked file in the tree is a change
# to the build (src/server/app-version.ts), so a marker beside deno.json
# stamped every build of a clean checkout `-dirty.<hash>` — a new hash each
# run, its name holding this shell's pid. Measured on macOS 14: six runs of
# one commit installed six versions.
marker=$(mktemp "${TMPDIR:-/tmp}/aio-run-marker.XXXXXX") \
  || fail "could not create a temp file in ${TMPDIR:-/tmp}"
trap 'rm -f "$marker"' EXIT INT TERM

info "production build (default target)..."
# The builder that BUILT this app is also the one that answers questions about
# it (below: where it installs). The app's own pin wins over whatever aio is
# installed on this machine — that is the exact-pin invariant, and asking two
# different builders is how the installer and `am remove` come to disagree.
# if/else, not `[ … ] && builder=…`: under `set -e` an AND-list whose test
# FAILS is itself a failing command, so the one-liner would end here on every
# app that has no dep/aio link — the majority.
if [ -f dep/aio/src/build.ts ]; then
  builder="dep/aio/src/build.ts"
else
  builder="$AIO_HOME/src/build.ts"
fi
if [ "$(has_task compile)" = "yes" ]; then
  deno task compile || fail "build failed — the output above says why"
elif [ -f dep/aio/src/build.ts ]; then
  # Hand-rolled app without the scaffolded task, but WITH a framework link:
  # build with the version the app pins (am fix just pointed dep/aio at it),
  # never with whatever aio happens to be installed on this machine.
  deno run -A dep/aio/src/build.ts --compile || fail "build failed"
else
  info "no compile task and no dep/aio link — building with the installed aio"
  deno run -A "$AIO_HOME/src/build.ts" --compile || fail "build failed"
fi

# Newest executable created by the build: AppImage first (electron), then a
# plain binary — in the app root, dist/ or dist/AppDir/ (the targets' homes).
artifact=""
oldIFS=$IFS; IFS='
'
for f in $(find . -maxdepth 3 -type f -newer "$marker" 2>/dev/null); do
  [ -x "$f" ] || continue
  case "$f" in
    */node_modules/*|*.log|*.sh|*.ts|*.js|*.json|*"$marker") continue ;;
  esac
  case "$f" in
    *.AppImage) artifact="$f"; break ;;
    *) [ -z "$artifact" ] && artifact="$f" ;;
  esac
done
# macOS: a desktop build ships no executable FILE. Its artifacts are the .dmg
# and `<name>-mac-<arch>.app.tar.gz` — the signed bundle, the same file an
# installed copy updates itself from — so that tarball is what gets installed.
# Looked for on Darwin only: everywhere else the search above is the whole rule.
os=$(uname -s)
mac_app=""
if [ "$os" = "Darwin" ]; then
  for f in $(find . -maxdepth 3 -type f -name '*.app.tar.gz' -newer "$marker" 2>/dev/null); do
    case "$f" in */node_modules/*) continue ;; esac
    mac_app="$f"; artifact="$f"; break
  done
fi
IFS=$oldIFS
[ -n "$artifact" ] || fail "build finished but no runnable artifact appeared — run 'deno task compile' by hand to see why"
rm -f "$marker"; trap - EXIT INT TERM

# A GUI client on a box with no display never comes up: electron either hangs
# or dies with someone else's error ("/usr/bin/env: 'node': No such file"),
# which says nothing about the actual problem. `am start` has refused this for
# a while; run.sh — the path a stranger is most likely to take, on the kind of
# machine most likely to be headless (a server, a container, CI) — did not, so
# the one-liner ended in a message about node on an app that never mentioned
# node. Same rule, same fix, stated here.
eff_client=""
for _a in "$@"; do
  case "$_a" in --client=*) eff_client="${_a#--client=}" ;; esac
done
if [ -z "$eff_client" ]; then
  eff_client=$(deno eval "
    try {
      const t = Deno.readTextFileSync('$CFG');
      const c = JSON.parse(t.replace(/^\\s*\\/\\/.*\$/gm, ''));
      console.log(c.client ?? c.target ?? 'electron');
    } catch { console.log('electron'); }
  " 2>/dev/null || echo electron)
fi
# …only when we are about to RUN it. `--no-run` asks for a BUILD, and a build
# needs no display — refusing there would break every CI job that packages a
# desktop app, which is precisely where builds happen and displays do not.
if [ "$NO_RUN" != 1 ] && [ "$(uname -s)" = "Linux" ] \
  && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  case "$eff_client" in
    electron|client)
      fail "this app's client is \"$eff_client\" and this machine has no display (no DISPLAY / WAYLAND_DISPLAY).
  Electron cannot open a window here, so the app would hang or die with an unrelated error.
  Serve the same UI over HTTP instead:
    curl -fsSL <this-url> | sh -s -- -- --client=browser --port=8080
  or, if you already have the checkout:
    ./<artifact> --client=browser --port=8080"
      ;;
  esac
fi

ok "built $artifact"

# ── install: put the artifact where it OUTLIVES the checkout ─────────
#
# Until now the one-liner ran the build in place, out of `dist/`. So the app
# lived inside the repo it was built from: delete the clone (or run the script
# in a temp dir, which is what "curl | sh" invites) and the app is gone, along
# with the desktop entry that never existed. Everyone who used this seriously
# ended up copying the AppImage somewhere by hand — which is the step this
# script should have been doing.
#
# `~/app/<name>/` by default: a real directory a person can open, not a dotdir.
# Data still lives in `~/.<appId>/` (that split is deliberate — one is the
# program, the other is everything it owns, and `rm -rf ~/.<appId>` must stay
# the complete uninstall of the DATA).
# The framework owns this rule (src/server/app-dirs.ts `installRoot`); the
# script asks for it, exactly as it asks for the private unpack dir. A shell
# copy is how an installer and `am remove` come to disagree about where an app
# lives — and the second one to be wrong deletes nothing, or the wrong thing.
# `|| true`: under `set -e` a plain `VAR=$(cmd)` whose command fails ENDS the
# script — so a builder that cannot answer (an older pin without the flag, a
# broken install) killed the one-liner right after a successful build, silently,
# with the artifact already on disk. The fallback below is the answer for that
# case, and it can only run if the assignment survives.
INSTALL_ROOT=$(deno run -A "$builder" --print-install-root 2>/dev/null || true)
[ -n "$INSTALL_ROOT" ] || INSTALL_ROOT="${AIO_INSTALL_ROOT:-$HOME/app}"
app_name=$(basename "$artifact")
# The bundle is named for the app, not for the archive it travels in.
if [ -n "$mac_app" ]; then app_name="${app_name%.app.tar.gz}"; fi
# Unpack the macOS bundle into "$1" (via "$1.part", so a half-unpacked bundle
# is never the one a launcher finds) and say, in $bundle, what it is called.
unpack_app() {
  rm -rf "$1.part"
  mkdir -p "$1.part" || fail "cannot create $1.part"
  tar -xzf "$artifact" -C "$1.part" || fail "could not unpack $artifact"
  bundle=$(cd "$1.part" && ls -d ./*.app 2>/dev/null | head -1)
  bundle="${bundle#./}"
  [ -n "$bundle" ] || fail "$artifact holds no .app bundle"
  # The same version again while the app is open: the bundle it runs from is
  # not taken away under it. It is this build already.
  if [ -d "$1/$bundle" ] && mac_app_open "$1"; then
    rm -rf "$1.part"
    info "${bundle%.app} is open and runs from $1/$bundle — that copy is left as it is"
    return 0
  fi
  mkdir -p "$1" || fail "cannot create $1"
  rm -rf "$1/$bundle"
  mv "$1.part/$bundle" "$1/$bundle" || fail "install to $1/$bundle failed"
  rm -rf "$1.part"
}
# Is a copy of this macOS app running from under "$1" — any version of it?
# The pattern is the physical path: that is the one a process shows.
mac_app_open() {
  _root=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  pgrep -f "$_root/.*$bundle/Contents/MacOS/" >/dev/null 2>&1
}
# WHAT this artifact is installed as — base name, extension, and the version
# its file name carries. The build owns that rule (`installArtifactName`), and
# it is asked, never re-derived here: since artifacts carry the derived version
# in their names (`demo-1.2.345-x86_64.AppImage`), a shell copy of the rule
# installs `demo-1.2.345.AppImage` — an app that renames itself, and its data
# directory, on every single update.
app_base=""; app_ext=""; art_ver=""
_names=$(deno run -A "$builder" --print-install-name="$app_name" 2>/dev/null || true)
if [ -n "$_names" ]; then
  app_base=$(printf '%s\n' "$_names" | sed -n 1p)
  app_ext=$(printf '%s\n' "$_names" | sed -n 2p)
  art_ver=$(printf '%s\n' "$_names" | sed -n 3p)
fi
if [ -z "$app_base" ]; then
  # An aio pinned before this flag existed. Such a build stamps no version into
  # the name, so the pre-versioning rule — strip the arch suffix the packager
  # appends, never "everything after the first hyphen" (that turned
  # `demo-electron-x86_64.AppImage` into `demo`, and `chat-app` into `chat`) —
  # is the whole rule for the names it produces. A name that DOES carry a
  # version with no builder able to read it is refused rather than guessed at.
  case "$app_name" in
    *-[0-9]*.[0-9]*.[0-9]*) # aio-ok: refuse-versioned-name
      fail "this app's pinned aio cannot name the artifact it just built ($app_name).
  Update the pin (am pin --latest) and re-run." ;;
  esac
  case "$app_name" in
    *.AppImage)
      app_ext=".AppImage"
      app_base="${app_name%.AppImage}"
      for _arch_suffix in x86_64 aarch64 arm64 armhf i686 amd64 x64; do
        app_base="${app_base%-$_arch_suffix}"
      done
      ;;
    *) app_base="$app_name"; app_ext="" ;;
  esac
fi
[ -n "$app_base" ] || app_base="$app_name"

if [ "$NO_INSTALL" = 1 ]; then
  installed="$artifact"
  # A tarball cannot be opened: the bundle is unpacked beside it instead.
  if [ -n "$mac_app" ]; then
    unpack_app "$(dirname "$artifact")"
    installed="$(cd "$(dirname "$artifact")" && pwd)/$bundle"
  fi
else
  # The version this build IS — `major.minor.<commit count>`, derived by the
  # build and stamped into the artifact's name. deno.json's `version` is only
  # its `major.minor` half now, so reading it here put every build of 0.1.x
  # into the same `versions/0.1/` directory: each install overwrote the one
  # before it and there was nothing left to roll back to.
  app_ver="$art_ver"
  target_dir="$INSTALL_ROOT/$app_base"

  # Is something ELSE already installed under this name? Two projects called
  # `demo` resolve to the same directory AND the same ~/.demo data — so the
  # second silently replaced the first's program and inherited its data.
  # Overwriting a binary is recoverable; the data underneath it is not.
  install_src="$GIT_URL"
  [ -n "$install_src" ] || install_src=$(git config --get remote.origin.url 2>/dev/null || echo "")
  [ -n "$install_src" ] || install_src=$PWD
  prev_src=$(deno run -A "$AIO_HOME/src/server/install-record.ts" conflict \
    --name="$app_base" --source="$install_src" 2>/dev/null || echo "")
  if [ -n "$prev_src" ]; then
    fail "\"$app_base\" is already installed here, from a DIFFERENT source:
    installed from: $prev_src
    installing:     $install_src
  They share $INSTALL_ROOT/$app_base AND the data directory ~/.$app_base.
  Remove the old one first (am remove $app_base), install under another name,
  or set AIO_INSTALL_ROOT to keep them apart."
  fi

  mkdir -p "$target_dir" || fail "cannot create $target_dir"
  # Versioned file + a stable name beside it: the stable one is what a menu
  # entry and a shell alias point at, the versioned ones are what you roll back
  # to. Copy-then-move so a half-written 156MB file is never runnable.
  # The VERSION goes in the DIRECTORY, never in the file name.
  #
  # A deno-compiled binary takes its identity from its own file name at
  # runtime, so installing it as `<name>-1.0.0` made the app call itself
  # `name-1-0-0` and write to `~/.name-1-0-0/` — and every upgrade moved it
  # again, starting from empty state while the real data sat in the previous
  # directory. Keeping the file called `<name>` and versioning the folder
  # around it costs nothing and removes the whole class (`mv app app.bak` is
  # the same trap).
  if [ -n "$app_ver" ]; then
    version_dir="$target_dir/versions/$app_ver"
  else
    version_dir="$target_dir/versions/$(date +%Y%m%d%H%M%S)"
  fi
  if [ -n "$mac_app" ]; then
    # macOS: the same layout with the bundle in the file's place —
    # versions/<version>/<Title>.app, and a stable link beside `versions/`.
    # NOT /Applications: this is where `am upgrade`, `am remove` and the
    # app's own updater find it. The app does not ask to be moved from here
    # (src/server/macos-move.ts, `inInstallRoot`).
    unpack_app "$version_dir"
    versioned="$version_dir/$bundle"
    installed="$target_dir/$bundle"
    ln -sfn "$versioned" "$installed" || fail "could not link $installed"
  else
    mkdir -p "$version_dir" || fail "cannot create $version_dir"
    versioned="$version_dir/$app_base$app_ext"
    cp "$artifact" "$versioned.part" || fail "copy to $versioned failed"
    chmod +x "$versioned.part" 2>/dev/null || :
    mv -f "$versioned.part" "$versioned" || fail "install to $versioned failed"
    installed="$target_dir/$app_base$app_ext"
    ln -sfn "$versioned" "$installed" 2>/dev/null || cp -f "$versioned" "$installed"
  fi
  ok "installed $installed"

  # What this is and where it came from — so `am installed` can say more than a
  # filename, `am upgrade` knows what to re-run, and the check above has
  # something to compare against next time.
  deno run -A "$AIO_HOME/src/server/install-record.ts" write \
    --name="$app_base" --version="$app_ver" --artifact="$(basename "$versioned")" \
    --source="$install_src" --commit="${AIO_BUILD_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo '')}" \
    --target="$eff_client" --aio="$(sed -n 's/.*"aioVersion"[: ]*"\([^"]*\)".*/\1/p' "$CFG" | head -1)" \
    >/dev/null 2>&1 || info "could not write the install record (the app is installed either way)"

  # Old versions are the rollback, but only the last few: one ~156MB artifact
  # per update, kept forever, is a disk leak with a friendly name.
  #
  # Not while the macOS app is open: it runs from one of those directories, and
  # a bundle is a directory — pruned, the running app has no files left under
  # it. Measured on macOS 14: the third install after the one that was open
  # removed its bundle while its process was still up.
  if [ -n "$mac_app" ] && mac_app_open "$target_dir"; then
    info "older versions kept this time: ${bundle%.app} is open and runs from one of them"
  else
    pruned=$(deno run -A "$AIO_HOME/src/server/install-record.ts" prune \
      --name="$app_base" --keep="${AIO_KEEP_VERSIONS:-3}" \
      --current="$version_dir" 2>/dev/null | tr '\n' ' ')
    [ -n "$pruned" ] && info "pruned older version(s): $pruned"
  fi

  # A launcher, because "you can live without it" is a thing people say about
  # the step they then do by hand every time. Both files are plain text and
  # cost nothing; a desktop that ignores them loses nothing either.
  if [ "$os" = "Darwin" ] && { [ "$eff_client" = "electron" ] || [ "$eff_client" = "client" ]; }; then
    # macOS has no .desktop files: the bundle IS the launcher (Finder,
    # Spotlight and the Dock read it), so there is nothing to write.
    :
  elif [ "$eff_client" = "electron" ] || [ "$eff_client" = "client" ]; then
    # The AppImage carries its own icon, but `.DirIcon` is a SYMLINK to the
    # real file (ico.svg, app.png, …) — extracting only `.DirIcon` yields a
    # dangling link and a menu entry with no icon, which is how this looked the
    # first time. Follow it, extract the target, keep its real extension.
    icon=""
    if [ "$app_ext" = ".AppImage" ]; then
      _prev_pwd=$PWD
      if cd "$target_dir" 2>/dev/null; then
        rm -rf squashfs-root
        "$installed" --appimage-extract .DirIcon >/dev/null 2>&1 || :
        _tgt=$(readlink squashfs-root/.DirIcon 2>/dev/null || echo "")
        [ -n "$_tgt" ] && "$installed" --appimage-extract "$_tgt" >/dev/null 2>&1
        _src="squashfs-root/${_tgt:-.DirIcon}"
        if [ -f "$_src" ]; then
          _ext="${_src##*.}"
          case "$_ext" in png|svg|xpm) : ;; *) _ext=png ;; esac
          cp -f "$_src" "$app_base.$_ext" 2>/dev/null && icon="$target_dir/$app_base.$_ext"
        fi
        rm -rf squashfs-root
        cd "$_prev_pwd" || :
      fi
    fi
    desktop_dir="$HOME/.local/share/applications"
    if mkdir -p "$desktop_dir" 2>/dev/null; then
      # Exec sets TMPDIR to a private per-user directory FIRST.
      #
      # An AppImage unpacks itself into $TMPDIR — and the AppImage runtime
      # reads it before AppRun, before the app, before anything aio ships can
      # run. The default is /tmp, which is world-readable and (on the
      # FUSE-less extract path) a predictable digest another user can create
      # first. A field report got the warning aio prints about this and could
      # not act on it: the advice reaches whoever LAUNCHES the artifact, and a
      # double-click has no launcher to put it in — except this one.
      {
        printf '[Desktop Entry]\nType=Application\nName=%s\n' "$app_base"
        printf 'Exec=sh -c '\''D="${XDG_CACHE_HOME:-$HOME/.cache}/%s"; mkdir -p "$D"; chmod 700 "$D" 2>/dev/null; TMPDIR="$D" exec "%s" "$@"'\'' _ %%U\n' \
          "$app_base" "$installed"
        [ -f "$icon" ] && printf 'Icon=%s\n' "$icon"
        printf 'Categories=Utility;\nTerminal=false\n'
      } > "$desktop_dir/$app_base.desktop" 2>/dev/null \
        && ok "menu entry $desktop_dir/$app_base.desktop"
      # Some desktops cache this directory and will not show a new entry until
      # the next login. One command, when it exists, and silence when it does
      # not.
      command -v update-desktop-database >/dev/null 2>&1 \
        && update-desktop-database "$desktop_dir" >/dev/null 2>&1 || :
    fi
  else
    # Headless targets belong on PATH, not in a menu.
    if mkdir -p "$HOME/.local/bin" 2>/dev/null; then
      ln -sfn "$installed" "$HOME/.local/bin/$app_base" 2>/dev/null \
        && ok "on PATH as ~/.local/bin/$app_base"
    fi
  fi
fi

if [ "$NO_RUN" = 1 ]; then
  if [ -n "$mac_app" ]; then
    printf "${bold}Run it:${reset} open \"%s\"\n" "$installed"
  else
    printf "${bold}Run it:${reset} %s\n" "$installed"
  fi
  exit 0
fi
# macOS: a bundle is opened, not executed — `open` hands it to LaunchServices,
# which is what makes it one Dock app with its own icon. The build commit
# travels as --env (an opened app does not inherit this shell's environment).
if [ -n "$mac_app" ]; then
  # `open` on an app that is already running starts nothing: it brings that
  # window forward. Measured on macOS 14 — the version before stayed up while
  # this script ended "opening …" with exit 0, so it is said.
  if mac_app_open "${target_dir:-$(dirname "$installed")}"; then
    warn "${bundle%.app} is already open, so macOS only brings its window forward: quit it and open it again to run the copy just installed."
  fi
  info "opening $installed"
  _commit=""
  if [ -d .git ]; then _commit=$(git rev-parse HEAD 2>/dev/null || echo ""); fi
  if [ -n "$_commit" ]; then
    set -- --env "AIO_BUILD_COMMIT=$_commit" --args "$@"
  else
    set -- --args "$@"
  fi
  exec open "$installed" "$@"
fi
info "running $installed $*"
artifact="$installed"

# An AppImage unpacks itself into $TMPDIR before a single line of the app runs,
# so this is the ONLY moment anything can choose where that lands. Default
# /tmp is shared: the extract path's directory name is a digest of the AppImage
# (predictable, and 0755 = world-readable), a second user running the same file
# collides with the first user's copy, and the runtime warns-but-continues into
# whatever tree is already there. ~/.<appId>/app is private to its owner by
# construction. The build tells us the path — deriving an app's identity here
# would be a second copy of a rule the framework already owns.
app_tmpdir=$(deno run -A "$AIO_HOME/src/build.ts" --print-app-tmpdir 2>/dev/null)
if [ -n "$app_tmpdir" ] && mkdir -p "$app_tmpdir" 2>/dev/null; then
  chmod 700 "$app_tmpdir" 2>/dev/null || :
  export TMPDIR="$app_tmpdir"
else
  # Loud, not silent: falling back to /tmp is a real (if minor) exposure, and a
  # user who cannot see it cannot decide about it.
  info "could not prepare a private unpack dir — falling back to \$TMPDIR/tmp"
fi
# The commit this artifact was built FROM. An app configured with a git update
# source compares against it to notice the ref has moved; without it the app
# has nothing to compare and says so rather than guessing. Recorded here
# because this script is the only thing that knows which commit was built.
if [ -d .git ]; then
  AIO_BUILD_COMMIT=$(git rev-parse HEAD 2>/dev/null) && export AIO_BUILD_COMMIT
fi
# AppImages need FUSE; extract-and-run works everywhere (containers included).
APPIMAGE_EXTRACT_AND_RUN=1 exec "$artifact" "$@"
