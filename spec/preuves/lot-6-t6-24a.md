# T6-24a · Catalogue des e-mails (brouillons à valider) et clés de texte de la table des envois

Exigence : C-557.

## Preuves
- `packages/contrats/src/messages/catalogue.test.ts` : chaque ligne de la table a sa clé `email.<evenement>` ; aucune clé sans ligne ; variables déclarées = variables utilisées ; aucun chiffre, montant, « tu », émoji ni mot du lexique interdit ; marque en tête et pied commun ; toutes les entrées « a_valider » ; aucun lien en dur ; aucun import de `packages/design`.
- `packages/contrats/src/notifications/table.test.ts` : la table garde ses 18 lignes, leurs modes, destinataires, interrupteurs et conditions ; aucune ligne de bandeau d'incident.
- `scripts/table-envois-textes.test.ts` : chaque `cleTexte` existe au catalogue des e-mails ; plus d'écart noté (ancien `it.fails`).

## Rouge puis vert
- Rouge : premier commit, tests seuls, le catalogue n'existe pas (`Cannot find module './catalogue.ts'`).
- Vert : deuxième commit, catalogue et clés de la table.

## Fichier hors fiche
- `scripts/table-envois-textes.test.ts` (ajouté à la liste par le plan du concepteur, écart E1).

## Ce qui reste
- Textes à relire par Will, et par le juriste pour violation, relance d'impayé et non-paiement.
- PR T6-24b (expéditeur des clients), après fusion de celle-ci.
