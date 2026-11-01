# 0056 · Connexion de l'équipe : PKCE, session côté serveur, jeton vérifié, journaux

Date : 01/11/2026 · Statut : accepté (fiche T3-01, tranche connexion et session ; suite de l'ADR 0049) · Contrat touché : aucun

## Contexte
L'ADR 0049 fait construire l'adresse Keycloak par la console. T3-01 est une zone d'authentification : à chaque choix, la solution la plus restrictive est retenue.

## Décision
1. **Adresse d'autorisation** construite par `/connexion` : code d'autorisation, PKCE S256 (vérificateur de 32 octets aléatoires gardé côté serveur), `state` et `nonce` à usage unique, `prompt=login`, `max_age=0`, `acr_values=mfa`. Seuls `login_hint` et `retour` sont lus dans l'adresse locale ; aucun autre paramètre n'est copié.
2. **`login_hint`** : une seule occurrence, une adresse e-mail de 254 caractères au plus (partie locale de 64), sans espace, contrôle ni signe d'adresse ; sinon réponse 400 et rien n'est envoyé à Keycloak.
3. **Journaux** : `login_hint` n'est jamais écrit. Les routes n'ont aucun journal, la route ne rend pas l'adresse dans une erreur, et l'API retire déjà la partie « ?… » des adresses (sérialiseur de requête). Réponses en `Cache-Control: no-store` et `Referrer-Policy: no-referrer` (en plus de la règle globale de `next.config.ts`) : l'adresse e-mail ne part pas dans l'en-tête `Referer`.
4. **`state` lié au navigateur** : cookie `__Host-transaction` (`HttpOnly`, `Secure`, `SameSite=Lax`, 10 minutes). `Lax` et non `Strict` : Keycloak ramène le navigateur depuis un autre site, un cookie `Strict` ne partirait pas. La transaction est détruite dès la première lecture, même en cas d'échec : code, `state` et `nonce` ne se rejouent pas.
5. **Jeton d'identité** vérifié par la console, côté serveur, dans le gestionnaire de rappel : signature RS256 contre les clés du royaume `equipe` (tout autre algorithme refusé), `iss` (un jeton du royaume `clients` est refusé), `aud` et `azp`, `exp`, `nonce`, `auth_time` de moins de 5 minutes (une session Keycloak déjà ouverte ne dispense pas du double facteur), `acr` égal à `mfa` et `amr` portant un second facteur. Le jeton n'est jamais lu depuis le navigateur.
6. **Session** : identifiant aléatoire de 32 octets, contenu gardé en mémoire du serveur, cookie `__Host-session` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, sans `Domain`), durée = le plus court de 8 h et de l'expiration du jeton. Nouvel identifiant à chaque connexion (pas de fixation). Chaque gestionnaire revérifie la session (`sessionDe`).
7. **Déconnexion** : `POST` seulement, `Origin` exigé égal à l'origine de la console, session détruite, redirection vers la fin de session Keycloak.
8. **Interrupteur fermé par défaut** : `CONSOLE_CONNEXION_OUVERTE=1` ouvre les routes ; sinon 404.
9. **Retour** : chemin local seulement (pas de `//`, `\`, contrôle même encodé, schéma) et jamais vers `/connexion` ni `/api/auth` ; sinon l'accueil.

## Conséquences et limites
- Sessions en mémoire : un redémarrage ou une deuxième instance impose de se reconnecter. Acceptable pour une équipe réduite ; un magasin partagé sera un ADR si la console passe à plusieurs instances.
- Les clés Keycloak sont relues à chaque connexion (pas de cache) : plus lent, mais une rotation de clé est prise en compte tout de suite.
- **C-404 n'est pas coché** : il faut un essai contre un vrai Keycloak. `post_logout_redirect_uri` devra être déclaré sur le client `console` lors de cet essai.
- Reste de la fiche (T3-01b) : disposition (menu de 7 entrées, en-tête et onglets du téléphone), proxy de Next.js, test visuel, lien vers le back-office dans l'interface.
