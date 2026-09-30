#!/bin/sh
# Container start (web/Dockerfile, docs/DEPLOY.md): check the data directories, bring the database up to
# db/migrations (scripts/migrate.mjs), then hand the process over to the Next standalone server.
set -eu

# MEDIA_DIR and EDITION_SNAPSHOT_DIR (/data/media, /data/snapshots) must be on a persistent volume: a
# published story's image lives only there. Without one the files would be written inside the container and
# lost at the next deploy, so the container refuses to start. DATA_VOLUME_OPTIONAL=1 skips that check (a
# throwaway run only).
on_volume() { # true when $1 or a directory above it (other than /) is a mount point
  d=$1
  while [ "$d" != / ] && [ -n "$d" ]; do
    awk -v m="$d" '$5 == m { found = 1 } END { exit !found }' /proc/self/mountinfo && return 0
    d=$(dirname "$d")
  done
  return 1
}

for dir in "$MEDIA_DIR" "$EDITION_SNAPSHOT_DIR"; do
  case $dir in /*) ;; *) echo "entrypoint: \"$dir\" must be an absolute path" >&2; exit 1 ;; esac
  if [ "${DATA_VOLUME_OPTIONAL:-0}" != 1 ] && ! on_volume "$dir"; then
    echo "entrypoint: $dir is not on a mounted volume; mount persistent storage at /data (docs/DEPLOY.md)" >&2
    exit 1
  fi
  mkdir -p "$dir" 2>/dev/null || true
  if [ ! -w "$dir" ]; then
    echo "entrypoint: $dir is not writable by uid $(id -u); on the host: chown -R $(id -u):$(id -g) <the volume's directory>" >&2
    exit 1
  fi
done
echo "entrypoint: media in $MEDIA_DIR, edition snapshots in $EDITION_SNAPSHOT_DIR"

node scripts/migrate.mjs
exec node server.js
