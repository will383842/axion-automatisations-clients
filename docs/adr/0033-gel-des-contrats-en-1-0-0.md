# 0033 · Gel des contrats en 1.0.0

Date : 27/10/2026 · Statut : accepté par l'architecte des contrats (T0-30, après les trois relectures « GEL OK » du tour 2)

## Contexte
Le tour 2 de la relecture T0-30 (exactitude, sécurité, complétude) a rendu « GEL OK » sur `packages/contrats` (tête `be5e142`, fusionnée par la PR #82), sans bloquant, avec des points mineurs à régler dans la PR de gel. La fiche T0-30 cite C1 à C3, C5 et C6. L'ADR 0031 (exactitude 19) garde C5 en 0.x tant que le job de CI `contrats-pg` n'existe pas. `commun` (signature, erreurs, SIREN, adresse, période, terme), dont C1 à C3 et C6 dépendent, n'est pas cité par la fiche. Règle de tri : ce qui ne pourrait se corriger après le gel que par une v2 se corrige avant.

## Décision
### Ce qui est gelé, ce qui ne l'est pas
| Contrat | Version | Raison |
|---|---|---|
| commun | 1.0.0 | C1 à C3 et C6 en dépendent : on ne gèle pas un contrat sur une base mobile. |
| C1, C2, C3 | 1.0.0 | Fiche T0-30, relectures « GEL OK ». |
| C6 | 1.0.0 | Fiche T0-30, relecture sécurité « GEL OK ». |
| C4 | 0.3.0 | Non gelé : révision unique d'abord (ADR 0018), modes d'IA à venir (T4-49, T4-54). |
| C5 | 0.3.0 | Non gelé : le job `contrats-pg` n'existe pas (ADR 0031). Écart assumé avec la fiche, qui le citait. |

Le gel archive `fixtures/<contrat>/` des contrats gelés dans `fixtures-gelees/1.0.0/`. Le test d'archive relit chaque contrat archivé avec un contrôle propre (`src/archives.ts`) ; un dossier ou un fichier qu'aucun contrôle ne sait lire fait échouer le test.

### Corrections faites avant le gel
- **Plan C1 (complétude, point 1).** La ligne de facture de C2 rend obligatoires `codeAutomatisation` et `referenceAbonnementConsole`, qui ne peuvent venir que du plan. Ajoutés en champs facultatifs après le gel, ils laisseraient le Hub sans quoi remplir la ligne, et les rendre obligatoires serait une v2. Décision : ils sont **obligatoires** dans `POST /plans-recurrents` dès 1.0.0 (un plan = un abonnement = une automatisation, règle de Will). `prixMensuelHtCentimes` (T7-29) reste un ajout facultatif possible en 1.x.
- **Période de C1.** C1 garde {1, 6, 12} mois, sous-ensemble de `PeriodeMois` (1 à 12) de C2 et C3 : le récepteur C2 accepte plus large que ce que l'émetteur C1 peut demander, sans contradiction. L'élargissement viendra avec T7-29, Hub d'abord (additif). Un test vérifie l'inclusion.
- **Reprise dans la même seconde.** Le contrat ne change pas l'anti-rejeu. Chaque essai d'un envoi est re-signé avec un horodatage strictement plus récent que le précédent (`horodatageSuivant`) : la signature est neuve, le serveur ne le prend pas pour un rejeu, l'`Idempotency-Key` inchangée évite le doublon. `axion-dev publier` l'applique. `dejaVu` doit être un test-et-pose atomique (commentaire du contrat).
- **Cellule C4 (0.x).** Une seule forme, celle du coffre : minuscules, chiffres, tirets. `c4:<cellule>:<kid>` correspond à `technique/echanges/c4-<cellule>/<kid>` (`emplacementCoffre`).
- **Rôles C5 (0.x).** `rolesAdministration` devient une liste exacte de noms, vide par défaut : aucun rôle n'est exempté par la forme de son nom (ni `admin_app`, ni `<base>_proprietaire` du socle). Le lot 2b nomme ses rôles d'administration des bases `cli_`.
- **Documents.** `php/README.md` (fixtures et empreintes de commun, liste pour axion-ia), `README.md` (application de `x-axion-regles`), `CHANGELOG.md` (une route par phrase, entrée 1.0.0), en-tête de l'ADR 0024.

## Conséquences
- Dans la 1.x de commun, C1, C2, C3 et C6 : additif seulement, récepteur d'abord (ADR 0032).
- `contrats.sha256` (empreintes de commun, C1 à C6 et `VERSION`) est à publier dans le dépôt privé (`REPRENDRE-CONSTRUCTION.md`) par une autre routine, avec la révision datée de l'annexe A.
- C5 passe en 1.0.0 par une PR à part, une fois le job `contrats-pg` en place et exigé ; C4 après sa révision.
- Aucun workflow modifié.
