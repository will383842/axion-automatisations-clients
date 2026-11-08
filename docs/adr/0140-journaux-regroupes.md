# 0140 · Journaux regroupés : VictoriaLogs alimenté par l'envoi des applications

Date : 07/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026 ; proposé par T5-13b-3) · Contrat touché : aucun · Migration : aucune · S'appuie sur : fiche T5-13, exigences A-080, C-022, C-025, ADR 0127

## Contexte
- Les journaux des trois applications (API, exécuteur, console) doivent se lire en un seul endroit, sans donnée de client ni secret.
- Le bac à sable de l'exécuteur ne doit jamais être lu par un collecteur (C-022).
- La garde des briques refuse toute image sous AGPL hors de sa liste fermée (stockage-objet, openbao, litellm) : Loki est donc écarté.

## Décision
1. Collecteur : VictoriaLogs (`victoriametrics/victoria-logs`, Apache-2.0, non livrée, lieu `local`), une seule image pour le stockage et les requêtes. Image épinglée par empreinte lue sur le registre, inscrite dans `ops/briques/victoria-logs.json`.
2. Alimentation par ENVOI : chaque application pousse des objets déjà masqués vers `/insert/jsonline` (module `@axion-auto/observabilite/journal`). Aucun montage de l'hôte, ni `/var/lib/docker`, ni `docker.sock`, ni volume de l'exécuteur.
3. Liste fermée de champs : heure, niveau, application, code, message masqué et borné à 500 caractères, reqId, tenant. Aucun autre champ n'est recopié. Le contenu des étapes de l'exécuteur n'est jamais branché sur ce module.
4. Envoi jamais bloquant : au plus N lignes en attente, le surplus est compté comme perdu ; abandon à 2 s ; aucune file sur disque, aucune relance. Sans adresse de collecteur, rien n'est gardé ni envoyé (fermé par défaut).
5. Réseau interne seulement, aucun port publié, aucun `healthcheck` : l'image est sans shell ni client HTTP, aucune sonde interne n'est possible (essai de la CI du 07/11/2026). Le socle attend l'état « en marche » ; la santé (`/health`) est surveillée par le moniteur d'Uptime Kuma. Si l'architecte veut une sonde interne, il faut une autre image ou un service de sonde : décision à lui.
6. Plafond : durée de conservation et taille disque maximale par `JOURNAUX_RETENTION` et `JOURNAUX_PLAFOND_OCTETS`. Valeurs provisoires, fixées au lot 8a. Ce plafond n'est pas celui des journaux d'archivage de PostgreSQL (ADR 0039).

## Options écartées
- Loki : AGPL-3.0, refusé par la garde des briques ; l'accepter demanderait de modifier une garde interdite aux routines.
- Lecture des fichiers de journaux de Docker ou du pilote de journalisation : exige un montage de l'hôte ou du démon, contraire à C-022.

## Conséquences
- Limite (règle 9.4) : le masquage par motifs n'est pas exhaustif par nature ; le rempart est la liste fermée de champs, la borne de taille et le masqueur injecté.
- A-080 reste PARTIEL : les briques tierces (base, connexion, coffre...) ne sont pas collectées. Il faudra un pilote de journalisation ou un montage en lecture seule filtré : décision d'architecte.
- Les applications n'envoient encore rien : le branchement relève des fiches de câblage existantes. La lecture par la console est la PR suivante (T5-13b-4).
