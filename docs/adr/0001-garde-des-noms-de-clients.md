# 0001 · Garde des noms de clients

Date : 24/10/2026 (révisé le 24/10/2026, T0-10b) · Statut : accepté

## Contexte
Ce dépôt est public : aucun nom de vrai client ne doit y apparaître. Une liste d'empreintes (même salées) publiée ici serait inversable, car les raisons sociales sont toutes dans un répertoire public d'entreprises : en hachant ce répertoire on retrouverait la liste. Avec le sel gardé secret, la CI d'une PR ne pourrait pas le lire (aucun secret exposé à une PR), donc la garde ne servirait à rien sur les PR. Les empreintes ne voient pas non plus les variantes (accents, tirets, nom collé).

Aucun workflow n'est permis dans le dépôt privé (pas de CI payante) : la garde « depuis le privé » ne peut donc pas être un workflow.

## Décision
La garde tourne à deux endroits, sans aucune empreinte publique :
1. AVANT la poussée, dans la routine, par un crochet local.
2. À la fusion, par un script local du chef d'orchestre, seul moyen de fusionner une PR du public. Il passe la garde sur chaque commit (objet commit complet compris), sur le diff final, sur les chemins (lus avec `-z`) et sur les textes de la PR, puis pose depuis le poste du chef un statut `garde-fusion` qui ne contient aucun nom, et fusionne seulement le commit vérifié, avec le titre et le corps vérifiés. La fusion automatique de GitHub est désactivée.

La liste des noms ne quitte jamais l'environnement du chef (variable `NOMS_CLIENTS`) : ni fichier, ni secret de dépôt, ni empreinte.

### Changement de principe
L'ancienne décision disait « jamais du code tiré du dépôt public dans un job qui détient la liste ». Le script du chef exécute, avec la liste, le code de `main` de ce dépôt (`scripts/garde-noms/`). C'est acceptable à trois conditions cumulées :
1. jamais le code de la PR : la garde vient de `origin/main` ;
2. toute PR qui touche ce code ou ce dont il dépend est relue à la main par le chef avant la fusion ;
3. ce code n'importe que `node:*` et des fichiers de son dossier, ce qu'un test vérifie.

### Règles de la garde
- Modes `diff`, `texte` et `chemins` : entrée lue en octets et décodée en UTF-8 strict ; une entrée qui n'est pas de l'UTF-8 valide, ou qui contient NUL, est refusée (code 1, « convertir en UTF-8 »). Refuser plutôt que décoder aussi en Windows-1252 ou UTF-16 : la liste des décodages resterait ouverte et chaque oubli serait un trou silencieux. Le crochet `pre-commit` suit la même règle.
- Codes de sortie des modes `diff`, `texte` et `chemins` : 0 propre, 1 refus sans trouvaille, 2 nom trouvé, 64 mauvais appel. Les crochets sortent 1 sur une trouvaille. La sortie ne contient jamais le nom (C-531).
- Chemins : contrôlés depuis des sorties `-z` (mode `chemins`) ; les lignes `diff --git` ne servent qu'à refuser un chemin échappé.
- Images : seules `png jpg jpeg webp gif ico` sans métadonnée texte (liste fermée de blocs, `metadonnees.ts`) ; tout autre binaire est refusé.

## Risques acceptés
- Les homoglyphes (un « е » cyrillique pour un « e ») ne sont pas ramenés par la normalisation. Ce n'est pas un cas accidentel ; le squelette Unicode TR39 ajouterait une table à maintenir et est refusé pour l'instant.
- Le texte dessiné dans les pixels d'une image n'est pas lu.
- Un nom encodé (base64, %C3%A9) n'est pas vu.
- Un jeton qui peut écrire les statuts de commit peut falsifier `garde-fusion` : c'est une barrière contre l'erreur, pas contre une attaque.

## Conséquences
- Aucune liste, empreinte ou sel de noms dans ce dépôt.
- Aucun jeton du dépôt privé dans le dépôt public, aucune minute de CI privée.
- Le détail de mise en œuvre est dans la fiche de la tâche T0-10b (dépôt privé).
