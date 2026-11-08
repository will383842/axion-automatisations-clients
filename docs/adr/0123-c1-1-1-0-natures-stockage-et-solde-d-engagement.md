# 0123 · C1 1.1.0 : natures `stockage` et `solde_engagement` des factures ponctuelles

Date : 08/11/2026 · Statut : accepté sur le fond (décision de l'architecte du 08/11/2026, D2) ; en vigueur à la fusion de T7-01, qui applique la révision · Contrat touché : C1 (1.0.0 → 1.1.0, additif) ; C2 inchangé · Migration : aucune · S'appuie sur : ADR 0031, 0032 et 0033 (gel 1.0.0 et règle « additif seulement dans la 1.x »)

## Contexte
- C1 est le contrat par lequel la console demande au Hub (axion-ia) de préparer des documents. La route `factures-ponctuelles` crée une facture en BROUILLON. Son énumération `NatureFacturePonctuelle` n'admet que `mise_en_place` et `complement_prorata` (`packages/contrats/src/c1/schemas.ts`).
- Le lot 7 doit préparer deux autres factures ponctuelles : le stockage supplémentaire d'un mois (C-191, fiche T7-13) et le solde de l'engagement minimum à la fin d'un contrat (C-590, fiche T7-16).
- C2 1.0.0, gelé, connaît **déjà** ces deux natures dans les faits de facture que le Hub renvoie (`packages/contrats/src/c2/faits.ts`). Le Hub peut donc les émettre et les annoncer, mais la console ne peut pas les lui demander : C1 est en retard sur C2.
- C1 est gelé depuis 1.0.0 (ADR 0033) : dans la 1.x, une révision ne peut être qu'additive.

## Décision
1. `NatureFacturePonctuelle` devient `mise_en_place | complement_prorata | stockage | solde_engagement` : le même vocabulaire que C2, dans le même ordre.
2. `FacturePonctuelleRequete` reste un objet strict. Aucun champ existant ne change de type ni ne devient facultatif : `axiCli`, `codeAutomatisation`, `debutPeriode`, `finPeriode`, `referenceBonDeCommande`, `lignes` et `acompteBps` restent obligatoires pour toutes les natures. Le Hub n'a aucun cas « champ absent » à traiter.
3. Champs **facultatifs** ajoutés :
   - pour `stockage` : `mois` (`AAAA-MM`) et `quantiteGo` (entier, de 1 à 100 000) ;
   - pour `solde_engagement` : `referenceContratConsole` (texte), `moisRestants` (entier, de 1 à 120) et `dateFin` (date).
4. Nouvelle règle de C1 `champs_de_nature`, dans `packages/contrats/src/c1/regles.ts`, à côté de `periode_ordonnee` :
   - `stockage` exige `mois` et `quantiteGo`, et refuse les champs de `solde_engagement` ;
   - `solde_engagement` exige ses trois champs et refuse ceux de `stockage` ;
   - `mise_en_place` et `complement_prorata` refusent les cinq nouveaux champs : un ancien appel reste exactement valide, et un appel ancien enrichi par erreur est refusé ;
   - pour `stockage`, `debutPeriode` et `finPeriode` sont le premier et le dernier jour de `mois` ; pour `solde_engagement`, `finPeriode` = `dateFin`.
5. `codeAutomatisation` reste obligatoire. Pour `stockage`, il désigne l'automatisation qui porte le stockage du client ; pour `solde_engagement`, l'automatisation du contrat. **Aucune valeur réservée** : ce serait un sens caché dans un champ existant.
6. Les montants restent en centimes entiers (`Centimes`), HT. Toutes les lignes ont un prix unitaire positif ou nul, quelle que soit la nature : un `solde_engagement` ne peut pas devenir un avoir déguisé. `tauxTvaBps` d'une ligne `automatisation` reste 2000 (règle `tva_interdite`, inchangée). La TVA est toujours facturée.
7. Unicité, tenue des deux côtés : une seule `stockage` par (client, mois) et une seule `solde_engagement` par `referenceContratConsole`. Le Hub la tient (lot 2-bis), la console aussi (contraintes de T7-02). Une demande en double avec la même `Idempotency-Key` rend le même brouillon ; avec une autre clé, elle est refusée par le Hub (code existant `conflit`).
8. **Rien d'autre ne change** : aucune route ajoutée ni retirée ; aucune route d'émission, de suppression, de remboursement ni d'avoir ; tout reste BROUILLON ; même limite partagée de C1 ; même exigence d'`Idempotency-Key`.
9. Version : `c1=1.1.0` dans `packages/contrats/VERSION`, pour T7-01 seule, avec une entrée dans `CHANGELOG.md`. La révision de T7-29 (période, terme, regroupement) sera C1 **1.2.0** (ADR 0146).

## Options écartées
- **Union discriminée par nature**, comme pour les factures de C2 : la forme serait plus juste, mais le type exporté changerait de genre (objet → union). Les appelants TypeScript du lot 2 casseraient à la compilation alors que les données restent valides. Ce n'est pas « additif » au sens de l'ADR 0032. Gardée pour une 2.0.
- **Rendre `codeAutomatisation`, `referenceBonDeCommande` ou les dates facultatifs** pour les nouvelles natures : pour le Hub, relâcher un champ obligatoire de requête n'est pas additif, car un gestionnaire existant le lit sans le vérifier.
- **Routes à part** (`/factures-stockage`, `/soldes-engagement`) : deux routes de plus dans un contrat gelé, deux idempotences et deux limites à tenir. La route existante sait déjà tout faire en brouillon.
- **Facturer le stockage dans le plan récurrent** : le volume change chaque mois ; le plan récurrent ne porte pas de quantité variable, et le changer toucherait `plans-recurrents`, que révise T7-29.

## Conséquences
- Aucune migration. La console tient l'unicité dans les tables de T7-02.
- `packages/contrats/VERSION`, `CHANGELOG.md`, `contrats.sha256`, `empreintes/c1.sha256` et `fixtures/c1/json-schema.json` sont régénérés par l'outil du paquet. Un exemple neuf par nature est ajouté à `fixtures/c1/factures-ponctuelles.json`, généré lui aussi, jamais écrit à la main.
- `packages/contrats/fixtures-gelees/1.0.0/` n'est **pas** touché : les exemples gelés de 1.0.0 doivent toujours passer. Le gel éventuel d'un instantané 1.1.0 est un geste du chef d'orchestre.
- Lot 2-bis (Hub) : il implémente les deux natures côté serveur, avec l'unicité du point 7 ; le chef d'orchestre lui transmet cet ADR. Jusque-là, le bouchon du Hub (`tests/bouchons/hub/**` : `noyau.ts`, `serveur.ts`, `client-signe.ts`) accepte les deux natures, pour que T7-13 et T7-16 se testent.
- La console n'envoie jamais ces natures à un Hub qui annonce encore C1 1.0.0 : l'appel part derrière un interrupteur fermé par défaut, ouvert quand le Hub annonce 1.1.0.
- T7-29 est une **autre** révision de C1, avec son propre ADR (0146), après celle-ci ; les deux ne se fusionnent pas dans la même PR.
- **Hors de cet ADR, à décider par Williams** : le prix du Go de stockage et la règle de calcul du solde d'engagement (montant, prorata, dispense). Le contrat ne fait que **transporter** des lignes en centimes, sans les calculer. T7-13 et T7-16 citeront la règle que Williams aura validée.

## Critères de test (fiche T7-01)
- `[LOT7-C1] une facture ponctuelle stockage valide passe le schéma ; sans mois → refus`
- `[LOT7-C1] solde_engagement sans référence de contrat → refus`
- `[LOT7-C1] une nature ancienne qui porte un champ nouveau est refusée (champs_de_nature)`
- `[LOT7-C1] taux de TVA autre que 2000 → refus par la règle`
- `[LOT7-C1] aucun prix unitaire négatif n'est accepté, quelle que soit la nature`
- `[LOT7-C1] les anciennes natures et tous les exemples gelés de 1.0.0 passent encore (compatibilité)`
- `[LOT7-C1] aucune route d'émission, de suppression ni d'avoir n'apparaît dans le contrat`
- `[LOT7-C1] les natures de C1 sont incluses dans celles des faits de facture de C2`
