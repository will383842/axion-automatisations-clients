# 0039 · Sauvegardes par pgBackRest et plafond de la file d'archivage

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 8 du sommaire du lot 1-A. Il faut une perte maximale de 15 minutes (C-044), un archivage continu (C-045), un chiffrement avant départ (C-046, C-593) et des disques qui ne se remplissent jamais, même si la cible des sauvegardes est injoignable.

## Décision
- **pgBackRest** (licence MIT) : archivage continu (`archive_mode = on`, `archive_timeout = 300`), sauvegarde complète de nuit, dépôt chiffré (`aes-256-cbc`). Voir `ops/sauvegardes/README.md`.
- Phrase de chiffrement rangée dans OpenBao, lue une seule fois au démarrage du conteneur PostgreSQL ; `archive_command` n'appelle jamais OpenBao.
- **Plafond des journaux en attente** : `archive-async=y` avec `archive-push-queue-max` (`ops/sauvegardes/pgbackrest.conf.modele`). Le plafond n'agit qu'en archivage asynchrone, donc les deux lignes vont ensemble. Au-delà, pgBackRest abandonne les journaux en attente : le disque ne se remplit pas et la base continue, mais la reprise à un instant précis n'est plus garantie jusqu'à la complète suivante. L'alerte « archivage interrompu » vient de `ops/surveillance/disque.ts`.
- Valeur du plafond : variable `PLAFOND_JOURNAUX_EN_ATTENTE`, à fixer au lot 8a (valeur provisoire dans le modèle, plus petite en essai).
- Rétention (30 quotidiennes, 12 mensuelles) pilotée par `ops/sauvegardes/retention.ts` ; pgBackRest n'expire rien seul.
- Seule la grappe commune est sauvegardée (ADR 0013).

## Conséquences
- Le conteneur PostgreSQL garde `init: true` : l'archivage asynchrone laisse un processus orphelin que PostgreSQL, s'il était le processus 1, prendrait pour un plantage.
- Sans la phrase de chiffrement, aucune sauvegarde ne se relit : copie hors ligne inscrite à `ops/secrets-inventaire.md`.
- Reste au lot 1-B : sous-compte en ajout seul, empreinte d'hôte SFTP épinglée, planification de nuit, TLS vers OpenBao.

Fiches : T1A-14 (scripts et tests en conteneurs), T1A-15 (disque plein, plafond des journaux, alerte).
