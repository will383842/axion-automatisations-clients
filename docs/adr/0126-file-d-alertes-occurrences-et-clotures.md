# 0126 · File d'alertes : occurrences et clôtures

Date : 07/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026 ; proposé par T5-04a) · Contrat touché : aucun (deux tables de client ; TABLES_COMMUNES inchangée ; C5 inchangé) · Migration : 0029 · S'appuie sur : ADR 0054 (alertes, décision 7, dette M9), 0116 (tables de la supervision, décision 9 et son ESCALADE)

## Contexte
- La politique transitions_alerte (0010) refuse toute mise à jour d'une alerte qui garde l'état « ouverte ». Le compteur, la relance et le rattachement à une alerte ouverte étaient donc impossibles (ESCALADE de T5-01b, défaut M4 de l'audit de #215).
- La file d'alertes demande : une seule alerte par client et par cause, un compteur, pas de relance avant 2 heures, une clôture motivée, une seule notification au retour au vert.

## Décision
1. Aucune politique existante n'est modifiée, aucune colonne n'est ajoutée à alertes, aucune fonction n'est créée.
2. Index unique partiel (tenant_id, cle_regroupement) sur les alertes ouvertes ou acquittées : une seule alerte en cours par client et par clé.
3. Table occurrences_alertes, par client, en ajout seul : une ligne par occurrence ; compteur = nombre de lignes ; la relance est un drapeau de l'occurrence ; refusée sur une alerte close.
4. Table clotures_alertes, par client, en ajout seul : une clôture par alerte, raison en code, auteur = acteur, heure du serveur ; refusée sur une alerte close.
5. Politique restrictive cloture_motivee : passer une alerte à « close » exige sa clôture. C'est une restriction de plus ; les alertes déjà closes ne sont pas relues.
6. alertes.derniere_relance reste en place et n'est plus écrite (jamais supprimée).
7. Assigner = acquitter (ADR 0054, décision 7) : inchangé.

## Options écartées
- ALTER POLICY transitions_alerte pour permettre « ouverte → ouverte » : une politique ne voit pas l'ancienne ligne ; elle permettrait aussi « acquittee → ouverte » (retour en arrière). C'est un relâchement de sécurité.
- Déclencheur qui compare l'ancienne et la nouvelle ligne : une fonction de plus dans la liste fermée (garde-migrations-fonctions.json, ADR) pour un besoin que deux tables en ajout seul couvrent.
- Écriture des alertes par console_equipe : de nouveaux droits d'écriture pour l'équipe sur une table de client.
- Colonne compteur sur alertes : même blocage que la relance (mise à jour d'une alerte ouverte).
- Motif de clôture en texte libre : il peut citer une adresse ; le commentaire libre a sa table (commentaires_alertes, 500 caractères).

## Conséquences
- Un essai du lot 2 qui fermait une alerte sans motif est adapté (exploitation.int.test.ts) : clore exige désormais une clôture.
- Le critère de l'ESCALADE de T5-01b devient : « la relance d'une alerte ouverte est enregistrée (occurrences_alertes.relance) sans changer d'état ».
- T5-05 (canal d'envoi), T5-06 (réveil), T5-07 (rayon d'impact) et T5-24 (accueil du matin) lisent le compteur dans occurrences_alertes.
- Volume : une ligne par occurrence. Une règle de conservation, si elle devient nécessaire, demandera un ADR (jamais une suppression décidée par une migration).
