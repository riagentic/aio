#!/bin/sh
# aio — one-line installer for `am` (the aio manager). Source-based: clones the
# framework from GitHub and installs `am` from it. No JSR, no publish, no login.
#
#   curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
#
# Re-running updates aio + am in place (same as `am update`). Uninstall with
# `am uninstall`. Override the location with AIO_HOME, or a fork/branch with
# AIO_REPO / AIO_BRANCH.
#
# TRUNCATION GUARD. This script is piped straight into `sh`, which executes it
# as it arrives: a connection that dies mid-transfer runs the PREFIX that made
# it through and exits 0. Truncated just past `git checkout --force <tag>` that
# is a wiped working tree and a cheerful zero exit. Everything below therefore
# lives inside `main()`, which is only ever CALLED on the last line — an
# incomplete download reaches sh as an unterminated function and is a syntax
# error, which is what a half-delivered installer should be.
#
# `set -u` for the same class of failure one level down: with $HOME unset,
# `$HOME/.local/lib/aio` is `/.local/lib/aio` and the installer starts cloning
# into the filesystem root.
set -eu

main() {

[ -n "${HOME:-}" ] || {
  printf "\033[31m✗\033[0m %s\n" "\$HOME is not set, so there is nowhere to install to. Set it (export HOME=/home/you) and re-run, or set AIO_HOME to an explicit directory." >&2
  exit 1
}

AIO_HOME="${AIO_HOME:-$HOME/.local/lib/aio}"
AIO_REPO="${AIO_REPO:-https://github.com/riagentic/aio}"
AIO_BRANCH="${AIO_BRANCH:-main}"

bold="\033[1m"; dim="\033[2m"; cyan="\033[36m"; green="\033[32m"; red="\033[31m"; reset="\033[0m"
info() { printf "${cyan}▸${reset} %s\n" "$1"; }
ok()   { printf "${green}✓${reset} %s\n" "$1"; }
warn() { printf "${red}!${reset} %s\n" "$1" >&2; }
fail() { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }

# ── Tools this script itself needs ───────────────────────────────────────
# Checked TOGETHER and UP FRONT: finding out about a missing `git` after the
# deno download is a worse experience than being told both at once, and
# discovering it inside someone else's script is worse still.
missing=""
for t in git curl; do
  command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
done
[ -z "$missing" ] || fail "missing required tool(s):$missing — install them and re-run (Debian/Ubuntu: sudo apt install -y$missing)"

# ── Clone / update aio FIRST ─────────────────────────────────────────────
# Before deno, on purpose: the clone needs only git, and it carries the ONE
# authoritative statement of which deno version this framework requires
# (src/server/deno-version.ts). Checking deno first meant hardcoding that
# number here — a second decider that would go stale the first time it moved.
# A checkout that someone WORKS in is never moved. The canonical install is
# always detached at a tag and clean; a clone on a branch, or with local
# changes, is a developer's repo (AIO_HOME pointed at it, or run.sh ran inside
# one) — and `git checkout --force <tag>` there deletes uncommitted work. That
# happened to the framework's own working tree the first time run.sh started
# updating unconditionally. Same rule as `am update`: leave it alone, say so,
# and still (re)install am from whatever is checked out there.
AIO_DEV_CHECKOUT=0
if [ -d "$AIO_HOME/.git" ]; then
  # Local changes are always protected. A branch counts as "worked in" unless
  # AIO_REF says otherwise — `AIO_REF=main` is explicit, and it checks out
  # detached below so the install never ends up ON a branch by itself.
  # deno.lock is excluded: `deno install` from this checkout rewrites it, so
  # counting it would make every canonical install look "worked in" after its
  # first run and freeze it forever (measured: that is exactly what happened).
  if [ -n "$(git -C "$AIO_HOME" status --porcelain --untracked-files=no -- . ':!deno.lock' 2>/dev/null)" ]; then
    AIO_DEV_CHECKOUT=1
  elif [ -z "${AIO_REF:-}" ] && git -C "$AIO_HOME" symbolic-ref -q HEAD >/dev/null 2>&1; then
    AIO_DEV_CHECKOUT=1
  fi
fi
if [ "$AIO_DEV_CHECKOUT" = 1 ]; then
  info "$AIO_HOME is a working checkout (on a branch or with local changes) — not moving it"
elif [ -d "$AIO_HOME/.git" ]; then
  info "updating aio in $AIO_HOME"
  git -C "$AIO_HOME" fetch --tags --force -q origin "$AIO_BRANCH" >/dev/null 2>&1 || \
    warn "could not fetch updates — continuing with the checkout that is there"
else
  info "cloning aio → $AIO_HOME"
  # git's OWN reason, not our guess at it. This used to swallow stderr and say
  # "check network", which is one of a dozen causes — a proxy, a missing CA
  # bundle, no disk, an ownership guard, a private repo. Reporting the wrong
  # cause confidently is worse than reporting none.
  # A LOCAL source is cloned by reading its loose objects, and git writes those
  # with the process umask applied — so a repo whose commits were made under
  # `umask 077` holds 400 (owner-read) objects. Another user then cannot read
  # them at all, and git reports "failed to copy file to
  # '…/.git/objects/…': Permission denied", which names git internals rather
  # than the cause. Nothing on this side can fix it (a clone must READ what it
  # cannot read), so the job here is to say what actually happened.
  if ! _clone_err=$(git clone -q "$AIO_REPO" "$AIO_HOME" 2>&1); then
    _hint=""
    case "$_clone_err" in
      *"Permission denied"*.git/objects/*)
        _unreadable=$(find "$AIO_REPO/.git/objects" -type f ! -perm -o+r 2>/dev/null | wc -l)
        [ "${_unreadable:-0}" -gt 0 ] && _hint="

$AIO_REPO has $_unreadable git object(s) that only their owner can read.
git applies the process umask when it writes objects, so commits made in a
shell with \`umask 077\` land as 400 instead of 444 — a perfectly good repo
that another user cannot clone. Fix it at the source:
  chmod -R o+rX $AIO_REPO/.git
(and \`umask 022\` before committing, so it does not come back)."
        ;;
    esac
    fail "git clone failed for $AIO_REPO:
${_clone_err:-(git said nothing)}${_hint}"
  fi
fi
# An explicit ref wins over everything: `AIO_REF=v1.0.0-alpha57` pins a release,
# `AIO_REF=main` follows the tip, `AIO_REF=<sha>` reproduces a report exactly.
# The onboarding lab needs it too — without it the lab could only ever test the
# last TAG, so a fix could not be verified until after it shipped.
if [ "$AIO_DEV_CHECKOUT" = 1 ]; then
  ok "aio $(git -C "$AIO_HOME" describe --tags --always 2>/dev/null || echo '?') (working checkout, left as is)"
  AIO_TAG=""
elif [ -n "${AIO_REF:-}" ]; then
  git -C "$AIO_HOME" fetch -q --tags --force origin "$AIO_REF" 2>/dev/null || :
  git -C "$AIO_HOME" checkout -q --force --detach "$AIO_REF" 2>/dev/null \
    || git -C "$AIO_HOME" checkout -q --force --detach "origin/$AIO_REF" 2>/dev/null \
    || fail "AIO_REF=$AIO_REF is not a ref in $AIO_REPO"
  ok "aio $AIO_REF (pinned via AIO_REF)"
  AIO_TAG=""
else
# Latest tag reachable from the branch (ancestry-based — robust to version naming).
AIO_TAG=$(git -C "$AIO_HOME" describe --tags --abbrev=0 "origin/$AIO_BRANCH" 2>/dev/null \
  || git -C "$AIO_HOME" tag -l 'v*' --sort=-creatordate | head -1)
if [ -n "$AIO_TAG" ]; then
  git -C "$AIO_HOME" checkout -q --force "$AIO_TAG" 2>/dev/null
  ok "aio $AIO_TAG"
else
  git -C "$AIO_HOME" checkout -q --force "$AIO_BRANCH" 2>/dev/null
  ok "aio $AIO_BRANCH (no tags yet)"
fi
fi

# ── Deno, at a version this framework can actually run on ────────────────
# The old version of this block asked ONE question — "is there a deno?" — and a
# machine with deno 2.1 sailed through with a green "✓ deno 2.1.4". Everything
# afterwards then failed somewhere else, describing something else, and the
# person had no way to connect it to the version. That was the single worst bug
# in the onboarding path, and it is why this compares.
MIN_DENO=$(sed -n 's/.*MIN_DENO = "\([^"]*\)".*/\1/p' \
  "$AIO_HOME/src/server/deno-version.ts" 2>/dev/null | head -1)
[ -n "$MIN_DENO" ] || MIN_DENO="2.9.0"   # clone unreadable: still refuse to guess low

export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
export PATH="$DENO_INSTALL/bin:$HOME/.deno/bin:$PATH"

deno_version() { deno --version 2>/dev/null | head -1 | awk '{print $2}'; }

# Numeric, field by field. A string compare says "2.10.0" < "2.9.0", which is
# the classic way a version gate lets exactly the wrong build through; `sort -V`
# is GNU-only and not on every minimal image.
version_ge() { # version_ge HAVE WANT
  h="${1%%[-+]*}"; w="${2%%[-+]*}"
  h_maj="${h%%.*}"; h_r="${h#*.}"; h_min="${h_r%%.*}"; h_pat="${h_r#*.}"
  w_maj="${w%%.*}"; w_r="${w#*.}"; w_min="${w_r%%.*}"; w_pat="${w_r#*.}"
  case "$h_maj$h_min$h_pat$w_maj$w_min$w_pat" in *[!0-9]*) return 1 ;; esac
  [ "$h_maj" -ne "$w_maj" ] && { [ "$h_maj" -gt "$w_maj" ]; return; }
  [ "$h_min" -ne "$w_min" ] && { [ "$h_min" -gt "$w_min" ]; return; }
  [ "$h_pat" -ge "$w_pat" ]
}

