# 0129 · Compte de service console-sessions et adaptateur Keycloak aux méthodes fermées

Date : 07/11/2026 · Statut : proposé (T3-07a), à accepter par l'architecte · Décision A1 de l'architecte : acceptée · Contrat touché : aucun · Migration : aucune · S'appuie sur : T1A-08 (royaumes), T3-06 (droits)

## Contexte
- L'écran « Sécurité et accès » doit lire les sessions et le double facteur des membres, fermer une session, inviter et désactiver un membre : il faut un accès à l'API d'administration de Keycloak, limité au royaume `equipe`.
- Keycloak n'attribue des rôles à un compte de service, à l'import, que par une entrée `users` portant `serviceAccountClientId`. Or la garde des royaumes refusait tout `users` dans un fichier de royaume.
- Le secret du client passe par quatre endroits : fichier de royaume, `compose.keycloak.yml`, `lancer.sh` (essai) et l'inventaire des secrets.

## Décision
1. Client confidentiel `console-sessions` du royaume `equipe` seul : `serviceAccountsEnabled`, ni parcours de navigateur, ni octroi direct, ni flux implicite ; secret `${KC_SECRET_CONSOLE_SESSIONS}` ; portées `basic` (sujet du jeton) et `roles` (rôles de gestion portés par le jeton), sans `offline_access` ; PKCE S256 et `minimum.acr.value = mfa` comme tout client de l'équipe (exigés par la garde ; l'essai réel prouve que `client_credentials` n'en souffre pas).
2. Rôles du compte : `view-users` et `manage-users` de `realm-management`, rien d'autre.
3. Exception étroite de la garde : l'entrée `users` n'est permise que pour un compte de service du royaume `equipe`, aux clés `username`, `enabled`, `serviceAccountClientId`, `clientRoles` ; les rôles permis sont ces deux seuls ; un client `serviceAccountsEnabled` doit avoir son entrée, sans parcours de navigateur ; aucun compte de service dans le royaume `clients`. Mots de passe, `realmRoles` et autres clés restent refusés.
4. Le secret de production est rangé sous `technique/` d'OpenBao (nom `KC_SECRET_CONSOLE_SESSIONS`), lu par l'API seule par `LecteurSecrets` et substitué dans le conteneur Keycloak ; en essai, il est généré par `lancer.sh`.
5. Adaptateur `apps/api/src/equipe/keycloak-admin.ts` : royaume fixé à la construction, identifiants validés au motif UUID puis encodés, méthodes fermées (sessions, facteurs en types seulement, fermer une session, chercher, créer désactivé, activer, envoyer les actions, désactiver puis fermer les sessions), réponses projetées sur des champs fermés, codes d'erreur fermés sans corps de réponse, jeton en mémoire jusqu'à `exp − 30 s` sous une promesse partagée.

## Limites écrites (règle 9.4)
- `manage-users` est large : Keycloak permettrait aussi de supprimer un utilisateur ou de fixer un mot de passe. Les permissions fines de Keycloak sont écartées (complexité). La défense est l'adaptateur aux méthodes fermées, le test d'inventaire des appels, et le secret lu par l'API seule. La garde de contenu est non exhaustive par nature.
- Fermer une session se fait par `DELETE /sessions/{id}` (seule voie de Keycloak pour UNE session) : c'est le seul `DELETE` de l'adaptateur, jamais sur `/users`.
- Fermer la session Keycloak ne ferme pas celle de la console (gardée 8 h en mémoire) : dette A2 (T3-07e).
- Le royaume `equipe` n'a pas de SMTP : l'invitation ne part pas par courriel tant que A3 (T3-07f) n'est pas fait ; `envoyerActions` existe mais reste derrière un interrupteur fermé côté appelant.

## Options écartées
- Compte de service dans le royaume `master` : droits sur tous les royaumes, dont `clients`.
- Rôle `realm-admin` ou `manage-realm` : beaucoup trop large.
- Permissions fines Keycloak : complexité et comportement à prouver.

## Conséquences
- T3-07b et T3-07c branchent les routes sur cet adaptateur ; T3-07e et T3-07f ferment les dettes A2 et A3.
