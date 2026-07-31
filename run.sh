#!/bin/sh
# aio — run any aio app from source with ONE line. No questions asked.
#
#   In an aio app repo:      curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/run.sh | sh
#   Dev instead of prod:     curl -fsSL .../run.sh | sh -s -- --dev
#   From a repo link:        curl -fsSL .../run.sh | sh -s owner/repo
#                            curl -fsSL .../run.sh | sh -s https://github.com/owner/repo
#
# What it does, in order: ensure git + deno + aio/am are installed (delegating
# to install.sh when anything is missing), clone the repo if one was given,
# `am fix` whatever the checkout needs, then PRODUCTION-build the app's default
# target and run the artifact (`--dev` runs the dev server instead).
# Args after `--` are passed to the app itself.
#
# Flags: --dev · --git <url> · --no-run (build only) · -- <app args…>
# Env:   AIO_HOME / AIO_REPO / AIO_BRANCH (as install.sh) ·
#        AIO_RAW (raw base for fetching install.sh) ·
#        AIO_INSTALL (local install.sh path — offline/tests)
# Windows: use run.ps1 (`irm .../run.ps1 | iex`).
set -e

AIO_HOME="${AIO_HOME:-$HOME/.local/lib/aio}"
AIO_BRANCH="${AIO_BRANCH:-main}"
AIO_RAW="${AIO_RAW:-https://raw.githubusercontent.com/riagentic/aio/$AIO_BRANCH}"

bold="\033[1m"; dim="\033[2m"; cyan="\033[36m"; green="\033[32m"; red="\033[31m"; reset="\033[0m"
info() { printf "${cyan}▸${reset} %s\n" "$1"; }
ok()   { printf "${green}✓${reset} %s\n" "$1"; }
fail() { printf "${red}✗${reset} %s\n" "$1" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────
DEV=0; NO_RUN=0; GIT_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) DEV=1 ;;
    --no-run) NO_RUN=1 ;;
    --git) shift; GIT_URL="${1:-}"; [ -n "$GIT_URL" ] || fail "--git needs a URL" ;;
    --git=*) GIT_URL="${1#--git=}" ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (flags: --dev, --git <url>, --no-run, -- <app args>)" ;;
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

if ! command -v deno >/dev/null 2>&1 || ! command -v am >/dev/null 2>&1 \
  || [ ! -d "$AIO_HOME/.git" ]; then
  info "setting up aio (deno + framework + am)..."
  if [ -n "${AIO_INSTALL:-}" ]; then
    sh "$AIO_INSTALL" || fail "install failed ($AIO_INSTALL)"
  else
    curl -fsSL "$AIO_RAW/install.sh" | sh || fail "install failed ($AIO_RAW/install.sh)"
  fi
  PATH="$DENO_INSTALL/bin:$HOME/.deno/bin:${DENO_INSTALL_ROOT:-$HOME/.deno}/bin:$PATH"
  export PATH
  command -v deno >/dev/null 2>&1 || fail "deno still not found after install"
  command -v am >/dev/null 2>&1 || fail "am still not found after install"
fi
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
marker=".aio-run-marker.$$"
: > "$marker"
trap 'rm -f "$marker"' EXIT INT TERM

info "production build (default target)..."
if [ "$(has_task compile)" = "yes" ]; then
  deno task compile || fail "build failed — the output above says why"
else
  # Hand-rolled app without the scaffolded task: invoke the builder directly.
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
IFS=$oldIFS
[ -n "$artifact" ] || fail "build finished but no runnable artifact appeared — run 'deno task compile' by hand to see why"
rm -f "$marker"; trap - EXIT INT TERM

ok "built $artifact"
if [ "$NO_RUN" = 1 ]; then
  printf "${bold}Run it:${reset} %s\n" "$artifact"
  exit 0
fi
info "running $artifact $*"
# AppImages need FUSE; extract-and-run works everywhere (containers included).
APPIMAGE_EXTRACT_AND_RUN=1 exec "$artifact" "$@"
