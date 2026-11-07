# 0133 · Notifications par e-mail : catalogue, garde « texte validé » et rôles clients

Date : 07/11/2026 · Statut : proposé (T6-24a), à accepter par l'architecte · Contrat touché : aucun (la table des envois n'est pas empreintée ; seules les 18 valeurs `cleTexte` changent) · Migration : aucune · S'appuie sur : ADR 0119 (tables du portail)

## Contexte
- La table des envois (C-557) a 18 lignes, toutes par e-mail, dont 16 sans clé de texte. Le catalogue d'écran (`messages.fr.ts`, T0-23) impose la liste exacte de ses clés et l'API n'en dépend pas : y ajouter des e-mails casserait son test.
- L'expéditeur n'est branché nulle part et refuse tout rôle client ; aucun interrupteur `envoi.*` n'a de stockage. Aucun e-mail réel ne peut donc partir.
- Le transport n'envoie que du texte brut, sans pièce jointe.
- Les maquettes d'e-mail ne sont pas approuvées : les textes sont des brouillons.

## Décision
Ce qui est livré par T6-24a (catalogue, clés, ADR) est séparé de ce que livrera T6-24b (points 3 à 7, proposés ici pour accord).

1. **Catalogue des e-mails** : `packages/contrats/src/messages/catalogue.ts`, `CATALOGUE_EMAILS = { "email.<evenement>": { sujet, corps, bouton?, variables, validation } }`, une entrée par ligne de la table, rien d'autre. `validation` vaut `"a_valider"` ou `{ will: "AAAA-MM-JJ" }`. Toutes les entrées de T6-24a valent `"a_valider"`. Texte brut commençant par la marque `AXION IA` (C-572) et finissant par un pied commun (`PIED_EMAIL`, variable `{adresseSupport}`). Variables entre accolades, toutes déclarées ; tout nombre (seuil, délai, mois, numéro de facture) passe par une variable. `packages/contrats` n'importe jamais `packages/design`.
2. **Table** : seules les 18 valeurs `cleTexte` changent (`email.<evenement>`), y compris les deux lignes qui pointaient vers des textes d'écran (`lancementEnCours`, `brouillonExpire`) ; les textes d'écran restent en place pour les écrans. Aucune ligne ajoutée ni retirée.
3. **Garde « texte validé »** (T6-24b) : un texte `"a_valider"` est refusé au rendu (`EnvoiRefuse`, trace `refuse`), même interrupteur ouvert. Passer une entrée à `{ will: date }` ne se fait que dans une PR qui cite l'accord écrit de Will (et, pour `notificationViolation`, `relanceImpaye`, `nonPaiement30Jours`, l'avis du juriste ou la mention écrite de Will qu'il s'en passe).
4. **Expéditeur des clients** (T6-24b) : `envoyer` et `ROLES_EQUIPE` restent inchangés. Nouvelle méthode `envoyerAuClient(cle, { tenantId, role }, variables, clic?)`, `ROLES_CLIENTS = ["administrateur_client"]` (`collegue_invite` reste refusé). Contrôles avant le transport, dans cet ordre : ligne présente ; rôle égal au destinataire de la ligne et permis ; `tenantId` valide ; preuve de clic si le mode est `clic_will` ; conditions de la ligne par un port `Conditions` (port absent = refus) ; interrupteur (fermé = trace `coupe`) ; texte validé ; rendu ; destinataires par un port `AnnuaireClient` (absent ou vide = refus) ; pour chacun, adresse conforme, domaine hors de l'option `domainesRefuses` (vide par défaut ; la valeur réelle n'entre jamais dans le dépôt public), préférence, transport, trace. Aucune adresse ni aucun texte dans une erreur ou une trace. Échec fermé partout.
5. **Preuve de clic** (T6-24b) : objet opaque rangé dans un `WeakSet`, consommé une seule fois, pour la même clé ; `second_administrateur` ne peut cliquer que `notificationViolation` (C-617). Une garde de source interdit de la créer hors de `apps/api/src/routes/**`.
6. **Préférences** (T6-24b, T6-24c) : liste fermée des envois non désactivables (messages de service et de compte), liste des désactivables ; chaque ligne client est dans exactement une liste. Une ligne non désactivable ne lit jamais les préférences ; une lecture en échec = pas d'envoi facultatif. Les événements en camelCase passent en minuscules séparées par `_` (`palier80Client` donne `palier80_client`) pour respecter la contrainte de `preferences_notifications` ; la correspondance est injective. Le résumé hebdomadaire vit sur une ligne réservée de clé `resume_hebdomadaire`, jamais atteinte par un événement.
7. **Rendu** (T6-24b) : variables exactement celles déclarées, chaînes d'une ligne de 1 à 200 caractères sans caractère de contrôle ; toute variable dont le nom commence par `lien` commence par l'origine du portail ; remplacement littéral.
8. **Canal** : e-mail seulement ; ni l'expéditeur ni les préférences n'importent `canaux/**`.
9. **Texte brut en V1** : ni logo image ni pièce jointe. Le rapport mensuel et la facture sont annoncés par un lien vers l'espace client (répond à l'escalade du plan T5-22 sur la pièce jointe). Le logo image devient une dette (C-572).
10. **B-549 et B-550** sont testés sous `[C-557]` : ils ne figurent pas dans `spec/req-ids.json`, que les routines ne modifient pas. Le bandeau d'incident n'a aucune ligne dans la table : aucun e-mail.

## Options écartées
- Ajouter les clés d'e-mail à `messages.fr.ts` : son test impose une liste exacte et l'API devrait dépendre de `packages/design`.
- Ajouter un rôle client à `ROLES_EQUIPE` : l'adresse d'un client vient d'un annuaire par client, jamais de l'appelant ni de la configuration.
- Envoyer le rapport et la facture en pièce jointe : le transport actuel ne sait pas.
- Ajouter à la table les lignes du 27/10 (résumé, incident, maintenance, avis de gel) : décisions de Will, hors de ce lot.

## Conséquences
- Aucun e-mail ne part : expéditeur non branché, interrupteurs fermés, tous les textes « a_valider ».
- Une PR de validation (décision de Will) passera les textes à `{ will: date }`, avec ou sans juriste pour violation, relance d'impayé et non-paiement.
- Après la fusion, la colonne « clé du texte » de la table des envois du dépôt privé est mise à jour par le chef d'orchestre.
- Dettes : voir `spec/preuves/lot-6-t6-24a.md`.
