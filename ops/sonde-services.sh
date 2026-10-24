#!/usr/bin/env bash
# [C-548] Sonde des 7 services de test : « démarré » ou « impossible » pour chacun.
# Usage : bash ops/sonde-services.sh   (SONDE_SANS_CONTENEUR=1 : ne rien lancer, constater seulement)
set -u
ici="$(cd "$(dirname "$0")" && pwd)"
attente="${SONDE_ATTENTE:-170}"  # délai GLOBAL pour les 7 services (fiche : moins de 3 minutes)
p_pg="${SONDE_PORT_POSTGRES:-5432}"; p_pb="${SONDE_PORT_PGBOUNCER:-6432}"
p_vk="${SONDE_PORT_VALKEY:-6379}"; p_ob="${SONDE_PORT_OPENBAO:-8200}"
p_kc="${SONDE_PORT_KEYCLOAK:-9000}"; p_ll="${SONDE_PORT_LITELLM:-4000}"
p_mp="${SONDE_PORT_MAILPIT:-8025}"
erreurs=0
docker_ok=0

if [ -z "${SONDE_SANS_CONTENEUR:-}" ]; then
  if docker info >/dev/null 2>&1; then
    docker_ok=1
    echo "Conteneurs : disponibles"
    docker compose -f "$ici/compose.test.yml" up -d >/dev/null 2>&1 || echo "Conteneurs : lancement en échec"
  else
    echo "Conteneurs : indisponibles dans cette session (parade : voir ops/environnement-cloud.md)"
    attente=0  # rien ne va démarrer : constater tout de suite
    # Parade constatée : PostgreSQL par binaires du gestionnaire de paquets, si présents.
    pgbin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
    if [ -n "$pgbin" ] && [ "$(id -u)" -ne 0 ] && ! pg_isready -q -p "$p_pg" 2>/dev/null; then
      d="$(mktemp -d)"
      # Rien ne reste lancé après la sonde : arrêt et effacement à la sortie.
      trap '"$pgbin/pg_ctl" -D "$d" stop -m fast >/dev/null 2>&1; rm -rf "$d"' EXIT
      "$pgbin/initdb" -D "$d" -A trust >/dev/null 2>&1 \
        && "$pgbin/pg_ctl" -D "$d" -o "-p $p_pg -c listen_addresses=127.0.0.1" -l "$d/log" -w start >/dev/null 2>&1
    fi
  fi
fi

fin=$((SECONDS + attente))  # échéance unique, partagée par les 7 services
attendre() { # commande... : réessaie jusqu'à l'échéance globale
  until "$@" >/dev/null 2>&1; do [ "$SECONDS" -ge "$fin" ] && return 1; sleep 1; done
}
http() { curl -fsS -m 3 "$1" >/dev/null; }
valkey_ping() { # PING brut sur TCP, sans client installé
  exec 3<>"/dev/tcp/127.0.0.1/$p_vk" || return 1
  printf 'PING\r\n' >&3; read -r -t 3 rep <&3; exec 3>&- 3<&-
  [[ "$rep" == +PONG* ]]
}
pgbouncer_ok() {
  pg_isready -q -h 127.0.0.1 -p "$p_pb" || return 1
  [ "$docker_ok" = 0 ] || docker compose -f "$ici/compose.test.yml" config 2>/dev/null | grep -q 'POOL_MODE: transaction'
}
noter() { # nom, commande...
  local nom="$1"; shift
  if attendre "$@"; then echo "$nom : démarré"; else echo "$nom : impossible"; erreurs=1; fi
}

noter "PostgreSQL 16" pg_isready -q -h 127.0.0.1 -p "$p_pg"
noter "PgBouncer" pgbouncer_ok
noter "Valkey" valkey_ping
noter "OpenBao" http "http://127.0.0.1:$p_ob/v1/sys/health"
noter "Keycloak" http "http://127.0.0.1:$p_kc/health/ready"
noter "LiteLLM" http "http://127.0.0.1:$p_ll/health/liveliness"
noter "Mailpit" http "http://127.0.0.1:$p_mp/api/v1/info"
exit "$erreurs"
