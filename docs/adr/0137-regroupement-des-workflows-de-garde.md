# 0137 · Regroupement des workflows de garde

Date : 07/11/2026 · Statut : proposé, à accepter par l'architecte · Contrat touché : aucun · Migration : aucune

## Contexte
- Chaque push de PR lançait 33 jobs ; la file GitHub est partagée par toutes les sessions et les petites gardes coûtaient chacune une installation complète.
- Les gardes des couleurs, des données réelles et des migrations, le harnais et les squelettes web étaient des workflows à part, sans lien entre eux.

## Décision
1. `garde-briques.yml` porte désormais les gardes des données réelles (avant l'installation, comme avant), des couleurs et des migrations, avec les mêmes commandes. Les deux dernières ont `if: always()` : l'échec d'une garde n'en masque pas une autre. L'installation reste sans condition (liste blanche de `garde-licences`).
2. Les jobs `harnais` et `squelettes-web` passent tels quels dans `ci.yml`, mêmes déclencheurs.
3. Cinq fichiers sont supprimés ; leurs noms sortent de la liste `workflows:` de `controle-journaux.yml` (rien d'autre n'y change).
4. `scripts/inventaire-gardes.test.ts` fige l'ensemble des gardes lancées sur chaque PR, l'absence de `paths`, les cinq contrôles exigés par `main` sans condition (sauf l'agrégateur du socle) et le nom exact du job Gitleaks.

## Conséquences
- Aucune garde retirée ; la protection de `main` ne change pas (Gitleaks, tests, licences, garde-workflows, socle-integration).
- Limite : si la garde des données réelles échoue, l'installation est sautée et `garde-briques` (sans `if`, exigé par un test) ne tourne pas ; la PR reste rouge.
- Les anciens noms de contrôle `garde-couleurs`, `garde-donnees`, `garde-migrations`, `harnais` et `squelettes-web` n'existent plus : `ops/verifier-reglages-depot.sh` les liste encore et devra être mis à jour par le chef.
