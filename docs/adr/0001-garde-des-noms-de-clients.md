# 0001 · Garde des noms de clients

Date : 24/10/2026 · Statut : accepté

## Contexte
Ce dépôt est public : aucun nom de vrai client ne doit y apparaître. Une liste d'empreintes (même salées) publiée ici serait inversable, car les raisons sociales sont toutes dans un répertoire public d'entreprises : en hachant ce répertoire on retrouverait la liste. Avec le sel gardé secret, la CI d'une PR ne pourrait pas le lire (aucun secret exposé à une PR), donc la garde ne servirait à rien sur les PR. Les empreintes ne voient pas non plus les variantes (accents, tirets, nom collé).

## Décision
La garde tourne à deux endroits, sans aucune empreinte publique :
1. AVANT la poussée, dans la routine, par un crochet local.
2. Depuis le dépôt PRIVÉ, sur chaque PR, par un workflow déclenché à la demande ; son résultat devient un statut obligatoire `garde-noms` sur la PR.

Le dépôt public étant lisible par tous, le workflow privé n'a besoin d'aucun droit sur lui pour lire la PR. Seule l'écriture du statut demande un droit : elle est faite par le script de fusion du chef d'orchestre, déjà authentifié. Aucun jeton n'est créé ni stocké, aucun secret n'est donné à un workflow de PR.

## Conséquences
- Aucune liste, empreinte ou sel de noms dans ce dépôt.
- Aucun jeton du dépôt privé dans le dépôt public.
- Environ une minute de CI privée par PR, plus un passage de contrôle régulier.
- Le détail de mise en œuvre est dans la fiche de la tâche T0-10 (dépôt privé).
