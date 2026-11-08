# 0146 · C1 1.2.0 et C2 1.1.0 : période libre, terme, regroupement

Date : 08/11/2026 · Statut : proposé (brouillon de l'architecte du 08/11/2026) ; à accepter après la fusion de T7-01 (ADR 0123), dans la PR de T7-29 · Contrat touché : C1 (1.1.0 → 1.2.0, additif) et C2 (1.0.0 → 1.1.0, additif) · Migration : aucune · S'appuie sur : ADR 0032 et 0033 (additif seulement dans la 1.x), 0123 (C1 1.1.0), 0145 (CHECK élargi en base)

## Contexte
- En 1.0.0, `PlanRequete` de C1 n'accepte que `periodeMois` ∈ {1, 6, 12} et ne connaît ni le terme ni le regroupement des brouillons. Les lignes de facture de C2 n'ont ni prix mensuel ni palier (C-651 les exige).
- Le reste existe déjà dans le contrat gelé : `PeriodeMois` (1 à `PERIODE_MAX_MOIS` = 12) et `Terme` dans C2 et C3, les lignes par abonnement de `facture.emise`, `MotifCloture` avec `changement_de_regroupement` et `changement_de_palier`.
- C1 1.1.0 est pris par T7-01 (ADR 0123).

## Décision
1. **C1 1.2.0, `PlanRequete`** (champs facultatifs seulement ; un champ absent garde exactement le sens de la 1.0.0) :
   - `periodeMois` élargi de {1, 6, 12} à `PeriodeMois` (entier de 1 à 12) ;
   - `terme` facultatif ∈ {`a_echoir`, `echu`}, absent = `a_echoir` ; en `echu`, le brouillon est généré le lendemain du dernier jour de la période, jamais avant ;
   - `groupeFacturation` facultatif : clé opaque fournie par la console (absente = facture seule) ;
   - `prixMensuelHtCentimes` facultatif (centimes entiers, positif ou nul), recopié sur la ligne ; `montantHtCentimesParPeriode` reste le montant facturé.
2. **Règle de regroupement** écrite dans le contrat : les brouillons des plans de même `groupeFacturation` et de même échéance forment un seul brouillon, une ligne par plan, total = somme des lignes ; un plan sans rien à facturer ce jour-là n'y met aucune ligne. Changer de regroupement = clore (`changement_de_regroupement`) puis recréer à la prochaine échéance non générée, sans rattrapage.
3. **C2 1.1.0, `LigneFacture`** : `prixMensuelHtCentimes?` et `palier?` (texte court), facultatifs.
4. **Ordre récepteur d'abord**, inchangé : le Hub accepte les champs nouveaux de C1 avant que la console les envoie ; la console accepte les champs nouveaux de C2 avant que le Hub les envoie. Tant que le Hub annonce une version antérieure, la console n'envoie que des valeurs 1.0.0.
5. Rien d'autre ne change : aucune route d'émission, d'avoir, de suppression ni de remboursement ; TVA toujours 2000 ; aucun champ gelé affaibli ; `fixtures-gelees/1.0.0/` intouché.

## Options écartées
- **C1 1.1.0 pour cette révision** (ce que disait la fiche) : collision avec T7-01 (ADR 0123).
- **Une borne au-delà de 12 mois** : **à décider par Williams** ; ce serait une autre révision.

## Conséquences
- `packages/contrats/VERSION` (`c1=1.2.0`, `c2=1.1.0`), `CHANGELOG.md`, empreintes et `json-schema.json` régénérés ; le bouchon `tests/bouchons/hub/**` applique les nouvelles règles.
- Côté base, l'enregistrement d'une période de 2 à 11 mois attend l'ADR 0145 et sa migration.
- Le lot 2-bis (Hub) reçoit cet ADR du chef d'orchestre.
- Les prix et montants transportés ne sont pas calculés par le contrat : leurs règles relèvent de Williams.

## Critères de test (fiche T7-29)
Ceux de la fiche T7-29, dont : `[LOT7-C1] toutes les fixtures de fixtures-gelees/1.0.0 passent encore, avec le même sens` ; `[LOT7-C1] periodeMois 2, 3 et 9 acceptés ; 0, 13, 1.5 refusés` ; `[LOT7-C1] terme inconnu refusé ; absent = a_echoir` ; `[LOT7-C2] une ligne avec prixMensuelHtCentimes et palier passe ; une ligne 1.0.0 sans eux passe aussi`.
