#!/bin/sh
set -e

# Seed image-baked tools into the mounted /app/tools directory if missing.
# The bind-mount (./tools:/app/tools) shadows the image's /app/tools, so without
# this, a host with an empty/missing ./tools would have no tools. Existing host
# files are preserved (never overwritten).
if [ -d /app/tools-image ]; then
  mkdir -p /app/tools
  for src in /app/tools-image/*; do
    [ -e "$src" ] || continue
    name=$(basename "$src")
    if [ ! -e "/app/tools/$name" ]; then
      cp -a "$src" "/app/tools/$name"
    fi
  done
  chmod +x /app/tools/*.sh 2>/dev/null || true
fi

# Ensure the imports directory exists (input files for the import tools).
mkdir -p /app/imports

exec "$@"
