#!/usr/bin/env bash
# [A-079] [C-533] Recette intégrée du socle : rejoue les parcours qui ne dépendent que du socle,
# avec des données fictives, contre la recette (conteneurs de test) et jamais contre la production.
# Seul écrit hors dépôt : le piège à e-mails (Mailpit local).
# Usage : bash ops/recette/rejouer-socle.sh
#   RECETTE_CIBLE=recette (défaut) | RECETTE_A_BLANC=1 : contrôles seulement, rien n'est lancé.
set -u
ici="$(cd "$(dirname "$0")" && pwd)"
racine="$(cd "$ici/../.." && pwd)"

refuser() { echo "refus : $1" >&2; exit 2; }

# --- Garde 1 (A-079) : la cible doit être la recette locale.
cible="${RECETTE_CIBLE:-recette}"
[ "$cible" = "recette" ] || refuser "la cible doit être « recette » (cible reçue non acceptée)"
for v in AXION_ENV NODE_ENV; do
  case "$(printf '%s' "${!v:-}" | tr '[:upper:]' '[:lower:]')" in
    prod|production) refuser "$v désigne la production" ;;
  esac
done

# --- Garde 2 (C-533) : le seul destinataire d'e-mails est le piège local ; on cite le NOM de la variable, jamais sa valeur.
hote_de() { local h="${1#*://}"; h="${h%%/*}"; h="${h%%:*}"; printf '%s' "$h"; }
local_ok() { case "$(hote_de "$1")" in 127.0.0.1|localhost|mailpit) return 0 ;; *) return 1 ;; esac; }
for v in SMTP_HOTE MAILPIT_API MAILPIT_SMTP_HOTE; do
  [ -z "${!v:-}" ] || local_ok "${!v}" || refuser "$v ne vise pas le piège à e-mails local"
done
api="${MAILPIT_API:-http://127.0.0.1:8025}"

echo "cible : recette (conteneurs de test)"
echo "e-mails : piège à e-mails seulement ($(hote_de "$api"))"
[ -z "${RECETTE_A_BLANC:-}" ] || { echo "à blanc : contrôles réussis, rien n'est lancé"; exit 0; }

# --- Lancement : conteneurs de test, sonde, puis parcours.
if docker info >/dev/null 2>&1; then
  docker compose -f "$racine/ops/compose.test.yml" up -d >/dev/null 2>&1 || echo "conteneurs : lancement en échec"
else
  echo "conteneurs : indisponibles ici (parcours qui en ont besoin : échoué)"
fi
bash "$racine/ops/sonde-services.sh" || echo "sonde : au moins un service absent"

reussis=0; echoues=0
# Parcours du socle : les scénarios de tests/e2e/scenarios. Un parcours qui dépend d'un lot absent échoue : il est consigné, pas inventé.
for f in "$racine"/tests/e2e/scenarios/*.test.ts; do
  nom="$(basename "$f" .test.ts)"
  if (cd "$racine" && pnpm vitest run --project tests/e2e "$f" >/dev/null 2>&1); then
    echo "parcours $nom : réussi"; reussis=$((reussis + 1))
  else
    echo "parcours $nom : échoué ou non couvert (voir le lot concerné)"; echoues=$((echoues + 1))
  fi
done

# Contrôle final (C-533) : ce que le piège a reçu, sans contenu.
n="$(curl -fsS -m 3 "$api/api/v1/messages" 2>/dev/null | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)"
echo "piège à e-mails : ${n:-inconnu} message(s) reçu(s)"
echo "bilan : $reussis réussi(s), $echoues échoué(s) ou non couvert(s)"
[ "$echoues" -eq 0 ]
