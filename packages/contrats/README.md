# @axion-auto/contrats

Contrats C1 à C6 de la console : schémas Zod 4, JSON Schema 2020-12 générés, fixtures signées avec des clés de TEST, empreintes.
Ce paquet fait foi (CLAUDE.md, section 5). Le texte des contrats est dans le dépôt privé (annexe A) ; ici, seulement le code.

## Ce qu'il contient
| Dossier | Contenu |
|---|---|
| `src/commun` | signature HTTP, anti-rejeu, codes d'erreur, argent, SIREN, SIRET, adresse, limites de débit, règles de fond |
| `src/c1` … `src/c6` | un dossier par contrat ; `src/c5` : contrôles du schéma des bases |
| `fixtures/<contrat>` | ce qui passe le fil : exemples valides et invalides signés, JSON Schema, constantes, invariants |
| `empreintes/<contrat>.sha256` | un SHA-256 par fichier de `fixtures/<contrat>/` (format de `sha256sum`) |
| `contrats.sha256` | sommaire : une ligne par fichier d'empreintes (commun et C5 compris) et une pour `VERSION` |
| `VERSION` | une version par contrat : commun, C1, C2, C3 et C6 gelés en 1.0.0 ; C4 et C5 en 0.x |
| `fixtures-gelees/1.0.0/` | fixtures du gel (commun, C1, C2, C3, C6) : leurs exemples valides le restent pour toujours |
| `CHANGELOG.md` | chaque changement, daté, par contrat |

## Règles de forme et de fond
- **Une seule règle de tolérance : strict partout.** Chaque objet refuse un champ inconnu, dans le schéma Zod comme dans le JSON Schema exporté (`additionalProperties: false`). C'est ce qui garantit la minimisation (aucun montant dans `plan.resume`, aucun e-mail en clair dans les consentements de C3).
- **Règles de fond.** Ce qu'un JSON Schema ne sait pas dire (clé de Luhn du SIREN, période ordonnée, HT + TVA = TTC) est appliqué par le schéma Zod et **nommé** dans le JSON Schema par le mot-clé `x-axion-regles`. Tout récepteur qui valide par le JSON Schema applique ces règles (liste fermée : `src/commun/regles-fond.ts`, recopiée dans `fixtures/commun/constantes.json`). Le test `json-schema.test.ts` vérifie, avec ajv, que les JSON Schema commités et Zod rendent le même verdict sur chaque fixture.
  - **Avec ajv** (réglé par défaut en `strict`, il refuse sinon de compiler : « unknown keyword ») : déclarer le mot-clé, puis coder chaque règle nommée comme `src/commun/regles-fond.ts` :
    `ajv.addKeyword({ keyword: "x-axion-regles", schemaType: "array", validate: (noms, donnee) => noms.every((n) => REGLES_FOND[n](donnee)) })` (exemple complet : `src/json-schema.test.ts`).
  - **Avec tout autre validateur**, qui ignore souvent ce mot-clé sans rien dire : ces règles (Luhn, période ordonnée, HT + TVA = TTC) doivent être codées à part et appliquées après la validation du schéma. Un récepteur qui ne les applique pas n'est pas conforme.
- **Règles métier** (ex. : TVA de 20 % pour l'activité « automatisation », `src/c1/regles.ts`) : refus en 422 avec leur code, jamais dans le schéma.
- Argent : centimes et points de base entiers, positifs ou nuls ; un montant à 0 est permis (le prix informe, il ne bloque jamais).

## Régénérer
```sh
node scripts/signer-fixtures.ts                 # C1, C2, C4, commun, C5, C6
ECRIRE_FIXTURES_C3=1 pnpm test -- c3             # C3 (construit dans son test)
node scripts/empreinte.ts                        # empreintes/ et contrats.sha256
```
Contrôle de l'autre côté : `sha256sum --check --strict empreintes/<contrat>.sha256` depuis une copie de `fixtures/<contrat>/` (voir `php/README.md`).

## Évolution et compatibilité (ADR 0032)
### Avant le gel (0.x : C4 et C5 aujourd'hui)
Tout changement passe par un ADR et l'accord de l'architecte, monte la version mineure du contrat dans `VERSION`, s'écrit dans `CHANGELOG.md`, régénère fixtures et empreintes. Une rupture reste permise, mais elle est écrite comme telle.

### Le gel en 1.0.0 (fait le 27/10/2026, ADR 0033 : commun, C1, C2, C3, C6)
Décidé après une nouvelle relecture complète (T0-30). La PR de gel, et elle seule :
1. passe les contrats gelés à `1.0.0` dans `VERSION` (C4 reste en 0.x jusqu'à sa révision) ;
2. copie `fixtures/<contrat>/` dans `fixtures-gelees/1.0.0/<contrat>/` : ces exemples valides restent valides pour toujours (test `[C-538]`) ;
3. régénère les empreintes et `contrats.sha256`, puis publie `contrats.sha256` dans le dépôt privé.
C5 ne passe en 1.0.0 que si le job de CI `contrats-pg` existe et tourne sur chaque PR.

### Dans la 1.x : additif seulement
Permis : un champ **facultatif** (avec sa valeur d'absence écrite : l'absence garde le sens de la version précédente), une valeur d'énumération, un type de fait ou d'événement, une route, un code d'erreur, un élargissement de borne.
Interdit (v2 et ADR) : retirer ou renommer un champ, une valeur ou une route ; rendre un champ obligatoire ; rétrécir un type ; changer le sens d'une valeur.

**Récepteur d'abord**, pour un champ comme pour une valeur d'énumération (les schémas sont stricts) :
1. PR de contrat ici : schéma, fixtures, `CHANGELOG.md`, version mineure (`1.x.0`), empreintes ; ADR si le sens change.
2. Le **récepteur** déploie le nouveau schéma (il accepte, n'envoie rien de neuf). Pour C1, le récepteur est le Hub (axion-ia) ; pour C2, la console ; pour C3, le CRM ou la console selon le sens ; pour C4, la console ou l'exécuteur.
3. L'**émetteur** déploie ensuite seulement, et commence à envoyer le nouveau champ ou la nouvelle valeur.
4. Ordre entre les trois dépôts : ce dépôt d'abord (la PR de contrat), puis le dépôt du récepteur avec les fixtures et l'empreinte copiées dans la même PR, puis celui de l'émetteur. Tant que l'autre dépôt n'a pas copié, son test d'empreinte est rouge : c'est le signal voulu, la PR qui copie le remet au vert.
Une correction sans changement de forme (commentaire, test) : version de correctif (`1.x.y`), empreintes inchangées si les fixtures le sont.

**Reprise d'un envoi.** Chaque essai est re-signé avec un horodatage strictement plus récent que l'essai précédent (`horodatageSuivant` de `src/commun/signature.ts`) et garde la même `Idempotency-Key` : une reprise dans la même seconde, après une coupure qui a laissé le serveur garder la première signature, n'est jamais un `rejeu`. L'anti-rejeu reste entier : une signature n'est acceptée qu'une fois, par une mémoire à test-et-pose atomique.

### Ce que garde chaque version
`CHANGELOG.md` : une entrée par version, par contrat, avec la date, l'ADR et la liste des champs ou valeurs ajoutés. `contrats.sha256` résume l'état exact ; deux PR de contrats qui le touchent entrent en conflit : on le règle en relançant `node scripts/empreinte.ts`, jamais à la main.
