# Courtier de connexions (T4-39)

Seul lecteur du coffre des clients. Il remet à l'exécuteur, pour une exécution d'un client :
le jeton d'accès du fournisseur (jamais le jeton de renouvellement), ou un jeton court pour le mandataire.

- `src/remise.ts` : règles de la remise ; `src/jetons.ts` : jetons courts (client, exécution, portées) ;
  `src/journal.ts` : trace d'accès sans valeur ; `src/serveur.ts` : `POST /remise`.
- La signature de la cellule et le jeton d'instance sont vérifiés par l'API : la politique `courtier`
  ne lit que `clients/data/*`.
- Rien n'est gardé en cache, en base ni sur disque : la valeur ne traverse que la mémoire du traitement.
- Étapes à venir : identifiant de base limité au client, branchements réels, garde « seul lecteur ».
