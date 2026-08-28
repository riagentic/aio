#!/bin/sh
# Legacy entrypoint — kept so old curl URLs keep working. Onboarding is now
# `am` (the aio manager): this forwards to install.sh, which installs am.
# Canonical: curl -fsSL .../install.sh | sh   then   am create my-app
#
# `set -u` alongside `-e` for the same reason install.sh and run.sh give: a
# path built from an unset variable silently becomes something else.
set -eu

AIO_BRANCH="${AIO_BRANCH:-main}"
AIO_RAW="${AIO_RAW:-https://raw.githubusercontent.com/riagentic/aio/$AIO_BRANCH}"

fail() {
  echo "aio: $1" >&2
  exit 1
}

# DOWNLOAD, THEN RUN — the same rule run.sh states at length, for the same
# reason. `sh -c "$(curl …)"` cannot detect a failure: a 404, a dropped
# connection or an empty body makes the substitution empty, `sh -c ""` runs
# nothing and exits 0, and whoever typed the old URL is told the install
# succeeded while nothing was installed. `set -e` does not help — a command
# substitution's status is not the simple command's.
_installer="${TMPDIR:-/tmp}/aio-init.$$.sh"
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
