#!/usr/bin/env bash
# Arrête le socle et supprime conteneurs et volumes (à lancer toujours, même après un échec).
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lancer.sh" --arreter
