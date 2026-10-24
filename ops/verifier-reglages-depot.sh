#!/usr/bin/env bash
# Vérifie les réglages du dépôt (C-529, C-530, C-554). Lecture seule : ne modifie rien.
# Lancé par le chef d'orchestre (droits d'administration). Usage : ops/verifier-reglages-depot.sh [proprietaire/depot]
set -u
DEPOT="${1:-will383842/axion-automatisations-clients}"
FICHE_CONTROLES=(
  "Aucun secret dans le dépôt (Gitleaks)" types lint tests garde-workflows compter-tests licences
  couverture-req garde-noms garde-couleurs harnais contrats-pg visuel-design
)
mauvais=0
verdict() { # $1 = libellé, $2 = 0 si OK
  if [ "$2" -eq 0 ]; then echo "OK         $1"; else echo "À CORRIGER $1"; mauvais=1; fi
}
api() { gh api "repos/$DEPOT$1" "${@:2}" 2>/dev/null; }

sa=$(api "" --jq '.security_and_analysis')
echo "$sa" | grep -q '"secret_scanning":{"status":"enabled"' ; verdict "analyse des secrets active" $?
echo "$sa" | grep -q '"secret_scanning_push_protection":{"status":"enabled"' ; verdict "protection des poussées active" $?

api "/actions/permissions/fork-pr-contributor-approval" --jq '.approval_policy' | grep -qE 'all_external_contributors|first_time_contributors' ; verdict "accord exigé pour la CI des contributeurs extérieurs" $?
api "/actions/permissions/workflow" --jq '.default_workflow_permissions' | grep -qx read ; verdict "droits par défaut du GITHUB_TOKEN en lecture" $?
api "/private-vulnerability-reporting" --jq '.enabled' | grep -qx true ; verdict "signalement privé des failles actif" $?
api "" --jq '.has_issues' | grep -qx false ; verdict "tickets vierges désactivés" $?

exigés=$(api "/branches/main/protection/required_status_checks" --jq '.contexts[]?, .checks[]?.context')
for c in "${FICHE_CONTROLES[@]}"; do
  printf '%s\n' "$exigés" | grep -qxF "$c" ; verdict "main exige le contrôle « $c »" $?
done

# L'application GitHub de Claude ne doit PAS pouvoir écrire les statuts de commit (sinon un statut garde-noms forgé passerait).
perm=$(gh api "repos/$DEPOT/installation" --jq '.permissions.statuses' 2>/dev/null || true)
[ "$perm" != "write" ] ; verdict "l'application Claude n'a pas statuses: write (sinon : contrôle d'auteur de ops/fusionner-pr.sh)" $?

echo "Date : $(date -u +%Y-%m-%dT%H:%MZ)"
exit "$mauvais"
