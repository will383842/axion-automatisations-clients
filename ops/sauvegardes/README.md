# Sauvegardes (T1A-14)

Tout le mécanisme tourne sur des conteneurs jetables (`ops/socle/compose.sauvegardes.yml`). Rien n'attend le serveur, sauf le branchement sur la vraie Storage Box (lot 1-B).

## Ce qui est en place
- Archivage continu (C-045) : `archive_mode = on`, `archive_command` par pgBackRest, `archive_timeout = 300` : un journal part au plus toutes les 5 minutes, la perte reste sous 15 minutes (C-044).
- Sauvegarde complète de nuit : `sauvegarder-nuit.sh`, dans le conteneur PostgreSQL. Elle lance `pgbackrest check` avant la première sauvegarde (sinon l'archivage échoue sans bruit), puis la complète, puis l'expiration.
- Chiffrement avant départ (C-046, C-593) : `repo1-cipher-type = aes-256-cbc`. La phrase est lue dans OpenBao au moment de l'usage par `lire-phrase-chiffrement.sh` ; elle n'est ni dans un fichier versionné ni dans une variable de compose. En essai, elle est générée au lancement dans un volume jetable.
- Rétention (C-049) : 30 quotidiennes et 12 mensuelles. `retention.ts` est le calcul de référence (fonction pure, testée). Choix documenté : 30 complètes dans le dépôt 1 ; les mensuelles dans un second dépôt pgBackRest branché au lot 1-B.
- Restauration : `restaurer.sh` restaure dans un conteneur NEUF, attend qu'il réponde et imprime son nom.
- Artefacts de modules (A-192) : `copier-artefacts.sh <source> <cible>` copie sans jamais remplacer ni supprimer.
- Grappes : voir l'ADR 0013. Seule la grappe commune est sauvegardée ici.

## Phrase de chiffrement
Rangée dans OpenBao (`technique/sauvegardes`) ; une copie hors ligne, en un lieu distinct, est inscrite à `ops/secrets-inventaire.md` (`PHRASE_SAUVEGARDES`). Sans elle, aucune sauvegarde ne se relit : la copie hors ligne se vérifie à chaque départ d'un administrateur.

## Ce qui reste au lot 1-B
- Sous-compte dédié de la Storage Box, avec sa clé, joignable par le seul serveur de la console, en AJOUT SEUL (le serveur ne peut pas effacer), jamais lisible depuis le serveur du CRM ni depuis un workflow GitHub. L'« ajout seul » ne se simule pas fidèlement sur la cible d'essai : il n'est pas prouvé ici.
- Disques chiffrés LUKS (A-196, partie disques).
- Mesure de la remise en service en 4 h (C-044, partie remise en service).
- Second dépôt pgBackRest des mensuelles.
- Fait : image `postgres-sauvegardes-pitr` publiée sur `main` par `images-derivees.yml` (exécution 40405513754), empreinte réelle dans `ops/briques/pgbackrest.json` et `compose.sauvegardes.yml`.
