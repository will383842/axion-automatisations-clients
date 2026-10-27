# 0031 · Corrections des contrats après la relecture T0-30

Date : 26/10/2026 · Statut : accepté par l'architecte des contrats ; le gel en 1.0.0 n'est PAS décidé ici (nouvelle relecture d'abord)

## Contexte
Les trois relectures finales de T0-30 (sécurité, exactitude, complétude) ont rendu NON sur `packages/contrats` (`main` 8c4fd76). Règle de tri de la complétude : est bloquant ce qui, après le gel, ne pourrait se corriger que par une v2. Règles de Will à respecter : abonnements indépendants (une automatisation = un abonnement), aucun envoi commercial automatique, aucune suppression de données de personnes, deux modes d'IA (`client_direct`, `via_axion`) par automatisation, le prix informe sans jamais bloquer.

## Décision
Tous les contrats restent en 0.x (`VERSION` : commun 0.2.0, C1 à C3 0.2.0, C4 0.2.1, C5 0.2.0, C6 0.1.1). Chaque défaut est corrigé, ou renvoyé à un lot précis parce que sa correction est additive après le gel.

### Sécurité
| # | Décision |
|---|---|
| 1 | Corrigé. `verifier(cles, requete, maintenant, dejaVu)` choisit le secret par `X-Axion-Cle`, rend `{ ok: true, cle }`, appelle `dejaVu(cle, signature)` seulement après une signature valide dans la fenêtre et refuse un rejeu en 401 `rejeu` ; une panne de `dejaVu` est un refus. `EN_TETES` nomme `Idempotency-Key`, `Idempotency-Replayed`, `Retry-After` ; chaque route dit sa règle anti-doublon (`antiDoublon`). |
| 2 | Corrigé. `axiCli` obligatoire dans le corps de `POST /devis`, `/plans-recurrents`, `/factures-ponctuelles` (le corps, pas le chemin : l'empreinte d'idempotence couvre ainsi le client) ; `codeAutomatisation` sur la facture ponctuelle. |
| 3 | Corrigé (C4 0.2.1, additif). Clé de cellule `c4:<cellule>:<n>` ; `controlerLecture` et `controlerPaquet` (`src/c4/cellule.ts`) : 403 `action_interdite` pour toute instance d'une autre cellule ; un paquet mixte est refusé en entier ; fixture `fixtures/c4/cellules.json`. |
| 4 | Corrigé. `LIMITES_DEBIT` pour C1 (60/min, alerte à 10 refus/min), C2 (120/min), C3 (60/min par sens et pour la lecture), C4 (600/min par clé de cellule), C6 (10/min par adresse) ; 429 toujours avec `Retry-After` de 1 à 60 s ; test : chaque route a sa limite. Valeurs techniques posées par l'architecte, réglables par une version mineure. |
| 5 | Corrigé. `REACTIONS_CONSOLE` (C3) : `effacement.demande` coupe les envois commerciaux, met la personne à l'écart, alerte Will et attend sa décision ; aucune action de suppression n'existe (test). |
| 6 | Corrigé. Règle C5 `base_cli_partagee` : un rôle (hors superutilisateur et administration) qui ouvre plus d'une base `cli_%` est signalé. |

### Exactitude
| # | Décision |
|---|---|
| 1 | Corrigé (voir sécurité 2) ; la facture ponctuelle porte aussi ses `lignes` et `acompteBps` (0 à 10 000). |
| 2 | Corrigé. Une seule règle : **strict partout** (Zod `strictObject`, JSON Schema `additionalProperties: false`). L'ajout d'un champ suit donc « récepteur d'abord », comme une valeur d'énumération (ADR 0032). |
| 3 | Corrigé. Période d'une facture d'abonnement par union sur `nature` (exprimée en JSON Schema) ; Luhn, période ordonnée et HT + TVA = TTC nommés par `x-axion-regles` ; test ajv sur les JSON Schema commités : même verdict que Zod pour chaque fixture. |
| 4, 5 | Corrigé. Un seul `Siren` (Luhn), `Siret` et `Adresse` (avec `ligne2`) dans `src/commun/identifiants.ts` ; fixtures C1 et C2 refaites avec un SIREN de `fixtures/c3/siren-generes.json`. |
| 6 | Corrigé. Réponse 200 : `retrouve` ou `cree` ; réponse 202 : `a_trancher` seulement. |
| 7 | Corrigé. Rattrapage par curseur global opaque (`apres`), `limite` de 1 à 500, `axiCli` facultatif ; réponse avec `suivant` et `complet`. La `sequence` reste par sujet, pour ranger. |
| 8 | Corrigé. `reauthentification_requise` (401) entre dans la liste fermée : l'ADR 0024 est accepté. |
| 9 | Corrigé. Empreintes de tous les contrats, commun et C5 compris, sur `fixtures/<contrat>/` seulement (ce que l'autre dépôt copie) ; les constantes (codes, fenêtres, limites, C6, invariants et `TABLE_MIGRATIONS` de C5) et les JSON Schema (C4 compris) sont générés dans `fixtures/` et un test vérifie qu'ils suivent le code. `contrats.sha256` revient comme sommaire (une ligne par fichier d'empreintes et `VERSION`) : la fiche T0-30 et l'ADR 0019 ne se contredisent plus. |
| 10 | Corrigé. Clé de test propre au Hub pour C2 ; test : seule cette clé signe les fixtures C2. |
| 11 | Corrigé. Motif de clôture et statuts (par type) en vocabulaires fermés ; `motif` reste dans le vocabulaire de C5. |
| 12 | Corrigé. « Récepteur d'abord » partout ; la phrase « côté émetteur seulement » de l'ADR 0018 est remplacée (note ajoutée à l'ADR 0018). |
| 13 | Corrigé. Chaque fichier généré lit sa version dans `VERSION` ; test d'égalité. |
| 14 | Corrigé. Constantes `ANTI_REJEU_SECONDES` (600), `CONSERVATION_IDEMPOTENCE_JOURS` (30). Décision pour C3 : les événements poussés (C2, C3) se dédoublonnent par `event_id`, sans `Idempotency-Key` ; l'ADR 0002 est précisé en ce sens. |
| 15 | Corrigé. Curseurs jamais vides ; `CURSEUR_INITIAL` = `0` au premier appel. |
| 16 | Corrigé. Montants et taux positifs ou nuls ; avoir en montant positif (le type de fait dit qu'il vient en déduction) ; HT + TVA = TTC et période ordonnée contrôlés. |
| 17 | Corrigé. Un exemple valide et un invalide par réponse et par statut de C1. |
| 18 | Corrigé. `ROUTES_C3` exporte les routes des événements et de la lecture. |
| 19 | Renvoyé : C5 reste en 0.x. Le job de CI `contrats-pg` est écrit avant tout gel de C5 (porte du lot 0 ou première tâche C5 du lot 2). Les 21 tests de C5 ont tourné contre un PostgreSQL 16 jetable pour cette PR : tous verts. |

### Complétude
| # | Décision |
|---|---|
| 1, 2 | Corrigé (voir sécurité 2 et exactitude 1). |
| 3 | Corrigé dans `INVARIANTS_C5` et `src/c5/README.md` : une ligne de facture d'abonnement par (abonnement, début de période), hors avoirs, sur chaque ligne d'une facture groupée ou seule. L'annexe A du dépôt privé reprend ce texte par sa prochaine révision datée. |
| 4 | Corrigé. `facture.emise` : `idBrouillon`, `referenceBonDeCommande`, `referenceAbonnementConsole` facultatifs. |
| 5 | Corrigé côté récepteur (C2 : `stockage`, `solde_engagement`). Côté C1, l'émetteur les ajoute avec T7-01 (lot 7, additif, Hub d'abord). |
| 6 | Corrigé. `lignes` facultatives de `facture.emise`, une par abonnement avec sa période, son terme, sa TVA ; une facture groupée garde sa période (premier début, dernière fin) ; la somme des lignes est contrôlée par la console à la réception (alerte, rien de corrigé seul, T7-32). Les champs du plan récurrent de T7-29 (`referenceAbonnementConsole`, période libre, terme, `groupeFacturation`) restent à T7-29 (lot 7) : champs facultatifs dont l'absence garde le sens 0.x, donc additifs. |
| 7 | Corrigé. `plan.resume` porte un abonnement par automatisation (période de 1 à 12 mois, terme, échéance, sans montant) ; événement `automatisation.fin_programmee` pour la fin d'une seule automatisation. |
| 8 | Renvoyé (additif) : lecture de la liste des fiches par C1 et lecture CRM sans filtre (nouvelles routes) au lot 2 (T2-20) ; événement « demander un échange » au lot 2-ter ; contacts dans `entreprise.mise_a_jour` (champ facultatif, console d'abord) au lot 2-ter. |
| 9 | Renvoyé (additif) : route C1 de retrait de consentement vers le Hub au lot 2-bis (T2-17). |
| 10 | Renvoyé : C4 reste en 0.x ; `ia.modes`, `ia.garde`, `modeIa` viennent avec T4-49 (C4 0.3.0) et T4-54. Vérifié : aucun contrat gelable (C1 à C3, C5, C6) ne suppose un seul mode d'IA. |
| 11 | Corrigé : procédure d'évolution écrite (ADR 0032, `README.md`, `CHANGELOG.md`, fixtures archivées au gel). |
| 12 | Corrigé (exactitude 8). |
| 13 | Renvoyé (additif) : si Will décide que l'IA `via_axion` est refacturée, une nature de facture s'ajoute à C1 (Hub d'abord), au lot 2-bis ou 7. Aucun prix n'est fixé ici. |
| 14 | Renvoyé : version du tableau de coûts dans `fin` (C4, champ facultatif) avec T4-49. |
| 15 | Corrigé : `motif` facultatif (code fermé) dans le corps d'erreur. |
| 16 | Corrigé (exactitude 9, `CHANGELOG.md`). |
| 17 | Rien à faire. |

## Conséquences
- Ruptures permises en 0.x et écrites dans `CHANGELOG.md` : appel de `verifier()`, `axiCli` obligatoire, objets stricts dans C1 et C2, `plan.resume`. Le Hub (lot 2-bis), le CRM (lot 2-ter) et la console n'ont encore rien branché sur ces formes.
- La porte des événements reste fermée par défaut ; aucune route d'émission, d'avoir, de suppression ni de remboursement dans C1.
- Le gel en 1.0.0 attend une nouvelle relecture complète de T0-30.
