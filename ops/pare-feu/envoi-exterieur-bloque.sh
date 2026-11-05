#!/usr/bin/env bash
# Test de nuit « envoi extérieur bloqué » (C-533) : depuis chaque réseau INTERNE du socle lancé, une connexion vers l'extérieur doit échouer,
# alors que la même sonde joint le piège à courriels (preuve que la sonde fonctionne : sans elle, un échec ne prouverait rien).
# Usage : IMAGE_SONDE=<image avec bash et timeout> bash ops/pare-feu/envoi-exterieur-bloque.sh
# Variables : SOCLE_PROJET (défaut socle) · CIBLE_EXTERIEURE_HOTE / _PORT (défaut exemple.fr, 25 : nom fictif) · PIEGE_HOTE / PIEGE_PORT (défaut greenmail, 25)
# Sortie : 0 tout est bloqué et le piège répond ; 1 un réseau laisse sortir, ou le piège est muet ; 2 prérequis absent.
set -u
projet="${SOCLE_PROJET:-socle}"
hote="${CIBLE_EXTERIEURE_HOTE:-exemple.fr}"; port="${CIBLE_EXTERIEURE_PORT:-25}"
piege="${PIEGE_HOTE:-greenmail}"; piege_port="${PIEGE_PORT:-25}"
command -v docker >/dev/null 2>&1 || { echo "envoi-exterieur : docker absent, rien n'est constaté" >&2; exit 2; }
[ -n "${IMAGE_SONDE:-}" ] || { echo "envoi-exterieur : IMAGE_SONDE manquante" >&2; exit 2; }

sonder() { # réseau hôte port : 0 si la connexion réussit
  docker run --rm --network "$1" "$IMAGE_SONDE" bash -c 'timeout 3 bash -c "exec 3<>/dev/tcp/$0/$1"' "$2" "$3" >/dev/null 2>&1
}
reseaux=()
while IFS='|' read -r nom interne; do
  [ "$interne" = "true" ] && reseaux+=("$nom")
done < <(docker network ls --filter "label=com.docker.compose.project=$projet" --format '{{.Name}}|{{.Internal}}')
[ "${#reseaux[@]}" -gt 0 ] || { echo "envoi-exterieur : aucun réseau interne trouvé pour le projet $projet" >&2; exit 2; }

erreur=0
for r in "${reseaux[@]}"; do
  if sonder "$r" "$hote" "$port"; then echo "ECHEC : le réseau $r laisse sortir un envoi vers l'extérieur"; erreur=1; fi
done
if ! sonder "${reseaux[0]}" "$piege" "$piege_port"; then echo "ECHEC : le piège à courriels ne répond pas (le constat serait sans valeur)"; erreur=1; fi
[ "$erreur" = 0 ] && echo "envoi extérieur bloqué sur ${#reseaux[@]} réseau(x) interne(s) ; piège à courriels joignable"
exit "$erreur"
