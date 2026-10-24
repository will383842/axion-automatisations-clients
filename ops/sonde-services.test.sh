#!/usr/bin/env bash
# [C-548] Tests de la sonde des services. Lancer : bash ops/sonde-services.test.sh
set -u
ici="$(cd "$(dirname "$0")" && pwd)"
echec=0

verifier() { # nom, condition (0 = ok)
  if [ "$2" -eq 0 ]; then echo "ok    $1"; else echo "ECHEC $1"; echec=1; fi
}

# Aucun service n'écoute sur ces ports : tout doit être « impossible ».
export SONDE_SANS_CONTENEUR=1 SONDE_PORT_VALKEY=26379 SONDE_PORT_POSTGRES=25432 \
  SONDE_PORT_PGBOUNCER=26432 SONDE_PORT_OPENBAO=28200 SONDE_PORT_KEYCLOAK=28080 \
  SONDE_PORT_LITELLM=24000 SONDE_PORT_MAILPIT=28025 SONDE_ATTENTE=1

sortie="$(bash "$ici/sonde-services.sh" 2>&1)"; code=$?
verifier "[C-548] la sonde signale un service absent (sortie en erreur)" "$([ "$code" -ne 0 ]; echo $?)"
verifier "[C-548] la sonde écrit « Valkey : impossible »" "$(grep -q 'Valkey : impossible' <<<"$sortie"; echo $?)"

# Faux Valkey qui répond PONG : la sonde doit écrire « Valkey : démarré ».
python3 - 26379 <<'PY' &
import socketserver, sys
class H(socketserver.StreamRequestHandler):
    def handle(self):
        self.rfile.readline()
        self.wfile.write(b"+PONG\r\n")
class S(socketserver.TCPServer): allow_reuse_address = True
s = S(("127.0.0.1", int(sys.argv[1])), H); s.timeout = 5; s.handle_request(); s.handle_request()
PY
faux=$!
sleep 1
sortie="$(bash "$ici/sonde-services.sh" 2>&1)"
kill "$faux" 2>/dev/null
verifier "[C-548] la sonde écrit « Valkey : démarré » quand Valkey répond" "$(grep -q 'Valkey : démarré' <<<"$sortie"; echo $?)"

exit "$echec"