# Which deno build this machine needs. `uname` is on every POSIX box; getting
# this wrong downloads a working binary for the wrong CPU, so an unknown pair
# is refused rather than guessed.
deno_target() {
  case "$(uname -s)" in
    Linux)  _os=unknown-linux-gnu ;;
    Darwin) _os=apple-darwin ;;
    *)      return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  _arch=x86_64 ;;
    aarch64|arm64) _arch=aarch64 ;;
    *)             return 1 ;;
  esac
  echo "${_arch}-${_os}"
}

# Install deno WITHOUT unzip.
#
# Deno is published only as a .zip, its installer needs `unzip` or `7z`, and a
# fresh Ubuntu has NEITHER — so the one-line installer died inside someone
# else's script on the most common Linux there is. Telling the user to
# `apt install unzip` is honest but it is still a broken first minute, and
# "install this other thing first" is exactly the friction a one-liner exists
# to remove.
#
# Did an install actually produce a working deno? THE answer, for every branch
# of install_deno.
#
# The official installer is run as a PIPELINE, and a POSIX pipeline's status is
# the LAST command's — `sh`'s — with no `pipefail` in /bin/sh. A 404, a dropped
# connection or an empty body means `sh` reads nothing and exits 0, so the
# `|| return 1` beside it never fires and the caller is told deno was installed.
# The only trustworthy answer is whether deno RUNS afterwards, which is what the
# no-unzip branch already did and the official-installer branch did not.
deno_ok() { command -v deno >/dev/null 2>&1 && deno --version >/dev/null 2>&1; }

