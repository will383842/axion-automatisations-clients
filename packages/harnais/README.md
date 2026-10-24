# @axion-auto/harnais

Outils de test communs. Aucun test ne peut envoyer un vrai message : tout e-mail tombe dans Mailpit.

## Piège Mailpit et faux Microsoft 365 (lot 4)
1. Lancer Mailpit (`ops/compose.test.yml`, ou le service du job `harnais`), puis `NODE_ENV=test` et `MAILPIT_API=http://127.0.0.1:8025`.
2. `const mailpit = creerClientMailpit();` puis `await mailpit.attendrePret();` avant le premier test.
3. Les fichiers de test partagent un seul Mailpit : écrire à une adresse unique par test (`<uuid>@exemple.fr`) et ne lire que les messages de cette adresse, sans tout vider.
4. `const graph = await demarrerFauxGraph({ mailpit });` : `graph.url` est l'adresse du faux Graph (127.0.0.1 seulement).
5. Le moteur parle à `graph.url` : jeton `POST /oauth2/v2.0/token`, brouillon `POST /v1.0/me/messages`, envoi `POST /v1.0/me/messages/{id}/send`.
6. Retrouver un envoi : `GET /v1.0/me/mailFolders/SentItems/messages?$filter=internetMessageId eq '<id>'`.
7. Provoquer une panne : `POST {graph.url}/__controle` avec `{ "mode": "quota" | "reponse_perdue" | "panne_generale" | "consentement_admin_requis" | "normal" }` ; `reinitialiser: true` vide l'état.
8. `reponse_perdue` : le message PART dans Mailpit, puis la connexion est coupée (scénario 8). Graph n'a AUCUN anti-doublon : deux envois du même brouillon donnent deux messages.
9. Lire le résultat : `await mailpit.attendreMessages(n)` puis `mailpit.lire(id)`.
10. Destinataires en `@exemple.fr` ou `*.test` seulement ; `/__controle` est refusé si `NODE_ENV` n'est pas `test`.

Les tests qui déposent dans Mailpit ne tournent que si `MAILPIT_API` est défini (job `harnais`) ; ailleurs ils sont sautés.

## Faux Gmail, consentement Graph, récepteurs, garde (T1A-12)
1. Faux Gmail : `const gmail = await demarrerFauxGmail({ mailpit });` ; jeton factice `Bearer faux.<compte>@exemple.fr`.
2. Envoi : `POST {gmail.url}/gmail/v1/users/me/messages/send` avec `{ "raw": <RFC 2822 en base64url> }` → le message tombe dans Mailpit, libellé `SENT`.
3. Retrouver un envoi : `GET /gmail/v1/users/me/messages?q=rfc822msgid:<id>`. Aucune clé anti-doublon : deux envois donnent deux messages.
4. Pannes : `POST {gmail.url}/__controle` avec `{ "mode": "quota" | "reponse_perdue" | "panne_generale" | "acces_refuse" | "normal" }`.
5. Consentement Graph : `POST {graph.url}/__controle` avec `{ "mode": "normal", "consentement_requis": true }` ; le jeton `POST /<locataire>/oauth2/v2.0/token` répond alors `AADSTS65001`.
6. Accord de l'administrateur : `GET {graph.url}/adminconsent?client_id=…&tenant=<locataire>` ; le jeton est ensuite délivré, pour ce locataire seulement.
7. Mauvais compte Microsoft : `POST {graph.url}/__controle` avec `{ "mode": "mauvais_compte" }` → `AADSTS50020`. Les locataires se comparent sans tenir compte de la casse.
8. Récepteurs : `const r = await demarrerRecepteurs();` puis Telegram `POST /bot<jeton>/sendMessage`, MailWizz `POST /api/campaigns`, webhook `/webhook/…`.
9. Lire ce qui est arrivé : `GET {r.url}/__recus[?canal=telegram|mailwizz|webhook]` ; vider : `DELETE {r.url}/__recus` (refusé hors `NODE_ENV=test`, comme `/adminconsent`). Telegram lit aussi formulaire et paramètres d'URL.
10. Garde : `exigerDestinationsDeTest(process.env, <services du compose assemblé>)` ; elle refuse tout hôte hors socle et n'affiche que le NOM de la variable. Pas encore appelée au démarrage de l'API (tâche suivante).
Destinataires en `@exemple.fr` ou `*.test` seulement ; tous les serveurs écoutent sur 127.0.0.1.
Le faux Gmail remet le message tel quel (pièces jointes, fil, Cc) sans la ligne Bcc ; `mailparser` sert à l'exécution : l'image du harnais devra installer les dépendances de développement.
