# 0049 · La route de connexion construit l'adresse Keycloak (PKCE S256 + state)

Date : 01/11/2026 · Statut : accepté (décision de l'architecte, déléguée par Will ; T2-19, correction du tour 1) · Contrat touché : aucun (la forme du jeton C6 ne change pas)

## Contexte
T2-19 reçoit le lien signé C6 (C-404). Première version : l'API rendait une adresse d'autorisation Keycloak (`login_hint`, `prompt=login`, `acr_values=mfa`). Mais le client `console` du royaume de l'équipe exige PKCE S256 : sans `code_challenge` ni `state`, Keycloak refuse l'adresse, et le retour de connexion n'est lié à aucun navigateur. L'API, sans session ni cookie, ne peut pas garder un `code_verifier`.

## Décision
1. **L'API ne rend plus aucune adresse Keycloak.** La réponse de succès est le chemin local de la page de connexion de la console avec `login_hint` seul (l'e-mail encodé, transmis tel quel). Aucune origine, aucun paramètre OIDC.
2. **La route de connexion de la console construit l'adresse Keycloak** : `code_challenge` (S256) et son `code_verifier` gardé côté serveur, `state` lié au navigateur, `nonce`, `prompt=login`, `acr_values=mfa`, et `login_hint` repris de l'adresse locale. C'est la tâche T3-01 (lot 3).
3. **La page `/entree` ne suit qu'un chemin local** et ne connaît pas Keycloak (plus de variable d'origine).
4. **Le jeton reste sans pouvoir d'authentification** : il ne nomme que l'e-mail ; le double facteur est redemandé par Keycloak.
5. **C-404 n'est coché qu'après un essai contre un vrai Keycloak**, une fois la route de T3-01 en place.

## Conséquences
- `DepsEntree` perd `keycloak` ; il garde `connexionNormale` (chemin local).
- T3-01 doit : lire `login_hint` sur la page de connexion, construire l'adresse avec PKCE S256 et `state`, refuser tout `login_hint` de forme invalide, et ne jamais copier un autre paramètre de l'adresse locale.
- Le branchement dans `serveur.ts` (interrupteur fermé, `trustProxy` limité au saut du proxy, avec test) reste une tâche à part.
