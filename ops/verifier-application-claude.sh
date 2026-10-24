#!/usr/bin/env bash
# Vérifie que l'application GitHub de Claude ne réagit qu'aux comptes internes (C-529, 2e partie). Lecture seule.
# Lancé par le chef d'orchestre (jeton d'application ou droits d'administration).
# Usage : ops/verifier-application-claude.sh [proprietaire/depot]
# La sortie datée est la preuve à inscrire dans spec/preuves.md.
set -u
command -v gh >/dev/null 2>&1 || { echo "À CORRIGER gh introuvable : rien n'a pu être vérifié"; exit 1; }
DEPOT="${1:-will383842/axion-automatisations-clients}"
mauvais=0
verdict() { # $1 = libellé, $2 = 0 si OK
  if [ "$2" -eq 0 ]; then echo "OK         $1"; else echo "À CORRIGER $1"; mauvais=1; fi
}

# 1. Droits de l'application installée, lus avec le jeton de l'utilisateur (user/installations), pas avec un JWT d'application.
# Filtre sur l'application de Claude ; si elle n'est pas trouvée, on ne sait pas, donc on échoue.
if droits=$(gh api user/installations --paginate --jq '.installations[] | select(.app_slug | test("claude")) | .permissions | to_entries[] | "\(.key)=\(.value)"' 2>/dev/null) && [ -n "$droits" ]; then
  echo "Droits de l'application installée :"
  printf '  %s\n' "$droits"
  printf '%s\n' "$droits" | grep -qx 'statuses=write' ; [ $? -ne 0 ] ; verdict "l'application n'a pas statuses: write (sinon : contrôle d'auteur de ops/fusionner-pr.sh)" $?
else
  echo "À CORRIGER droits de l'application : application Claude introuvable parmi les installations de l'utilisateur, à relever à la main"
  mauvais=1
fi

# 2. Accord exigé pour la CI des contributeurs extérieurs.
gh api "repos/$DEPOT/actions/permissions/fork-pr-contributor-approval" --jq '.approval_policy' 2>/dev/null | grep -qx 'all_external_contributors' ; verdict "accord exigé pour la CI des contributeurs extérieurs" $?

# 3. Configuration qui limite le déclenchement aux comptes internes : lue dans les workflows du dépôt (branche par défaut).
# Valeurs permises : will383842 et les comptes des routines (liste dans le réglage, jamais « * »).
fichiers=$(gh api "repos/$DEPOT/contents/.github/workflows" --jq '.[].path' 2>/dev/null)
lancent=0; limitent=0
for f in $fichiers; do
  texte=$(gh api -H "Accept: application/vnd.github.raw" "repos/$DEPOT/contents/$f" 2>/dev/null) || continue
  printf '%s' "$texte" | grep -q 'anthropics/claude-code-action' || continue
  lancent=1
  # allowed_non_write_users élargit l'accès, et toute valeur « * » ouvre à tous : l'un ou l'autre fait échouer.
  if printf '%s' "$texte" | grep -q 'allowed_non_write_users' || printf '%s' "$texte" | grep -E 'allowed_actors|allowed_bots' | grep -q '\*'; then limitent=0; break; fi
  if printf '%s' "$texte" | grep -q 'allowed_actors'; then limitent=1; else limitent=0; break; fi
done
if [ "$lancent" -eq 0 ]; then
  echo "OK         aucun workflow ne lance l'action Claude (l'application seule reste à régler côté GitHub)"
else
  [ "$limitent" -eq 1 ] ; verdict "le workflow qui lance l'action Claude limite les acteurs (allowed_actors sans « * », sans allowed_non_write_users)" $?
fi

echo "Date : $(date -u +%Y-%m-%dT%H:%MZ)"
exit "$mauvais"