# A bare ubuntu:24.04 does have perl, and perl can inflate a zip member. So
# when there is no unzip we do the whole thing ourselves: download the release
# asset, VERIFY ITS SHA256 (which the official installer does not do), extract
# the single `deno` member, and install it. `sha256sum` is coreutils, always
# there; if perl is missing too, we say precisely what to install.
install_deno_no_unzip() {
  _target=$(deno_target) || return 1
  command -v perl >/dev/null 2>&1 || return 1
  perl -MIO::Uncompress::Unzip -e 1 >/dev/null 2>&1 || return 1

  _base="https://github.com/denoland/deno/releases/latest/download"
  _tmp="${TMPDIR:-/tmp}/aio-deno.$$"
  mkdir -p "$_tmp" || return 1
  info "downloading deno ($_target) — no unzip on this machine, using perl"
  curl -fsSL -o "$_tmp/deno.zip" "$_base/deno-$_target.zip" || { rm -rf "$_tmp"; return 1; }

  # The checksum is published beside the asset. Verifying it costs one request
  # and turns "we downloaded something" into "we downloaded the right thing".
  if curl -fsSL -o "$_tmp/deno.sha256" "$_base/deno-$_target.zip.sha256sum" 2>/dev/null \
     && command -v sha256sum >/dev/null 2>&1; then
    _want=$(awk '{print $1}' "$_tmp/deno.sha256" | head -1)
    _have=$(sha256sum "$_tmp/deno.zip" | awk '{print $1}')
    if [ -n "$_want" ] && [ "$_want" != "$_have" ]; then
      rm -rf "$_tmp"
      fail "the deno download did not match its published checksum — refusing to install it (expected $_want, got $_have)"
    fi
  fi

  mkdir -p "$DENO_INSTALL/bin" || { rm -rf "$_tmp"; return 1; }
  perl -MIO::Uncompress::Unzip=unzip -e '
    unzip $ARGV[0] => $ARGV[1], Name => "deno"
      or die "could not extract deno from the archive: $IO::Uncompress::Unzip::UnzipError\n";
  ' "$_tmp/deno.zip" "$DENO_INSTALL/bin/deno" || { rm -rf "$_tmp"; return 1; }
  chmod +x "$DENO_INSTALL/bin/deno" || { rm -rf "$_tmp"; return 1; }
  rm -rf "$_tmp"
  export PATH="$DENO_INSTALL/bin:$PATH"
  hash -r 2>/dev/null || :
  deno_ok
}

