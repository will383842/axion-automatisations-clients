C-392 → dépôts public et privé créés le 2026-10-24, application GitHub de Claude installée
C-554 → SECURITY.md et signalement privé actifs, sortie de ops/verifier-reglages-depot.sh du 2026-10-24
A-287 → ADR 0012 et test « [A-287] garde-licences refuse MPL-2.0 dans apps/executeur » (scripts/garde-licences.test.ts), 2026-10-24
A-189 → docs/migrations.md et test « [A-189] attaque : migrer refuse l'URL du rôle applicatif avant toute connexion » (apps/api/src/db/migrer.test.ts), 2026-10-25
A-087 → test « [A-087] l'API démarre et /sante répond 200 quand le Hub et le CRM sont injoignables » (apps/api/src/routes/sante.test.ts), 2026-10-25
A-381 → ADR 0014, ops/images/README.md et tests « [A-381] image dérivée postgres … » (scripts/images-derivees.test.ts), 2026-10-25 ; fichiers ops/briques/*.json et tests [A-381] de scripts/garde-briques.test.ts, 2026-10-25 ; ADR 0016, scripts/garde-briques.ts (clé `derivee`, attestation, refus de `build:`) et tests [A-381] de scripts/garde-briques-derivee.test.ts, 2026-10-25
A-032 → docs/localisation-des-donnees.md et test « [A-032] docs/localisation-des-donnees.md nomme chaque brique inscrite… », 2026-10-25
A-326 → test « [A-326] garde-briques refuse bullmq-pro dans le verrou » (scripts/garde-briques.test.ts), 2026-10-25
A-375 → ADR 0012 et tests [A-375] de scripts/garde-briques.test.ts, 2026-10-25
A-377 → ops/procedure-nouvelle-dependance.md et test « [A-377] ops/procedure-nouvelle-dependance.md exige ScanCode… », 2026-10-25
A-378 → test « [A-378] garde-briques refuse une image redis » (scripts/garde-briques.test.ts), 2026-10-25
A-379 → test « [A-379] garde-briques accepte OpenBao livree:false sous MPL-2.0 » (scripts/garde-briques.test.ts), 2026-10-25
C-493 → test « [C-493] garde-briques accepte valkey » (scripts/garde-briques.test.ts), 2026-10-25
A-052 → test « [A-052] un travail d'une instance d'une autre cellule est refusé » (apps/executeur/src/files/files.test.ts), 2026-10-26
A-268 → tests [A-268] de apps/executeur/src/files/files.test.ts (paliers 2, 4 et 8, concurrence, configuration validée), 2026-10-26
A-005 → tests « [A-005] une valeur rangée est inscrite au masqueur, sans inscription manuelle » et « … relue par le courtier … » (apps/api/src/coffre/coffre.test.ts, passage réel par rangerIdentifiant et lireValeur) ; tests « [A-005] le journal de l'API ne contient jamais la valeur rangée (marqueur unique cherché dans la sortie) » (apps/api/src/plugins/journal.test.ts) et version contre le vrai OpenBao (apps/api/src/coffre/secrets-openbao.int.test.ts) ; tests « [A-005] » de apps/api/src/plugins/journal.test.ts (double échappement JSON, formulaire, base64 décalé) et « [A-005] @isolation le jeton equipe lit l'état … 403 sur la valeur » de apps/api/src/coffre/secrets-openbao.int.test.ts ; refus des valeurs de moins de 8 caractères et structure du journal protégée (tests « [A-005] » de coffre.test.ts, secrets-openbao.test.ts et journal.test.ts, ADR 0023), 2026-10-26
C-012 → test « [C-012] après detruireCleClient, le déchiffrement échoue pour toujours » de apps/api/src/coffre/secrets-openbao.int.test.ts (vrai OpenBao), 2026-10-26
C-011 → tests « [C-011] » de apps/api/src/coffre/secrets-openbao.test.ts (imitation HTTP) et de apps/api/src/coffre/secrets-openbao.int.test.ts (vrai OpenBao en mode serveur : lecture courtier seul, coffre scellé par PUT sys/seal), 2026-10-26
A-328 → ADR 0025 et tests [A-328] de apps/executeur/src/bac-a-sable/bac-a-sable.test.ts (processus distincts, globales, fichiers, environnement, jeton, limites), 2026-10-26
A-329 → test « [A-329] @isolation l'enfant ne joint aucun hôte… » (apps/executeur/src/bac-a-sable/bac-a-sable.test.ts), étape 1 seulement ; mandataire à l'étape 2, 2026-10-26
A-062 → fichiers ops/socle/keycloak/royaume-*.json et test « [A-062] les royaumes equipe et clients sont importés et leur découverte OIDC répond » (apps/api/src/auth/keycloak.int.test.ts), 2026-10-26
C-001 → tests [C-001] de apps/api/src/auth/keycloak.int.test.ts (session de 8 h relue, rafraîchissement refusé après déconnexion forcée), 2026-10-26
C-002 → tests [C-002] de apps/api/src/auth/keycloak.int.test.ts (mot de passe seul sans jeton ni code, TOTP exigé) et de scripts/garde-royaumes.test.ts, 2026-10-26
C-003 → tests [C-003] de apps/api/src/auth/keycloak.int.test.ts (acr « mfa » dans le jeton réel, max_age=0 renouvelle auth_time) et ADR 0024, 2026-10-26
C-522 → ADR 0022, ops/briques/stockage.json et test « [C-522] ops/briques/stockage.json et le compose passent la garde des briques… » (apps/api/src/stockage/stockage.test.ts), 2026-10-26
A-061 → tests [A-061] @isolation de apps/api/src/stockage/stockage.int.test.ts (job socle-integration, brique SeaweedFS réelle) et de stockage.test.ts, 2026-10-26
C-081 → tests [C-081] de packages/sdk-module/src/prospection/prospection.test.ts, 2026-10-26
C-082 → ADR 0026 et tests [C-082] de packages/sdk-module/src/prospection/prospection.test.ts, 2026-10-26
C-080 → test « [C-080] un message sans fonction du destinataire est refusé » (packages/sdk-module/src/prospection/prospection.test.ts), 2026-10-26
C-087 → test « [C-087] un module de prospection sans source déclarée est refusé » (packages/sdk-module/src/prospection/prospection.test.ts), 2026-10-26
C-070 → test « [C-070] une source LinkedIn est refusée » (garde de code ; le document est en T4-00), 2026-10-26
C-086 → tests [C-086] de packages/sdk-module/src/prospection/prospection.test.ts, 2026-10-26
C-526 → dépôt privé, plan/mesures-lot-1/prix-modeles-ia.md, 2026-10-26
C-602 → partie T1A-15 (étape 1/2) : tests [C-602] de ops/surveillance/disque.test.ts, lancés par la CI via le projet ops de vitest.config.ts (prévision, réveil à 6 h, alerte avant plafond, message sans hôte ni IP) ; plafond archive-push-queue-max NON livré (fichier dans #59), essais d'intégration en attente de #59 ; sonde extérieure au lot 1-B, 2026-10-26
C-394 → packages/axion-dev/README.md (commandes essai, test, emballer, publier --recette) et tests [C-380] de packages/axion-dev/src/axion-dev.test.ts, 2026-10-26
