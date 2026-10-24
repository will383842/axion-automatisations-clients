# Où vont les données (A-032)

Document de preuve : pour chaque brique et chaque fournisseur, le lieu des données. Pas d'avis juridique ici.

## Briques inscrites (`ops/briques/`)
Toutes tournent chez AXION IA (lieu `local`) ; aucune n'est livrée chez un client à ce stade.

| Brique | Rôle | Lieu des données |
|---|---|---|
| `traefik` | proxy d'entrée | `local` : ne garde aucune donnée |
| `whoami` | écho d'essai (CI) | `local` : ne garde aucune donnée |
| `mailpit` | boîte de capture des e-mails d'essai | `local` : messages d'essai seulement |
| `postgres` | base de données | `local` : serveur d'AXION IA |
| `pgbouncer` | répartiteur de connexions | `local` : ne garde aucune donnée |
| `valkey` | files de tâches | `local` : serveur d'AXION IA |
| `openbao` | coffre à secrets | `local` : serveur d'AXION IA |
| `keycloak` | connexion | `local` : serveur d'AXION IA |
| `litellm` | passerelle d'IA | `local` pour la passerelle ; les demandes partent ensuite chez le fournisseur choisi (voir plus bas) |

## Fournisseurs d'IA
| Fournisseur | Lieu des données |
|---|---|
| Claude (Anthropic) | hors UE : à confirmer auprès du fournisseur |
| GPT (OpenAI) | hors UE : à confirmer auprès du fournisseur |

**À trancher par le juriste :** les fournisseurs d'IA situés hors UE posent la question du transfert de données personnelles. Ce document la signale ; il ne la tranche pas. Tant que le juriste n'a pas répondu, aucune donnée réelle de client ne part vers eux.