install_deno() {
  # The official installer first — it is the canonical path and handles its own
  # future changes. It needs unzip/7z, which is exactly what we may not have.
  if command -v unzip >/dev/null 2>&1 || command -v 7z >/dev/null 2>&1 \
     || command -v 7zz >/dev/null 2>&1; then
    curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1 || \
      curl -fsSL https://deno.land/install.sh | sh -s -- -y || return 1
    export PATH="$DENO_INSTALL/bin:$PATH"
    hash -r 2>/dev/null || :
    deno_ok && return 0
    return 1
  fi
  install_deno_no_unzip && return 0
  fail "cannot install deno on this machine: it has no unzip/7z (deno ships as a .zip) and no perl to stand in for one.
  Debian/Ubuntu:  sudo apt install -y unzip
  Fedora/RHEL:    sudo dnf install -y unzip
  Alpine:         sudo apk add unzip
Then re-run this installer."
}

if ! command -v deno >/dev/null 2>&1; then
  info "deno not found — installing (aio needs $MIN_DENO+)"
  install_deno || fail "deno install failed — see https://docs.deno.com/runtime/getting_started/installation/"
  ok "deno $(deno_version) installed"
elif version_ge "$(deno_version)" "$MIN_DENO"; then
  ok "deno $(deno_version)"
