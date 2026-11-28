#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
read -r gateway container_ip < <(docker inspect --format '{{with index .NetworkSettings.Networks "siyuan_default"}}{{.Gateway}} {{.IPAddress}}{{end}}' siyuan)
exec node gemini-gateway.mjs "$gateway" "$container_ip"
