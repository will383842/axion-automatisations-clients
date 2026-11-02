# 0107 · Passerelle d'IA : clés des clients limitées à l'appel de modèle, dépense lue par une clé d'équipe de lecture

Date : 02/11/2026 · Statut : proposé (T1B-12, points 4 et 5) · Contrat touché : aucun · Migration : aucune.

## Contexte
La porte du lot 1-A a trouvé deux défauts avec la vraie passerelle épinglée (`ops/briques/litellm.json`) :
- la clé d'un client lisait la fiche de la clé d'un autre en donnant son empreinte (`/key/info?key=<empreinte>`, `/v2/key/info`) : 200 avec l'alias d'un autre client, 404 si l'empreinte n'existait pas. C'est un oracle ;
- `consommation.lire()` échouait toujours : `/key/info` ne rend pas `info.token` (le jeton est retiré de la réponse) et `/spend/logs` refuse la clé d'un client.

## Décision
1. **Point 5, variante (a)** : les clés des clients sont créées avec `allowed_routes` = chat et plongements (`/chat/completions`, `/v1/chat/completions`, `/embeddings`, `/v1/embeddings`), liste exacte `ROUTES_CLIENT` dans `cles.ts`. Aucun joker. Les routes `/key/*`, `/v2/key/*` et `/spend/*` sont refusées par la passerelle avant tout traitement : le refus est le même que l'empreinte existe ou non (pas de 404 différent). La variante (b), un filtre de routes devant la passerelle, n'est pas retenue : la version épinglée tient `allowed_routes`.
2. **Point 4** : la dépense est lue côté serveur avec une **clé d'équipe de moindre privilège**, créée avec la clé maîtresse mais limitée par `allowed_routes` à `/spend/logs`. Jamais la clé maîtresse, jamais la clé d'un client. Sa valeur vient du coffre (C-011) par la fonction `lireCleEquipe` ; elle n'est ni dans l'image, ni dans le dépôt, ni dans une erreur ou une trace.
3. Le journal est demandé pour l'empreinte SHA-256 de la clé du client, **calculée localement** (la clé du client ne part jamais). Chaque ligne rendue est revérifiée : une ligne d'un autre client fait échouer la lecture (`client_different`), jamais une somme mélangée.
4. `/key/info` n'est plus lu : la consommation est la somme des lignes du journal. L'ancien contrôle « journal incomplet » comparait la somme à la dépense de `/key/info` ; il disparaît avec cette route (le journal de `/spend/logs` rend toutes les lignes de l'empreinte demandée, sans pagination).

## Preuve
Dans le code de la version 1.83.14 de LiteLLM : `RouteChecks.is_virtual_key_allowed_to_call_route` lève une 403 « Virtual key is not allowed to call this route » pour toute route absente de `allowed_routes`, avant la vérification de rôle et avant le traitement de `/key/info`. Les essais `tests/audit-1a/passerelle.int.test.ts` le prouvent contre l'image épinglée : empreinte existante et inexistante, v1 et v2, même statut et même corps ; la clé d'équipe ne peut ni appeler un modèle, ni lire ou changer une clé.

## Conséquences
- Une automatisation n'appelle que le chat et les plongements. Toute autre route demande de changer `ROUTES_CLIENT` (revue de sécurité).
- Le branchement réel de la clé d'équipe dans OpenBao reste à faire avec la fiche qui branche la passerelle (lot 4).
