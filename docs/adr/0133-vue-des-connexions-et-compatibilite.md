# 0133 · Vue des connexions d'un client et compatibilité des outils

Date : 07/11/2026 · Statut : proposé (T3-17a), à accepter par l'architecte · Contrat touché : aucun · Migration : aucune · S'appuie sur : ADR 0054 (connexions), fiche client T3-13

## Contexte
- L'onglet des connexions de la fiche client doit montrer, par connexion : l'outil, l'état, l'expiration, le dernier test, les automatisations qui l'utilisent et la personne à joindre.
- La table `connexions` porte une référence vers le coffre : elle ne doit jamais sortir de l'API.
- `console_equipe` lit tous les clients ; l'isolation repose donc sur le droit de la route et sur le filtre SQL.

## Décision
1. La vue est la seule forme rendue par l'API : `id`, `outil`, `connecteur`, `etat`, `expire_le`, `dernier_test { le, resultat, code }`, `automatisations [{ code, nom }]`, `a_contacter { nom, role }` ou rien.
2. Requête constante aux colonnes nommées, jamais `*`, jamais la référence du coffre, la portée ni l'organisation. `tenant_id = $1` figure sur chaque table de la requête, jointures comprises (`connexions`, `connexions_instances`, `instances`, `contacts`).
3. Projection clé par clé depuis la ligne brute : une clé ajoutée par erreur à la ligne ne sort jamais.
4. Dates en ISO UTC tronqué à la minute. `dernier_test.resultat` vient de l'état : `ok` si active, `echec` si en échec ou expirée, rien sinon.
5. **Écart E1** : le code du dernier test n'a pas de colonne. `dernier_test.code` vaut toujours `null`. Recommandation : une colonne `dernier_test_code` (énumération fermée) ajoutée par la migration de T4-42b ; la dette passe alors à T4-42b. Accord de l'architecte demandé.
6. **Écart E2** : la personne à joindre est le contact `technique` le plus ancien, sinon le contact `principal` le plus ancien. On rend le nom et le rôle, jamais l'adresse e-mail. Accord de l'architecte demandé.
7. La route est `GET /api/console/v1/clients/:id/connexions` : session d'équipe, puis droit `lire` avec la portée du client (hors portée : 404 sans lecture). Aucune action nouvelle dans la matrice. Porte de lecture : un booléen `ouvert()` fourni par l'appelant (fermé par défaut, 503) ; aucune variable d'environnement lue.
8. La compatibilité des outils (T3-17b) classera chaque automatisation en compatible, à créer ou impossible. Le catalogue `connecteurs` fait foi ; `outils_client.connecteur_disponible` est ignoré. Les raisons sont des codes fermés.

## Options écartées
- Rendre la ligne brute filtrée après coup : une colonne ajoutée plus tard sortirait sans que personne le décide.
- Lire l'adresse e-mail du contact pour l'afficher : elle n'a aucun usage dans la vue (le renvoi du lien résout le contact côté serveur).
- Une migration pour le code du test : hors périmètre de T3-17 (« aucune migration »).

## Conséquences
- Dettes écrites dans `spec/preuves.md` (code du test, ports du lot 4, câblage, gamme, source des outils, vue « comme le client », bouton du bandeau, visuel, débit en mémoire).
- Limite : le débit des renvois (T3-17c) sera tenu en mémoire d'un seul processus ; ce n'est pas dans cette PR.
