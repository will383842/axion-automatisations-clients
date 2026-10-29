# 0043 · C4 0.4.0 : données et écrans d'un module (révision additive)

Date : 29/10/2026 · Statut : proposé, en attente de l'accord de l'architecte (règle 5 de `CLAUDE.md`) et de l'audit en deux tours (fiche T4-49)

## Contexte
C4 est resté en 0.3.0 après le gel du 27/10/2026 (ADR 0033), pour recevoir une seule révision avant son propre gel (ADR 0018). Un module doit pouvoir être une petite application, pas seulement une tâche automatique : lire et écrire dans ses propres tables, avoir des écrans reliés à ces données, des permissions propres, des droits d'usage par fonction, un mode d'IA borné et un identifiant de corrélation dans les événements.
Décision de Will du 29/10/2026 : la question Y-1 est tranchée **OUI** (réponse : « fais selon tes recommandations »). Cette révision suit donc les recommandations de la fiche T4-49.

## Décision
**Une seule révision, strictement additive : 0.3.0 → 0.4.0.** Rien n'est retiré ni renommé ; chaque champ est facultatif avec sa valeur d'absence ; une fixture ou un manifeste 0.3.0 reste valide tel quel (test `[A-300]`). L'ordre de déploiement reste « récepteur d'abord » (ADR 0032).

### Champs ajoutés (liste exacte)
| Où | Champ | Absence |
|---|---|---|
| Manifeste | `donnees { requetes[], actions[] }` | aucune donnée déclarée |
| Manifeste | `permissions[] { nom, libelle, parDefaut[] }` | aucune permission |
| Manifeste | `fonctions[] { nom, libelle }` | aucune fonction d'usage |
| Manifeste | `ia.modes[]`, `ia.garde {…}`, `ia.utilise` | `["via_axion"]`, bornes de la plateforme, non déclaré |
| Écrans | `proprietes.source`, `proprietes.action` | écran sans donnée |
| État voulu | `modeIa`, `droitsUsage[]`, `paiementConstate`, `enveloppeSignee` | `via_axion`, aucun, `false`, rien |
| Événements | `correlation` (UUID v4) dans `debut` et `fin` ; `fin.ia` | pas de corrélation, pas de bilan d'IA |
| Événements | nouveaux types `etape` et `action_ecran` (corrélation obligatoire) | sans objet |
| Contexte d'étape | port `donnees` (`lire`, `ecrire`) | absent |

Les noms (`donnees`, `permissions`, `fonctions`, droits d'usage) suivent le motif existant de `Bouton.action`, `^[a-z][a-z0-9-]{1,40}$` : tirets, jamais de soulignés, aucun élargissement.

### Règles de forme écrites dans les schémas
- Une requête est toujours en `lecture` ; une lecture de liste porte une pagination par `curseur`.
- Une action en `ecriture` déclare `historique: true`, sinon elle est refusée. La ligne d'historique (qui, quand, quoi, valeur avant) est écrite par le port, jamais par le SQL du module (C-625).
- Le SQL est paramétré : `$1…$n` seulement, ni littéral, ni commentaire, ni point-virgule ; une lecture ne contient aucun mot d'écriture. C'est une forme, pas une preuve.
- Une `permission` nommée par une requête ou une action doit être déclarée ; une `source` ou une `action` d'écran doit l'être aussi. Une action de `Bouton` d'un module qui ne déclare pas `donnees` reste valide (0.3.0).
- Le manifeste n'accepte aucune fonction ni texte évalué dans ces champs (B-171).
- Huit composants d'écran comme le portail : Indicateur, Tableau, Graphique, FileDeValidation, Formulaire, Import, Calendrier, FilActivite. `TableauSimple`, `Carte`, `Bandeau`, `Statistique`, `Lien` et `Bouton` restent acceptés comme alias 0.3.0.

### Ce qui reste interdit
Du SQL libre ; le schéma d'un autre module ; du JavaScript de module dans le portail. Le schéma ne suffit pas à tenir ces interdits : la vérification réelle du SQL (schéma `a_<code>` seul en écriture, `commun` en lecture seule, refus de tout autre schéma) est à l'import, en T4-50.

### Enveloppe signée (C-683)
`enveloppeSignee { version, charge, signature }` est réservée au mode autonome (V2). Objet strict : charge en base64url de 8 Ko au plus, signature de 86 caractères (64 octets sans bourrage). L'exécuteur la lit, la garde telle quelle et l'ignore en V1 ; elle n'est jamais journalisée, jamais copiée dans le contexte d'étape ni dans un événement (un événement qui la porterait est refusé). Le contenu et la vérification restent à trancher (V2).

## Points ouverts, à trancher par l'architecte
1. **`ia.utilise` obligatoire ?** La fiche le veut obligatoire (C-659, refus d'un manifeste qui ne le déclare pas) mais aussi un manifeste 0.3.0 valide tel quel : les deux se contredisent. Ici il est **facultatif** ; le refus d'un manifeste qui ne le déclare pas se fait à l'import (T4-25), ou par une version majeure.
2. **Corrélation « dans chaque événement ».** Obligatoire dans `debut` et `fin` casserait les fixtures 0.3.0. Elle y est facultative ; elle est obligatoire dans les deux types nouveaux.
3. **`modeIa` de l'état voulu contre `ia.modes` du manifeste** : le contrat ne peut pas croiser deux objets distincts ; T4-54 refuse un `modeIa` que le manifeste n'admet pas.
4. **Longueur de la signature de l'enveloppe** : 86 caractères suppose 64 octets ; à confirmer avec le choix de l'algorithme en V2 (un 0.x peut encore le corriger).
5. **Noms des huit composants** alignés sur la liste de la fiche ; à confirmer avec T6-06.
6. **Port `donnees` facultatif** dans `ContexteEtape` : le rendre obligatoire demande de toucher l'exécuteur et le harnais (T4-50).

## Conséquences
- `VERSION` : `c4=0.4.0` ; `CHANGELOG.md`, empreintes et `contrats.sha256` régénérés par le script.
- Le gel de C4 en 1.0.0 se fera après l'audit et par une PR à part.
- L'exécution (SQL réel, port, écrans, droits d'usage, paiement, enveloppe) est dans T4-50, T4-51, T4-54, T2-49 et T6-06.
- Aucun workflow ni archive gelée modifiés.
