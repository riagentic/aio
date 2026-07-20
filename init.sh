#!/bin/sh
# Legacy entrypoint — kept so old curl URLs keep working. Onboarding is now
# `am` (the aio manager): this forwards to install.sh, which installs am.
# Canonical: curl -fsSL .../install.sh | sh   then   am create my-app
set -e
exec sh -c "$(curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh)"
