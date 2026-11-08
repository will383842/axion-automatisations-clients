# T6-24b · Expéditeur des clients, preuve de clic, garde « texte validé », rendu à liste blanche, préférences (partie pure)

Exigences : C-557, B-186.

## Preuves
- `apps/api/src/courriel/expediteur.test.ts` : `envoyerAuClient` refuse un envoi « d'un clic de Will » sans preuve, un texte « a_valider » (même interrupteur ouvert), un annuaire absent ou vide, un rôle forgé ou un client mal formé ; interrupteur fermé = aucune lecture de l'annuaire ; domaine refusé jamais servi ; conditions de `lienReconnexion` ; trace sans adresse ni texte. `envoyer` (équipe) refuse toujours un rôle client.
- `apps/api/src/courriel/clic-equipe.test.ts` : preuve à usage unique et pour sa seule clé ; `second_administrateur` limité à `notificationViolation` ; `creerClicEquipe` importé seulement sous `routes/**` ; aucun import de canaux dans `courriel/` ni `portail/notifications`.
- `apps/api/src/courriel/gabarits-clients/rendre.test.ts` : variables exactes, une ligne, 1 à 200 caractères ; liens limités à l'origine du portail ; remplacement littéral.
- `apps/api/src/portail/notifications.test.ts` : chaque ligne client dans exactement une liste ; `cleStockee` conforme à 0025, injective ; un message de service ne lit jamais les préférences ; une préférence coupée n'arrête que son utilisateur ; lecture en échec = aucun envoi facultatif.

## Rouge puis vert
- Rouge : premier commit, tests seuls (modules `clic-equipe`, `rendre`, `notifications` absents ; `envoyerAuClient` absent).
- Vert : deuxième commit, code minimal ; `pnpm verifier` vert.

## Fichier hors fiche
- `apps/api/src/courriel/expediteur.ts` (ajouté à la liste par le plan du concepteur, écart E2).

## Ce qui reste
- Rien n'est branché : l'expéditeur n'est créé nulle part, aucun interrupteur `envoi.*` n'existe, tous les textes restent « a_valider ». Aucun e-mail ne peut partir.
- Dettes ci-dessous (spec/preuves.md).
