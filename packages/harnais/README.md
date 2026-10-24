# @axion-auto/harnais

Outils de test communs. Aucun test ne peut envoyer un vrai message : tout e-mail tombe dans Mailpit.

## Piège Mailpit et faux Microsoft 365 (lot 4)
1. Lancer Mailpit (`ops/compose.test.yml`, ou le service du job `harnais`), puis `NODE_ENV=test` et `MAILPIT_API=http://127.0.0.1:8025`.
2. `const mailpit = creerClientMailpit();` puis `await mailpit.attendrePret();` avant le premier test.
3. `beforeEach` : `await mailpit.vider();` (le piège est vide entre deux tests).
4. `const graph = await demarrerFauxGraph({ mailpit });` : `graph.url` est l'adresse du faux Graph (127.0.0.1 seulement).
5. Le moteur parle à `graph.url` : jeton `POST /oauth2/v2.0/token`, brouillon `POST /v1.0/me/messages`, envoi `POST /v1.0/me/messages/{id}/send`.
6. Retrouver un envoi : `GET /v1.0/me/mailFolders/SentItems/messages?$filter=internetMessageId eq '<id>'`.
7. Provoquer une panne : `POST {graph.url}/__controle` avec `{ "mode": "quota" | "reponse_perdue" | "panne_generale" | "consentement_admin_requis" | "normal" }` ; `reinitialiser: true` vide l'état.
8. `reponse_perdue` : le message PART dans Mailpit, puis la connexion est coupée (scénario 8). Graph n'a AUCUN anti-doublon : deux envois du même brouillon donnent deux messages.
9. Lire le résultat : `await mailpit.attendreMessages(n)` puis `mailpit.lire(id)`.
10. Destinataires en `@exemple.fr` ou `*.test` seulement ; `/__controle` est refusé si `NODE_ENV` n'est pas `test`.

Les tests qui déposent dans Mailpit ne tournent que si `MAILPIT_API` est défini (job `harnais`) ; ailleurs ils sont sautés.
