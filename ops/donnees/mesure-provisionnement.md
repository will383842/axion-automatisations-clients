# Mesure A-223 : création d'une base client en moins de 2 minutes

Seuil : 120 secondes par création de bout en bout (constante `SEUIL_CREATION_MS` de `apps/api/src/provisionnement/etapes-fin.ts`, jamais relevée). Critère C-473 : `tests/e2e/scenarios/c-473-provisionnement-deux-minutes.test.ts`.

## Méthode
- Cinq créations successives de bout en bout, chacune chronométrée par `mesurerCreations` ; on garde la médiane et le maximum, et chaque durée doit rester sous le seuil.
- Si la CI dépasse le seuil à cause du lanceur, on note le détail par étape (neuf étapes) ; on ne relève jamais le seuil.
- Résultat à écrire ici par la CI : une ligne produite par `formaterMesure` (date, machine de la CI, médiane, maximum).

## Résultat
Aucune mesure réelle à ce jour : les adaptateurs réels des étapes 4, 5, 8 et 9 et le Worker ne sont pas encore branchés (dette `LOT2-dette-T2-35` de `spec/preuves.md`). Les essais sur une vraie grappe PostgreSQL (étapes 2, 3 et 6) tournent en moins d'une seconde par base sur un poste de travail, ce qui ne dit rien de la chaîne complète.

Conclusion : non mesuré ; A-223 reste ouverte.
