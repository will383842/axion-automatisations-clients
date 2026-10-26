# connecteur-gmail

Connecteur de la famille messagerie pour Gmail (API v1, appels `fetch`, aucune bibliothèque Google). Fermé par défaut : `CONNECTEURS_MESSAGERIE_OUVERT=1` et `CONNECTEUR_GMAIL_OUVERT=1` pour l'ouvrir (le second reste à `false` tant que la fiche de conformité n'est pas signée) ; l'adresse de base vient de `GMAIL_URL`, **obligatoire et sans valeur par défaut**. Chaque appel a un délai maximal (15 s). Relié par l'équipe avec le client, jamais en libre-service. Choix : ADR 0027.

- Actions : `lister_nouveaux` (liste de `INBOX`, puis `history.list` ; `curseurHistorique()` rend le curseur `h:<historyId>`, 404 → liste complète sans redonner les messages déjà rendus), `lire`, `etiqueter` (l'étiquette est créée si besoin), `creer_brouillon`, `envoyer`.
- Garantie de `envoyer` : `verifiable_apres_coup`. Le message porte le `Message-ID` choisi et `X-Axion-Intention` ; `verifierApresCoup(jeton, messageId)` cherche dans « Envoyés » : `trouve`, `absent` ou `indetermine` (une erreur ou un délai donne `indetermine`, jamais `absent`). Le noyau vérifie avant tout renvoi.
- Portées : `gmail.readonly` + `gmail.compose`, ou `gmail.modify` seulement si un module installé étiquette (option `actions`).
- Erreurs : 429 et `rateLimitExceeded` → `quota` daté (une minute sans date) ; 401, `invalid_grant` → `identification` ; `admin_policy_enforced` (ou API non activée) → `identification` / `application_bloquee_par_administrateur` ; 5xx → `passagere` ; autres 4xx → `definitive`.
- Le connecteur ne réessaie jamais et ne journalise que des identifiants et des codes.

## Créer l'application interne avec le client
1. Le client ouvre la console Google Cloud de son compte Workspace et crée un projet réservé à AXION IA.
2. Il active l'API Gmail dans ce projet.
3. Écran de consentement : type « Interne » (réservé aux utilisateurs de son organisation), nom et adresse d'assistance du client.
4. Il ajoute les portées listées ci-dessus (la fiche de connexion indique lesquelles).
5. Il crée un identifiant OAuth de type « Application Web » avec l'adresse de retour que donne l'équipe.
6. Il confie l'identifiant d'application et son secret à l'équipe par le canal prévu (jamais par message) ; ils vont au coffre, puis au courtier.
7. Si l'administrateur bloque l'application, l'erreur `application_bloquee_par_administrateur` le dit : le client doit autoriser l'application dans l'administration Google.

## Tests
- Réponses enregistrées dans `enregistrements/` (inventées, sans jeton), rejouées par la suite commune.
- Faux Gmail du harnais pour la recherche après coup (`reponse_perdue`, panne, quota, `acces_refuse`).
- À vérifier avec un vrai compte de test avant ouverture : Gmail doit conserver le `Message-ID` fourni.
