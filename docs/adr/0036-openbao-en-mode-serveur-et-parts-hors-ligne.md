# 0036 · OpenBao en mode serveur dans les tests, parts de déverrouillage hors ligne

Date : 29/10/2026 · Statut : proposé (T1B-02, consigne ce qui est livré au lot 1-A ; relecture de l'architecte du lot demandée) · Contrat touché : aucun

## Contexte
Décision d'architecte n° 6 du sommaire du lot 1-A. Le mode « dev » d'OpenBao démarre ouvert, en mémoire, avec un jeton connu : il ne prouve ni le scellement, ni le déverrouillage, ni la reprise après panne, qui sont des exigences (C-523).

## Décision
- Dans les tests comme ailleurs, OpenBao tourne en **mode serveur** à stockage intégré sur volume (`ops/socle/compose.openbao.yml`, configuration `ops/socle/openbao/config.hcl`). Il démarre scellé et non initialisé. Le mode dev n'est jamais utilisé.
- `ops/socle/openbao/initialiser.sh` initialise le coffre, déverrouille et crée les rôles et les politiques.
- Clé maîtresse : coupée en 5 parts, 3 suffisent. Les parts sont réparties par rôle, jamais par nom, et tenues hors ligne ; aucune part dans un dépôt, sur le serveur du coffre ou dans un message (`ops/openbao/procedure-deverrouillage.md`, `ops/openbao/deverrouiller.sh`).
- Pendant le scellement, l'API répond `coffre_scelle`, suspend les envois et refuse toute lecture de secret ; tout reprend à l'ouverture.
- Les clés de signature (HMAC) sont non exportables, mais l'instantané de secours (`ops/openbao/sauvegarde-de-secours.md`) permet la copie hors ligne ; il n'est jamais rangé dans le gestionnaire de mots de passe qui garde des parts.

## Conséquences
- Les essais sont un peu plus longs (initialisation, parts) mais prouvent ce que la production fera.
- Un redémarrage du coffre en production demande trois détenteurs de parts : exercice chronométré chaque trimestre.
- Le secours par instantané est détaillé dans l'ADR 0017.

Fiches : T1A-06 (coffre des clients, chiffrement par enveloppe), T1A-07 (clés de signature, déverrouillage, secours).
