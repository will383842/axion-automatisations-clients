# axion-moteur

Une seule image pour l'exécuteur des automatisations. Le mode (`EXECUTEUR_MODE`) est un réglage : en V1 seul `mutualise` est accepté, `relie` et `autonome` sont refusés au démarrage (V2).

- Construite et publiée comme les images dérivées (ADR 0014), décision dans l'ADR 0104.
- Non root (identifiant 10001), disque en lecture seule, seul `/tmp` est écrit (tmpfs borné, voir `ops/socle/compose.executeur.yml`).
- Le point d'entrée refuse de démarrer en root.
- Aucun binaire headscale ni tailscale (C-495) ; aucune clé ni `.env`.
- Le compose et la chaîne de déploiement la citent par empreinte, jamais par étiquette. L'empreinte de la première publication est reportée après fusion par le chef d'orchestre ; d'ici là le compose n'a pas encore de service axion-moteur.
