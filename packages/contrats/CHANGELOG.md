# Journal des contrats

Une entrée par version, par contrat. Procédure : `README.md` et ADR 0032.

## 2026-10-27 · c5 0.4.0 (ouverture du lot 2, ADR 0040)
- Règle `unicite_sans_tenant` : tout index unique d'une table à `tenant_id` porte `tenant_id` (seule exemption : clé primaire en identité `GENERATED ALWAYS`). Liste `EXCEPTIONS_UNICITE` fermée et vide.
- Règle `etrangere_sans_tenant` : une clé étrangère entre deux tables à `tenant_id` lie `tenant_id` à `tenant_id`.
- `TENANT_FACULTATIF` (`public.journal_audit`) : seule table où `tenant_id` peut être NULL. Les deux règles s'ajoutent à la fin de `REGLES_C5`. Rétrécissement (0.x) : un schéma qui passait peut maintenant être signalé.

## 2026-10-27 · gel 1.0.0 (T0-30, ADR 0033)
**Gelés en 1.0.0** : commun, C1, C2, C3, C6. Dans la 1.x : additif seulement, récepteur d'abord (README, ADR 0032). Fixtures archivées dans `fixtures-gelees/1.0.0/` (test « [C-538] les fixtures archivées… » : chaque contrat archivé est relu).
**Non gelés** : C4 (0.3.0, révision unique d'abord, ADR 0018) et C5 (0.3.0, tant que le job de CI `contrats-pg` n'existe pas, ADR 0031).
### commun 1.0.0
- `horodatageSuivant(precedent, maintenant)` : chaque essai d'un envoi est re-signé avec un horodatage strictement plus récent ; une reprise dans la même seconde n'est plus refusée en `rejeu`. Anti-rejeu inchangé ; `dejaVu` doit être un test-et-pose atomique (commentaire du contrat).
- `CHAINE_SIGNEE` exporté (même texte que `fixtures/commun/constantes.json`).
### c1 1.0.0
- `POST /plans-recurrents` : `codeAutomatisation` et `referenceAbonnementConsole` **obligatoires** (un plan = un abonnement = une automatisation), ce que chaque ligne de `facture.emise` (C2) exige. Rupture faite avant le gel, sinon v2.
- Écart connu et décidé : `periodeMois` de C1 reste {1, 6, 12} (sous-ensemble de `PeriodeMois`, 1 à 12, de C2 et C3). L'élargir est additif (T7-29, Hub d'abord). `LigneFacture.prixMensuelHtCentimes` (T7-29) viendra aussi en champ facultatif.
### c2 1.0.0, c3 1.0.0, c6 1.0.0
- Aucun changement de forme depuis 0.2.0 (C2, C3) et 0.1.1 (C6) : passage en 1.0.0.
### c4 0.3.0
- Une seule forme de cellule, celle du coffre : `[a-z0-9]+(-[a-z0-9]+)*` (64 au plus) ; `kid` de même forme (32 au plus). `emplacementCoffre(cle)` : `c4:<cellule>:<kid>` ↔ `technique/echanges/c4-<cellule>/<kid>`. Rétrécissement (0.x).
### c5 0.3.0
- `rolesAdministration` : liste exacte de noms (vide par défaut) au lieu d'une expression sur le nom ; un rôle `admin_app` ou `<base>_proprietaire` n'est plus exempté par sa forme. Rupture d'appel (0.x).
### Documents
- `php/README.md` : copier aussi `fixtures/commun/` et `empreintes/commun.sha256`, et la liste pour axion-ia. `README.md` : comment appliquer `x-axion-regles`. ADR 0024 : en-tête « accepté ».

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
- `GET /statuts?depuis=` : curseur opaque non vide (`0` au premier appel), sans autre paramètre ; réponse avec `elements` et le `curseur` à renvoyer.
- `GET /faits?apres=` : curseur global opaque non vide (`0` au premier appel), `limite` (1 à 500) et `axiCli` facultatifs ; réponse avec `faits`, `suivant` et `complet`.
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
