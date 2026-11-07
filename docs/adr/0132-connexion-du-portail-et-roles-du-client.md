# 0132 · Connexion du portail et rôles du client

Date : 07/11/2026 · Statut : proposé (T6-02a), à accepter par l'architecte · Contrat touché : aucun · Migration : aucune · S'appuie sur : ADR 0056 (connexion de la console), décision d'architecte E1 du 07/11/2026

## Contexte
- Le portail des clients n'avait pas de connexion : le client OIDC `portail` du royaume `clients` n'avait ni adresse de rappel, ni rôle, ni revendication d'organisation.
- Aucune table des membres n'existe en base (T7-02 n'est pas fusionnée) et la fiche interdit toute migration.

## Décision
1. Identité : le `sub` du royaume `clients`. Un jeton du royaume `equipe` est refusé (émetteur différent) côté Next et côté API.
2. Rôle : un rôle du client OIDC `portail` (`administrateur`, `utilisateur`, `lecture_seule`, `comptable`), émis par un mappeur `oidc-usermodel-client-role-mapper` dans la revendication `roles_portail` du jeton d'accès et du jeton d'identité. Le serveur exige exactement un rôle de cette liste fermée ; zéro, deux, un nom inconnu (dont `dirigeant`) : refus.
3. Organisation : appartenance à un seul sous-groupe `/organisations/{uuid v4}`, émise par `oidc-group-membership-mapper` (chemin complet) dans `organisations`. Groupes et appartenances ne se modifient que par l'administration Keycloak. Aucun attribut utilisateur.
4. Le dirigeant n'est ni un rôle ni une revendication : c'est un repère en base (T7-02, T6-35).
5. Session du navigateur : magasin en mémoire du serveur ; cookie `__Host-session` `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 8 h, 30 min d'inactivité ; nouvel identifiant à chaque connexion ; les jetons ne quittent jamais le serveur. Ni `prompt=login` ni `max_age=0`. Rappel en 302 direct.
6. Rafraîchissement du jeton d'accès à attente partagée (une seule promesse en vol par session) ; refus de Keycloak : session fermée.
7. Déconnexion en `POST` avec `Origin` exigé : session détruite, révocation côté Keycloak (point `logout`, `refresh_token`), puis 303 vers la fin de session.
8. Connexion, rappel et déconnexion restent derrière l'interrupteur `PORTAIL_CONNEXION_OUVERTE`, fermé par défaut.
9. Sécurité des écrans (C-681) : `middleware.ts` pose la CSP stricte à nonce, refuse tout geste d'une autre origine (origine = `PORTAIL_ORIGINE`) et renvoie vers la connexion.

## Options écartées
- Table des membres en base : exige une migration et T7-02.
- Attribut utilisateur `organisation` : modifiable si le profil est mal réglé.
- Fonction « Organizations » de Keycloak : appartenance multiple, forme de la revendication variable selon les versions 26.x ; à réétudier avec la table des membres.
- Rôles du royaume : partagés avec d'autres clients OIDC.

## Conséquences et limites
- Un jeton d'accès reste valable jusqu'à 300 s après la déconnexion (pas d'introspection en V1) : limite acceptée.
- `role_invitation` (dirigeant, administrateur, utilisateur) ne correspond pas aux quatre rôles : dette portée par T6-14.
- Next 16 déprécie `middleware.ts` au profit de `proxy.ts` (même fonctionnement). Le nom est gardé comme la console ; la bascule est une dette (escalade E2 du plan, à trancher par l'architecte).
