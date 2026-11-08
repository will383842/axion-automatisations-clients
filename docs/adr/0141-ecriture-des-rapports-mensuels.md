# 0141 · Écriture des rapports mensuels : droits de console_app sur rapports_mensuels

Date : 08/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026 ; proposé par T5-22a) · Contrat touché : aucun · Migration : 0041 (droits seulement) · S'appuie sur : ADR 0116 (tables de la supervision, décision laissée ouverte), 0022 (table rapports_mensuels)

## Contexte
- La table rapports_mensuels existe depuis la migration 0022, avec la sécurité par client activée et forcée, mais console_app, console_equipe et console_lecture n'ont que le droit de lecture : aucun rôle ne peut préparer ni envoyer un rapport.
- L'ADR 0116 renvoyait l'ouverture des écritures à une décision « avant T5-01b ». Aucune migration de 0023 à 0030 ne l'a prise. La fiche T5-22 disait « sans migration » : c'était inexact.
- Le plan du concepteur numérotait cette décision 0127 et la migration 0041 ; 0127 est pris depuis (Sentry), cet ADR porte donc le numéro 0141.

## Décision
1. Droits seulement : aucune table, colonne, fonction ni valeur d'énumération. Aucun DROP, DELETE, TRUNCATE, RENAME ni ALTER POLICY.
2. INSERT pour console_app sur cinq colonnes : tenant_id, id, organisation_id, mois, objet_pdf_ref. L'état (« prepare » par défaut), l'auteur et la date d'envoi ne sont pas accordés.
3. UPDATE pour console_app sur trois colonnes : etat, envoye_par, envoye_le. Le mois, l'organisation et l'objet du PDF ne se modifient jamais.
4. Politique restrictive acteur_obligatoire_insert : une préparation exige un acteur (app.acteur), l'état « prepare » et aucun envoi.
5. Politique restrictive envoi_une_seule_fois : seule la transition prepare → envoye est acceptée, par l'acteur de la session, à l'heure de la transaction (now()). Un rapport déjà envoyé ne se modifie plus.
6. Les politiques restrictives s'ajoutent à isolation_client (permissive, inchangée) : elles ne peuvent que retirer des droits. console_equipe et console_lecture ne changent pas. Aucun droit de suppression.

## Options écartées
- Écriture par console_equipe : de nouveaux droits d'écriture pour l'équipe sur une table de client.
- Déclencheur qui compare l'ancienne et la nouvelle ligne : une fonction de plus dans la liste fermée des fonctions, pour un besoin que deux politiques couvrent.
- Droit d'UPDATE sur toute la table : il permettrait de réécrire l'objet du PDF après coup.

## Conséquences
- T5-22c (préparer, envoyer, routes) peut écrire sous console_app, dans des transactions courtes. L'envoi réel reste derrière un port et un interrupteur fermé.
- Retour arrière : REVOKE des deux droits seulement ; les politiques restrictives restent, sans effet sans droit (la garde des migrations refuse `DROP POLICY`, même en contraction).
- Numérotation : les migrations `console` 0031 à 0040 sont perdues (règle 6 : un numéro sauté ne se réutilise pas) ; la suivante est 0042.
- Les essais en base (droits-rapports.int.test.ts) tournent dans le job socle-integration ; ils n'ont pas été lancés sur le poste de développement (pas de démon Docker).
