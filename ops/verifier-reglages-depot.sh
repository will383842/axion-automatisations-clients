#!/usr/bin/env bash
# Vérifie les réglages du dépôt (C-529, C-530, C-554). Lecture seule : ne modifie rien.
# Lancé par le chef d'orchestre (droits d'administration). Usage : ops/verifier-reglages-depot.sh [proprietaire/depot] [dossier-workflows]
set -u
command -v gh >/dev/null 2>&1 || { echo "À CORRIGER gh introuvable : rien n'a pu être vérifié"; exit 1; }
DEPOT="${1:-will383842/axion-automatisations-clients}"
FICHE_CONTROLES=(
  "Aucun secret dans le dépôt (Gitleaks)" types lint tests garde-workflows compter-tests licences
  couverture-req garde-fusion garde-couleurs harnais contrats-pg visuel-design
)
mauvais=0
verdict() { # $1 = libellé, $2 = 0 si OK
  if [ "$2" -eq 0 ]; then echo "OK         $1"; else echo "À CORRIGER $1"; mauvais=1; fi
}
api() { gh api "repos/$DEPOT$1" "${@:2}" 2>/dev/null; }

sa=$(api "" --jq '.security_and_analysis')
echo "$sa" | grep -q '"secret_scanning":{"status":"enabled"' ; verdict "analyse des secrets active" $?
echo "$sa" | grep -q '"secret_scanning_push_protection":{"status":"enabled"' ; verdict "protection des poussées active" $?

api "/actions/permissions/fork-pr-contributor-approval" --jq '.approval_policy' | grep -qxE 'all_external_contributors|first_time_contributors' ; verdict "accord exigé pour la CI des contributeurs extérieurs" $?
echo "$sa" | grep -q '"dependabot_security_updates":{"status":"enabled"' ; verdict "mises à jour de sécurité de Dependabot actives" $?

api "/actions/permissions/workflow" --jq '.default_workflow_permissions' | grep -qx read ; verdict "droits par défaut du GITHUB_TOKEN en lecture" $?
api "/private-vulnerability-reporting" --jq '.enabled' | grep -qx true ; verdict "signalement privé des failles actif" $?
api "" --jq '.has_issues' | grep -qx false ; verdict "tickets vierges désactivés" $?
# Toute fusion passe par ops/fusionner-pr.sh du chef (statut garde-fusion) : la fusion automatique de GitHub la contournerait (C-611).
api "" --jq '.allow_auto_merge' | grep -qx false ; verdict "fusion automatique désactivée" $?

controles_exiges=$(api "/branches/main/protection/required_status_checks" --jq '.contexts[]?, .checks[]?.context')
for c in "${FICHE_CONTROLES[@]}"; do
  printf '%s\n' "$controles_exiges" | grep -qxF "$c" ; verdict "main exige le contrôle « $c »" $?
done

# L'application GitHub de Claude ne doit PAS pouvoir écrire les statuts de commit (sinon un statut garde-fusion forgé passerait).
# Cet appel exige un jeton d'application : s'il échoue, on ne sait pas, et on échoue (jamais de OK par défaut).
if perm=$(gh api "repos/$DEPOT/installation" --jq '.permissions.statuses' 2>/dev/null) && [ -n "$perm" ]; then
  [ "$perm" != "write" ] ; verdict "l'application Claude n'a pas statuses: write (sinon un statut garde-fusion pourrait être forgé)" $?
else
  echo "À CORRIGER statuses de l'application Claude : non vérifiable ici, à vérifier à la main (réglages de l'application installée)"
  mauvais=1
fi

# Environnements de déploiement (C-388, C-389). Une réponse vide ou illisible ne vaut jamais OK.
api "/environments/production" --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?] | length' | grep -qE '^[1-9][0-9]*$' ; verdict "l'environnement production exige un réviseur" $?
for env in production recette; do
  api "/environments/$env/deployment-branch-policies" --jq '[.branch_policies[].name] | join(",")' | grep -qx main ; verdict "l'environnement $env est limité à la branche main" $?
done
api "/actions/secrets" --jq '[.secrets[].name | select(test("COOLIFY|DEPLOY|DEPLOI";"i"))] | length' | grep -qx 0 ; verdict "aucun secret de déploiement au niveau du dépôt (ils vivent dans les environnements)" $?

# Aucun workflow du dépôt ne doit pouvoir poser un statut ou un contrôle : on relance la garde sur les fichiers présents (2e argument : dossier à lire).
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
DOSSIER_WF="${2:-$RACINE/.github/workflows}"
sortie_garde=""
if [ -d "$DOSSIER_WF" ]; then
  sortie_garde=$(node "$RACINE/scripts/garde-workflows.ts" "$DOSSIER_WF" 2>&1)
  code_garde=$?
else
  code_garde=2
fi
garde=$(printf '%s\n' "$sortie_garde" | grep -E 'permission (statuses|checks): write interdite')
if [ -n "$garde" ]; then
  verdict "aucun workflow ne demande statuses: write ni checks: write" 1
  printf '%s\n' "$garde"
elif [ "$code_garde" -eq 0 ]; then
  verdict "aucun workflow ne demande statuses: write ni checks: write" 0
elif [ "$code_garde" -eq 1 ]; then
  # La garde refuse un autre point : ce n'est pas l'objet de cette ligne, mais ce n'est pas un OK non plus.
  verdict "workflows non vérifiables pour statuses et checks : la garde a refusé d'autres points (lancer node scripts/garde-workflows.ts)" 1
else
  verdict "workflows non vérifiables pour statuses et checks : dossier absent ou garde en échec (code $code_garde)" 1
fi

echo "Date : $(date -u +%Y-%m-%dT%H:%MZ)"
exit "$mauvais"
