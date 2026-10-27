# Sauvegardes (T1A-14)

Tout le mécanisme tourne sur des conteneurs jetables (`ops/socle/compose.sauvegardes.yml`). Rien n'attend le serveur, sauf le branchement sur la vraie Storage Box (lot 1-B).

## Ce qui est en place
- Archivage continu (C-045) : `archive_mode = on`, `archive_command` par pgBackRest, `archive_timeout = 300` : un journal part au plus toutes les 5 minutes, la perte reste sous 15 minutes (C-044).
- Sauvegarde complète de nuit : `sauvegarder-nuit.sh`, dans le conteneur PostgreSQL. Elle lance `pgbackrest check` avant la première sauvegarde (sinon l'archivage échoue sans bruit), puis la complète, puis une complète dans le second dépôt quand le mois n'en a pas encore, puis l'expiration. Rien ne la planifie encore (voir lot 1-B).
- Chiffrement avant départ (C-046, C-593) : `repo1-cipher-type` et `repo2-cipher-type` valent `aes-256-cbc`. La phrase est lue dans OpenBao au moment de l'usage par `lire-phrase-chiffrement.sh` ; `pgbackrest-archiver` (commande d'archivage) et `sauvegarder-nuit.sh` la donnent aux deux dépôts par l'environnement du seul processus pgBackRest. Elle n'est ni dans un fichier versionné ni dans une variable de compose. En essai, elle est générée au lancement dans un volume jetable lisible du seul utilisateur `postgres` ; la cible d'essai ne reçoit que la clé publique.
- Rétention (C-049) : 30 quotidiennes et 12 mensuelles. `retention.ts` est le calcul de référence (fonction pure, testée). Choix documenté : deux dépôts pgBackRest. Le dépôt 1 garde 30 complètes ; le dépôt 2 garde une complète par mois, 12 au plus (`repo2-retention-full = 12`). Un essai en conteneur vérifie que le second dépôt reçoit sa complète.
- Restauration : `restaurer.sh` restaure dans un conteneur NEUF, attend qu'il réponde et imprime son nom.
- Artefacts de modules (A-192) : `copier-artefacts.sh <source> <cible>` copie sans jamais remplacer ni supprimer, et réussit à chaque nuit même si le fichier est déjà sur la cible. La source est un dossier : le branchement sur le compartiment `artefacts` du stockage d'objets (T1A-11) reste à faire.
- Grappes : voir l'ADR 0013. Seule la grappe commune est sauvegardée ici.

## Phrase de chiffrement
Rangée dans OpenBao (`technique/sauvegardes`) ; une copie hors ligne, en un lieu distinct, est inscrite à `ops/secrets-inventaire.md` (`PHRASE_SAUVEGARDES`). Sans elle, aucune sauvegarde ne se relit : la copie hors ligne se vérifie à chaque départ d'un administrateur.

## Ce qui reste au lot 1-B
- Sous-compte dédié de la Storage Box, avec sa clé, joignable par le seul serveur de la console, en AJOUT SEUL (le serveur ne peut pas effacer), jamais lisible depuis le serveur du CRM ni depuis un workflow GitHub. L'« ajout seul » ne se simule pas fidèlement sur la cible d'essai : il n'est pas prouvé ici. En ajout seul, `pgbackrest expire` échouera et fera sortir `sauvegarder-nuit.sh` en erreur : l'expiration devra se faire d'un autre endroit.
- Empreinte d'hôte : remplacer `repo1-sftp-host-key-check-type=none` (et `repo2-…`) par `fingerprint` avec l'empreinte de la Storage Box, et ajouter une garde qui interdit `none` hors essai.
- Planification : rien ne lance `sauvegarder-nuit.sh` chaque nuit. L'outil de planification est à choisir et à brancher.
- Clé et phrase : la cible ne reçoit que la clé publique ; la phrase reste en 600 ou 640. Une phrase de production aléatoire d'au moins 32 octets.
- OpenBao : jeton et phrase circulent en HTTP clair sur le réseau interne (comme le reste du socle) ; un réseau dédié coffre ↔ sauvegarde ou TLS. `BAO_ADDR` vaut `hôte:port` ici, une URL ailleurs : à harmoniser.
- File d'archivage (T1A-15) : `pgbackrest-archiver` lit la phrase à chaque segment. Si OpenBao ne répond pas, pgBackRest s'arrête avant d'appliquer un plafond de file et les journaux s'accumulent dans `pg_wal`. T1A-15 devra soit lire la phrase une fois au démarrage (fichier en mémoire réservé à `postgres`), soit élargir ses fichiers autorisés. `archive-async` n'est pas réglé.
- Disques chiffrés LUKS (A-196, partie disques).
- Mesure de la remise en service en 4 h (C-044, partie remise en service).
- Fait : image `postgres-sauvegardes-pitr` publiée sur `main` par `images-derivees.yml` (exécution 40405513754), empreinte réelle dans `ops/briques/pgbackrest.json` et `compose.sauvegardes.yml`.