else
  HAVE=$(deno_version)
  DENO_BIN=$(command -v deno)
  info "deno $HAVE is older than the $MIN_DENO aio requires — upgrading"
  # `deno upgrade` only works on a deno that OWNS its binary. A version from
  # apt/snap/brew cannot rewrite itself, and its failure message talks about
  # permissions rather than about what to do — so on any failure we install a
  # private deno under $DENO_INSTALL and put it first on PATH. Two attempts,
  # then a refusal that names the exact command; never a silent "close enough".
  if deno upgrade >/dev/null 2>&1 && version_ge "$(deno_version)" "$MIN_DENO"; then
    ok "deno upgraded to $(deno_version)"
  else
    info "that deno cannot upgrade itself ($DENO_BIN) — installing a private one in $DENO_INSTALL"
    install_deno || :
    hash -r 2>/dev/null || :
    if version_ge "$(deno_version)" "$MIN_DENO"; then
      ok "deno $(deno_version) (from $DENO_INSTALL/bin, ahead of $DENO_BIN on PATH)"
      warn "the system deno at $DENO_BIN is still $HAVE — remove it, or keep $DENO_INSTALL/bin first on PATH"
    else
      fail "aio needs deno $MIN_DENO+ and this box has $HAVE, which could not be upgraded.
  Fix it with ONE of:
    deno upgrade                                   (if you installed deno yourself)
    curl -fsSL https://deno.land/install.sh | sh   (installs into ~/.deno)
    sudo snap refresh deno / brew upgrade deno     (if a package manager owns it)
  Then re-run this installer."
    fi
  fi
fi

# ── Install am from the clone (its deno.json supplies the import map) ────
info "installing am..."
deno install -gAf --config "$AIO_HOME/deno.json" -n am "$AIO_HOME/src/am.ts" \
  || fail "installing am failed — the output above says why"

export PATH="$DENO_INSTALL/bin:$PATH"
hash -r 2>/dev/null || :

AM_BIN="$DENO_INSTALL/bin/am"
[ -x "$AM_BIN" ] || AM_BIN=$(command -v am 2>/dev/null || echo "$DENO_INSTALL/bin/am")

# `deno install` writes a shim whose body is `exec deno run …` — deno BY NAME.
# So `am` works only where `deno` is already on PATH, and when it isn't the
# failure is `am: 3: exec: deno: not found`: a message about deno, printed by a
# script the user did not write, when they typed `am`. Pinning the interpreter
# to the absolute path we just verified makes `am` independent of PATH — which
# matters most in exactly the situation this installer creates, where deno was
# installed seconds ago into a directory the current shell has never heard of.
DENO_BIN_ABS=$(command -v deno 2>/dev/null || true)
if [ -n "$DENO_BIN_ABS" ] && [ -f "$AM_BIN" ] && grep -q '^exec deno ' "$AM_BIN" 2>/dev/null; then
  _tmp="$AM_BIN.aio-tmp.$$"
  if sed "s|^exec deno |exec \"$DENO_BIN_ABS\" |" "$AM_BIN" > "$_tmp" 2>/dev/null; then
    chmod +x "$_tmp" 2>/dev/null || :
    mv -f "$_tmp" "$AM_BIN" 2>/dev/null || rm -f "$_tmp"
  else
    rm -f "$_tmp"
  fi
fi

