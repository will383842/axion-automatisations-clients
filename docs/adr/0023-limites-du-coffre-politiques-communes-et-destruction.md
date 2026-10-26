# 0023 · Limites du coffre : politiques communes à tous les clients et droit de destruction de `api`

Date : 26/10/2026 · Statut : proposé (aucune décision prise ; l'architecte et `will383842` tranchent)

## Contexte
La livraison de T1A-06 (OpenBao, coffre et chiffrement par enveloppe) a relevé deux limites. Cette fiche ne les corrige pas : elle les pose pour décision.

1. **Politiques communes à tous les clients.** Les politiques `api`, `courtier` et `equipe` s'écrivent sur des chemins génériques (`clients/data/*`, `clients/metadata/*`, `transit/*/cli-*`). Un jeton de rôle vaut donc pour TOUS les clients. L'isolation entre clients repose sur le code (`tenantId` validé, référence refusée si elle est d'un autre client, données associées liées au client dans le chiffrement), pas sur OpenBao. Une faille du code de l'API ouvrirait tous les clients à la fois.
2. **Droit de destruction du rôle `api`.** Pour l'effacement par destruction de clé, `api` peut régler `deletion_allowed` puis supprimer `transit/keys/cli-*`. Un jeton `api` volé pourrait détruire la clé de n'importe quel client, donc rendre ses données illisibles pour toujours. Seule la confirmation exacte demandée par le code (`detruire-<tenantId>`) s'y oppose, et elle ne protège pas contre un jeton utilisé directement.

## Options à étudier (non tranchées)
Pour 1 : politiques par client, générées à la création du client (un jeton par client, courte durée, délivré par un service d'émission) ; ou conservation des politiques communes avec des contrôles ajoutés (journal d'audit d'OpenBao relu, alerte sur un accès à plusieurs clients).
Pour 2 : retirer la destruction au rôle `api` et la confier à un rôle dédié, utilisé seulement par une action humaine réauthentifiée ; ou garder le droit avec une double validation hors du code (deux approbations).

## Décision
Aucune pour l'instant. Chaque option demande un test d'isolation propre et, si un contrat change, l'accord de l'architecte.

## Conséquences en attendant
- Les politiques actuelles restent en place.
- Le risque est connu et suivi ici ; la relecture sécurité de T1A-06 le rappelle.
- Un changement de politique passera par un ADR qui remplace celui-ci.
