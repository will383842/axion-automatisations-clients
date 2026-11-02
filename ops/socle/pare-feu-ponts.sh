#!/usr/bin/env bash
# Pare-feu de l'hôte pour les ponts des réseaux Docker marqués « internal » (C-533, T1B-12 point 3).
# « internal: true » coupe la sortie vers Internet mais ne protège PAS l'hôte : par l'adresse du pont, un conteneur joint tout service
# de l'hôte qui écoute sur toutes les interfaces (SSH, Coolify). Ce script refuse, dans la chaîne INPUT, tout trafic venant de ces ponts.
#  - Les réponses aux connexions déjà établies (hôte vers conteneur : essais, vérifications de santé) restent acceptées.
#  - Aucune exception DNS : la résolution des noms du réseau est faite par Docker dans l'espace réseau du conteneur, elle ne passe pas par INPUT.
#  - Le trafic entre conteneurs du même réseau passe par FORWARD : il n'est pas touché.
#  - Aucune adresse écrite ici : les ponts viennent de « docker network inspect ». Le pont du réseau de sortie contrôlée n'est pas interne : il garde ses règles.
# Idempotent (chaîne SOCLE-PONTS recréée vide puis remplie, un seul saut depuis INPUT). Échoue si une règle ne s'applique pas : jamais un socle sans pare-feu.
# Utilisé par ops/socle/lancer.sh, et par le serveur de test (T1B-09 reprend cette règle sans la réécrire).
set -euo pipefail

CHAINE="SOCLE-PONTS"
if [ "$(uname -s)" != "Linux" ]; then
  echo "pare-feu-ponts : hôte non Linux, aucune règle posée (les conteneurs tournent dans une machine virtuelle)" >&2
  exit 0
fi
if [ "$(id -u)" = "0" ]; then sudo=(); else sudo=(sudo -n); fi
regle() {
  local outil="$1"
  shift
  ${sudo[@]+"${sudo[@]}"} "$outil" -w 5 "$@"
}

# Nom des interfaces des ponts internes : l'option Docker si elle existe, sinon br-<12 premiers caractères de l'identifiant>.
ponts=()
while read -r reseau; do
  [ -n "$reseau" ] || continue
  IFS='|' read -r interne identifiant option <<<"$(docker network inspect -f '{{.Internal}}|{{.Id}}|{{index .Options "com.docker.network.bridge.name"}}' "$reseau")"
  [ "$interne" = "true" ] || continue
  ponts+=("${option:-br-${identifiant:0:12}}")
done < <(docker network ls --filter driver=bridge -q)

appliquer() {
  local outil="$1" pont
  regle "$outil" -N "$CHAINE" 2>/dev/null || true
  regle "$outil" -F "$CHAINE"
  for pont in ${ponts[@]+"${ponts[@]}"}; do
    regle "$outil" -A "$CHAINE" -i "$pont" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    regle "$outil" -A "$CHAINE" -i "$pont" -j REJECT
  done
  regle "$outil" -C INPUT -j "$CHAINE" 2>/dev/null || regle "$outil" -I INPUT 1 -j "$CHAINE"
}

appliquer iptables
# IPv6 : les réseaux du socle n'ont pas d'IPv6 ; la même règle est posée si l'outil le permet, sans bloquer le lancement sinon.
if command -v ip6tables >/dev/null 2>&1; then
  appliquer ip6tables || echo "pare-feu-ponts : ip6tables indisponible, règles IPv6 non posées" >&2
fi
echo "pare-feu-ponts : ${#ponts[@]} pont(s) interne(s) filtré(s)"
