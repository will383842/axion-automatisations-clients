# 0023 · Limites du coffre : politiques communes à tous les clients et droit de destruction de `api`

Date : 26/10/2026 · Statut : accepté pour le masquage du journal (décision d'architecte du 26/10/2026) ; proposé pour les points 1 et 2

## Contexte
La livraison de T1A-06 (OpenBao, coffre et chiffrement par enveloppe) a relevé deux limites. Cette fiche ne les corrige pas : elle les pose pour décision.

1. **Politiques communes à tous les clients.** Les politiques `api`, `courtier` et `equipe` s'écrivent sur des chemins génériques (`clients/data/*`, `clients/metadata/*`, `transit/*/cli-*`). Un jeton de rôle vaut donc pour TOUS les clients. L'isolation entre clients repose sur le code (`tenantId` validé, référence refusée si elle est d'un autre client, données associées liées au client dans le chiffrement), pas sur OpenBao. Une faille du code de l'API ouvrirait tous les clients à la fois.
2. **Droit de destruction du rôle `api`.** Pour l'effacement par destruction de clé, `api` peut régler `deletion_allowed` puis supprimer `transit/keys/cli-*`. Un jeton `api` volé pourrait détruire la clé de n'importe quel client, donc rendre ses données illisibles pour toujours. Seule la confirmation exacte demandée par le code (`detruire-<tenantId>`) s'y oppose, et elle ne protège pas contre un jeton utilisé directement.

## Options à étudier (non tranchées)
Pour 1 : politiques par client, générées à la création du client (un jeton par client, courte durée, délivré par un service d'émission) ; ou conservation des politiques communes avec des contrôles ajoutés (journal d'audit d'OpenBao relu, alerte sur un accès à plusieurs clients).
Pour 2 : retirer la destruction au rôle `api` et la confier à un rôle dédié, utilisé seulement par une action humaine réauthentifiée ; ou garder le droit avec une double validation hors du code (deux approbations).

## Décision
Aucune pour les points 1 et 2 pour l'instant ; le masquage du journal est tranché dans la section « Décision d'architecte » ci-dessous. Chaque option demande un test d'isolation propre et, si un contrat change, l'accord de l'architecte.

## Conséquences en attendant
- Les politiques actuelles restent en place.
- Le risque est connu et suivi ici ; la relecture sécurité de T1A-06 le rappelle.
- Un changement de politique passera par un ADR qui remplace celui-ci.

## Décision d'architecte : masquage du journal (26/10/2026, relecture de T1A-06-b)
Cette partie est tranchée ; les points 1 et 2 ci-dessus restent ouverts.

Contexte : le masqueur remplaçait chaque valeur de secret dans la ligne JSON déjà écrite. Une valeur courte cassait toutes les lignes ; ignorée, elle sortait en clair. Une valeur longue choisie par un client (`","tenant":"`) retirait un champ de toutes les lignes, sans casser le JSON.

Décision :
- **Une valeur trop courte n'entre jamais.** `LONGUEUR_MINIMALE` (8, dans `plugins/journal.ts`) est la seule limite. `rangerIdentifiant` refuse une valeur plus courte (`requete_refusee`, avant tout appel) ; `lireValeur` et le lecteur `technique/` ne la rendent jamais (`coffre_indisponible`, sans la valeur). Refuser, pas ignorer : aucune valeur que le masqueur ne sait pas cacher n'arrive dans le processus.
- **On masque les valeurs, pas la structure.** Le flux du journal lit la ligne JSON, masque chaque chaîne (jamais les noms de champs), puis la réécrit. Une ligne qui n'est pas du JSON est masquée comme texte.
- **Les champs de traçabilité ne sont jamais masqués** : `reqId`, `tenant`, `tenantId`, quand ils ont la forme d'un identifiant. Ils sont posés par le serveur ; un client ne peut pas les effacer en rangeant l'identifiant d'un autre.

Conséquences :
- Un besoin réel de secret de moins de 8 caractères (un code PIN) devra être porté dans une autre forme (par exemple avec un préfixe) ou passer par un nouvel ADR.
- Le code ne doit jamais placer une valeur venue d'un client dans `reqId`, `tenant` ou `tenantId`.
- Limites acceptées : un nom de champ n'est pas masqué ; le masquage reste global au processus (pas limité à la requête du client). Le coût de `ajouter` (retri à chaque ajout) reste à traiter avant de brancher le masqueur au démarrage.
- Limite ouverte : quand le masqueur sera branché, limiter l'exemption des champs de traçabilité (`reqId`, `tenant`, `tenantId`) au premier niveau de la ligne, et traiter le coût de `ajouter` avant de le brancher.
