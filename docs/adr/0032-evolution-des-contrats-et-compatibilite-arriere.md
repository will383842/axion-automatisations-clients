# 0032 · Évolution des contrats et compatibilité arrière (0.x, gel 1.0.0, 1.x)

Date : 26/10/2026 · Statut : accepté par l'architecte des contrats

## Contexte
La relecture T0-30 a relevé que la procédure d'évolution n'était pas écrite : la règle d'ajout d'une valeur d'énumération se contredisait (annexe « récepteur d'abord », ADR 0018 « émetteur seulement »), rien ne disait l'ordre de passage entre les trois dépôts (console, axion-ia, CRM), ni ce qu'on garde de la version gelée. `contrats.sha256` et `CHANGELOG.md`, cités par plusieurs fiches, n'existaient pas.

## Décision
- **Versions.** `packages/contrats/VERSION` porte une version par contrat (commun, C1 à C6). Tous restent en 0.x tant qu'une relecture T0-30 n'a pas rendu OUI ; le gel en 1.0.0 se fait par une PR à part (C4 garde sa propre révision, ADR 0018 ; C5 ne gèle qu'avec le job `contrats-pg`).
- **Additif seulement dans la 1.x** : champ facultatif avec valeur d'absence qui garde l'ancien sens, valeur d'énumération, type de fait ou d'événement, route, code d'erreur, borne élargie. Tout le reste est une v2 avec ADR.
- **Récepteur d'abord**, pour un champ comme pour une valeur (les schémas sont stricts, ADR 0031) : contrat ici, puis récepteur déployé, puis émetteur. Remplace la phrase « nouvelles valeurs d'énumération côté émetteur seulement » de l'ADR 0018.
- **Ordre entre dépôts** : PR de contrat ici ; puis le dépôt du récepteur copie `fixtures/<contrat>/` et `empreintes/<contrat>.sha256` dans la même PR que son code ; puis l'émetteur. Le test d'empreinte de l'autre dépôt est rouge entre les deux : c'est voulu.
- **Ce qu'on garde** : `CHANGELOG.md` (une entrée datée par version et par contrat) ; `contrats.sha256`, sommaire de toutes les empreintes (commun et C5 compris) et de `VERSION`, régénéré par `node scripts/empreinte.ts`, jamais à la main ; au gel, `fixtures-gelees/1.0.0/` : les exemples valides de la version gelée restent valides (test permanent).
- **Empreintes** : `empreintes/<contrat>.sha256` couvre `fixtures/<contrat>/` seulement ; ce qui passe le fil (JSON Schema, constantes, invariants) y est généré. Remplace l'ensemble de fichiers de l'ADR 0019 (qui couvrait aussi `src/c1` et `src/c2`, et ni C5 ni commun).

## Conséquences
- Une PR de contrat touche toujours : le schéma, les fixtures, `VERSION`, `CHANGELOG.md`, les empreintes et `contrats.sha256`. Deux PR de contrats en parallèle se heurtent sur `contrats.sha256` : la seconde relance le script après avoir fusionné `main`.
- La procédure détaillée, pour les exécutants, est dans `packages/contrats/README.md`.
