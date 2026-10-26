# connecteur-microsoft-365

Connecteur de la famille messagerie pour Microsoft 365 (Graph v1.0). Fermé par défaut : `CONNECTEURS_MESSAGERIE_OUVERT=1` pour l'ouvrir ; l'adresse de base vient de `GRAPH_URL`.

- Actions : `lister_nouveaux` (delta, le curseur est le `@odata.deltaLink` rendu par Graph, lu avec `curseurDelta()`), `lire`, `etiqueter` (catégories), `creer_brouillon`, `envoyer`.
- Garantie d'effet de `envoyer` : `verifiable_apres_coup`. Graph n'a pas de clé anti-doublon : le brouillon porte le `Message-ID` choisi et l'en-tête `X-Axion-Intention`.
- `verifierApresCoup(jeton, messageId)` cherche le message dans « Éléments envoyés » : `trouve`, `absent` ou `indetermine`. Une erreur ou un délai donne `indetermine`, jamais `absent` ; le noyau ne renvoie qu'après un `absent` franc.
- Erreurs : 429 (ou 503) avec `Retry-After` → `quota` daté (sans date sur un 429 : une minute) ; 401 et `invalid_grant` → `identification` ; `AADSTS65001` → `identification` / `consentement_requis` ; autres 5xx → `passagere` ; autres 4xx → `definitive`.
- Le connecteur ne réessaie jamais et ne journalise que des identifiants et des codes.

## Tests
- Réponses enregistrées dans `enregistrements/` (inventées, sans jeton), rejouées par la suite commune.
- Faux Graph du harnais pour la recherche après coup (`reponse_perdue`, panne, quota).
- Nuit : `src/nuit.test.ts`, sauté sauf `NUIT_CONNECTEURS=1` ; rouge si le tenant de test n'est pas configuré (`GRAPH_JETON_TEST`, `GRAPH_COMPTE_TEST`, `GRAPH_DESTINATAIRE_TEST`). Le workflow qui le lance (environnement `connecteurs-de-test`) reste à ajouter.