# ── PATH, made true rather than suggested ────────────────────────────────
# The old script printed "add it to PATH: …" and exited 0. That is a one-line
# instruction attached to a one-line installer, and it is the difference
# between "aio is installed" and "aio is installed IF you also do this". The
# next terminal has to work, so this writes the line itself — idempotently,
# in a marked block, in every profile the shell might read.
persist_path() {
  _line='export PATH="$HOME/.deno/bin:$PATH"  # aio'

  # Which files get CREATED depends on the shell that will actually be opened
  # next, not on what happens to exist. This is where macOS was broken:
  #
  #   • macOS has defaulted to ZSH since Catalina, and ships NO ~/.zshrc — so
  #     the "only touch it if it exists" rule skipped every zsh file;
  #   • ~/.profile was created, and zsh NEVER reads it (a login zsh reads
  #     /etc/zprofile → ~/.zprofile → ~/.zshrc; .profile is sh/bash only);
  #   • the verification below runs `sh -lc`, which DOES read ~/.profile — so
  #     the installer said "am works in a new shell too" and the user's next
  #     Terminal had no `am` at all. A check that passes in a shell the user
  #     does not use is worse than no check.
  #
  # So: `.profile` always (sh/bash login), and when the login shell is zsh —
  # or we are on Darwin, where it is the default even if $SHELL is unset in
  # this process — `~/.zprofile` is created too. Files that already exist are
  # always updated, whatever the shell.
  _targets="$HOME/.profile"
  case "${SHELL:-}" in *zsh) _zsh=1 ;; *) _zsh=0 ;; esac
  # if/else, not `[ … ] && x=1`: under `set -e` an AND-list whose test fails IS
  # a failing command, and this one sits one edit away from being last.
  if [ "$(uname -s 2>/dev/null || echo other)" = "Darwin" ]; then _zsh=1; fi
  if [ "$_zsh" = 1 ]; then _targets="$_targets $HOME/.zprofile"; fi
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile"; do
    [ -f "$rc" ] || continue
    case " $_targets " in *" $rc "*) continue ;; esac
    _targets="$_targets $rc"
  done

  for rc in $_targets; do
    if [ -f "$rc" ] && grep -qF '.deno/bin' "$rc" 2>/dev/null; then continue; fi
    printf '\n%s\n' "$_line" >> "$rc" 2>/dev/null || :
    _persisted="${_persisted:-}$rc "
  done
}
persist_path

# An installed file is not an installed TOOL. This used to accept `am version`
# failing (`|| echo am`), so a broken install printed a cheerful line and the
# next command was the one that told the truth.
# `am version`, not `am --version`: this installer is fetched from the BRANCH
# while the framework it installs is the last TAG, so the two are never
# guaranteed to be the same age. Verifying with a spelling that only exists on
# the newer side makes the published one-liner fail against the release it just
# installed — which is the exact drift this check is supposed to catch, aimed
# at the wrong target. `am version` has existed the whole time.
am_says_version() { # am_says_version <cmd…>
  "$@" version 2>/dev/null | head -1 || return 1
}
AM_VERSION=""
if command -v am >/dev/null 2>&1; then
  AM_VERSION=$(am_says_version am) || AM_VERSION=""
fi
if [ -z "$AM_VERSION" ] && [ -x "$AM_BIN" ]; then
  AM_VERSION=$(am_says_version "$AM_BIN") || AM_VERSION=""
fi
if [ -n "$AM_VERSION" ]; then
  ok "am installed: $AM_VERSION"
else
  [ -x "$AM_BIN" ] || fail "am did not install — expected $AM_BIN"
  fail "am is installed at $AM_BIN but does not run:
$("$AM_BIN" version 2>&1 | head -3)"
fi

# …and it has to work in the shell the user opens NEXT, not just in this one.
# `sh -lc` is the login shell that reads ~/.profile — the check that would have
# caught "works in the installer, missing in the terminal".
# …and in the user's OWN login shell, which on macOS is zsh and does not read
# the file `sh -lc` just proved. Both are checked when both exist.
_newshell_ok=1
sh -lc 'command -v am >/dev/null 2>&1 && am version >/dev/null 2>&1' 2>/dev/null \
  || _newshell_ok=0
case "${SHELL:-}" in
  *zsh)
    if command -v zsh >/dev/null 2>&1; then
      zsh -lc 'command -v am >/dev/null 2>&1 && am version >/dev/null 2>&1' \
        2>/dev/null || _newshell_ok=0
    fi
    ;;
esac
if [ "$_newshell_ok" = 1 ]; then
  ok "am works in a new shell too"
else
  warn "am works now, but a NEW terminal may not find it${_persisted:+ (added PATH to: ${_persisted})}"
  printf "${bold}  This shell:${reset} export PATH=\"\$HOME/.deno/bin:\$PATH\"\n"
fi

printf "\n${bold}Next:${reset}\n"
printf "  am create my-app   ${dim}# scaffold a new aio app (points at %s)${reset}\n" "$AIO_HOME"
printf "  cd my-app && deno task dev\n"

}

main "$@"
