# Journal des contrats

Une entrée par version, par contrat. Procédure : `README.md` et ADR 0032.

## 2026-10-26 · corrections de la relecture T0-30 (ADR 0031) · tout reste en 0.x
### commun 0.2.0 (nouveau dans `VERSION`)
- Signature : `verifier(cles, requete, maintenant, dejaVu)` choisit le secret par l'identifiant `X-Axion-Cle`, rend la clé qui a validé, refuse un rejeu en 401 `rejeu` (couple clé et signature gardé 600 s). Rupture d'appel (0.x).
- `EN_TETES` : `Idempotency-Key`, `Idempotency-Replayed`, `Retry-After` ; `ANTI_REJEU_SECONDES` 600, `CONSERVATION_IDEMPOTENCE_JOURS` 30.
- Code d'erreur `reauthentification_requise` (401) ; `motif` facultatif (code fermé) dans le corps d'erreur.
- Limites de débit de chaque canal (`LIMITES_DEBIT`) ; 429 avec `Retry-After` de 1 à 60 s.
- Un seul `Siren` (Luhn), `Siret`, `Adresse` (avec `ligne2`) ; `Centimes` et `Bps` positifs ou nuls ; `BpsPourcentage` ; `PeriodeMois` (1 à 12), `Terme` ; `Curseur`, `CURSEUR_INITIAL`.
- Règles de fond nommées dans le JSON Schema (`x-axion-regles`) ; objets stricts partout.
### c1 0.2.0
- `axiCli` obligatoire dans `POST /devis`, `POST /plans-recurrents`, `POST /factures-ponctuelles`.
- `POST /factures-ponctuelles` : `codeAutomatisation`, `lignes`, `acompteBps` (0 à 10 000) obligatoires ; période ordonnée.
- Réponses 200 et 202 de `retrouver-ou-creer` séparées ; motif de clôture et statuts en vocabulaires fermés.
- `GET /statuts?depuis=` et `GET /faits?apres=` : curseurs opaques non vides (`0` au premier appel) ; `limite` (1 à 500), `axiCli` facultatif ; réponse avec `suivant` et `complet`.
- Chaque route porte sa limite de débit et sa règle anti-doublon (Idempotency-Key sur chaque écriture).
- Fixtures : exemples valides et invalides de chaque réponse.
### c2 0.2.0
- Fixtures signées avec la clé de test du Hub (un secret par sens).
- `facture.emise` : union par `nature` (période obligatoire pour `abonnement`, aussi dans le JSON Schema) ; natures `stockage` et `solde_engagement` ; liens facultatifs `idBrouillon`, `referenceBonDeCommande`, `referenceAbonnementConsole` ; `lignes` facultatives (une par abonnement, chacune avec sa période et son terme) ; HT + TVA = TTC.
- `audit.cloture.siren` : contrôle de Luhn ; `avoir.emis` : montant positif.
### c3 0.2.0
- `plan.resume` : une liste `abonnements` (code, palier, période de 1 à 12 mois, terme, échéance), toujours sans montant. Rupture (0.x).
- Événement `automatisation.fin_programmee` (fin d'une seule automatisation).
- Routes exportées (`ROUTES_C3`) ; réactions de la console (`REACTIONS_CONSOLE`) : `effacement.demande` coupe les envois, met à l'écart, alerte Will et attend sa décision ; aucune suppression.
### c4 0.2.1
- Routes exportées (`ROUTES_C4`) ; règle de la cellule (`cellule.ts`) : une instance n'est servie qu'à la cellule de la clé `c4:<cellule>:<n>` ; un paquet mixte est refusé en entier (403). Additif.
- JSON Schema de la configuration, de l'état voulu et des paquets publiés dans `fixtures/c4/`.
### c5 0.2.0
- Règle `base_cli_partagee` (invariant 3 : un rôle par client) ; invariant 6 réécrit : une ligne de facture d'abonnement par (abonnement, début de période), hors avoirs ; `fixtures/c5/invariants.json`.
### c6 0.1.1
- Constantes publiées dans `fixtures/c6/constantes.json` ; `CONSERVATION_JTI_SECONDES` 120 ; route d'entrée et sa limite. Aucun changement du jeton.
### Empreintes
- `empreintes/<contrat>.sha256` ne couvre plus que `fixtures/<contrat>/`, pour tous les contrats, commun et C5 compris ; `contrats.sha256` (sommaire) revient.
