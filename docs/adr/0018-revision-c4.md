# ADR 0018 — Révision unique de C4 (v0.2.0)

## Contexte
Le prototype de l'exécuteur (T4-02) a trouvé 22 manques dans C4 v0.1.0 (`docs/c4-manques-du-prototype.md`). Le plan permet une seule révision, datée, puis le gel : 4B, 4C et le lot 6 consomment ensuite C4 v0.2.0, et tout changement devient additif ou une v2 avec ADR. Règle de fer inchangée : un module = code commun versionné + réglages par client, jamais de code propre à un client.

## Décision
Révision du 2026-10-26 (date de la PR ; la fusion la confirme dans `packages/contrats/VERSION`). Chaque manque est appliqué (avec son test) ou refusé (avec sa raison).

| # | Décision | Preuve ou raison |
|---|---|---|
| 1 | Appliqué : `executer(ctx)` est dans chaque étape du manifeste ; `lierEtapes` disparaît, la machine lit `module.etapes`. | `[LOT4-c4] une étape sans fonction d'exécution est refusée` |
| 2 | Appliqué : `ContexteEtape` = `reglages`, `signal`, `effet`, `ia`, `noterMotif(texte)`, rien d'autre. | `[LOT4-c4] le contexte d'étape n'expose aucune méthode de lecture…` ; test du noyau sur les clés réelles |
| 3 | Appliqué : `EtatVoulu.arretEnvois` (obligatoire) ; événement `a_trancher` (code fermé, aucun texte). | `[LOT4-c4] un état voulu sans arretEnvois…`, `… un événement a_trancher avec un champ texte…` |
| 4 | Appliqué dans `Configuration` (`clientId`, `automatisationId`, obligatoires). Refusé dans chaque événement : la console retrouve les étiquettes par `instanceId`, les répéter grossit les paquets et ouvre une divergence. | test de configuration |
| 5 | Appliqué : `signal_de_vie.celluleId` obligatoire. | test du signal de vie, fixtures |
| 6 | Appliqué : `packages/contrats/src/c4/intention.ts`, UUID v5, espace de noms fixe. | `[LOT4-c4] la clé d'intention est la même… (1 000 tirages)` |
| 7 | Appliqué (rupture permise ici) : l'action entre dans la dérivation ; les clés changent. | test « change si l'action… » ; test du noyau (deux actions sur un élément partent toutes deux) |
| 8 | Appliqué : `.claude/skills/connecteur/SKILL.md` nomme les trois garanties de `effets.ts`. | relecture |
| 9 | Appliqué (rupture) : `nouvellesTentatives` retiré, `POLITIQUES.passagere.essais` fixe les essais pour tous. | `[LOT4-c4] le champ nouvellesTentatives n'existe plus…` |
| 10 | Refusé pour cette révision : le port `Connecteurs` n'est pas dans C4 ; l'identifiant de résultat s'ajoutera à l'intention en 4B (additif, jamais le contenu). | — |
| 11 | Refusé : une erreur de classe `identification` dit déjà à la console de mettre l'instance en pause (`POLITIQUES.identification`) ; pas de route de plus. | — |
| 12 | Appliqué avec le 2 : la passerelle `ia` rend `jetons` et `coutIaMicroCentimes`, sources de l'événement `fin`. Le branchement est en 4B (T4-34). | type `PasserelleIa` ; test « sans passerelle » |
| 13 | Appliqué (règle écrite dans `contexte.ts`) : le délai coupe l'attente, pas l'effet en vol ; l'étape suivante repasse par la garantie. | commentaire du contrat |
| 14, 21 | Règle écrite : la console compte un seul `debut` et un seul `fin` par (instanceId, executionId). Preuve en 4B (T4-23). | commentaire de `evenements-executeur.ts` |
| 15 | Refusé pour cette révision : classer la panne de port en `passagere` est un comportement du noyau, sans changement de forme de C4 ; fait en 4B. | — |
| 16 | Refusé pour cette révision : l'état « non partie » est interne à la boîte d'envoi de l'exécuteur, hors C4 ; additif possible ensuite. | — |
| 17 | Règle écrite : `executionId` est dérivé de façon déterministe du déclencheur ; une relivraison le garde. | commentaire de `evenements-executeur.ts` |
| 18 | Refusé pour cette révision : la voie brouillon relève de la file de validation (T4-35) et passera par le retour de `effet`, sans clé de plus au contexte. | — |
| 19 | Appliqué : `defineAutomation` refuse une action déclarée par deux connecteurs. | `[LOT4-c4] une action déclarée par deux connecteurs…` |
| 20 | Appliqué (règle écrite dans `contexte.ts`) : `appeler` finit dans la marge de 60 s après l'arrêt. | commentaire du contrat |
| 22 | Refusé pour cette révision : relire les réglages avant chaque `effet` est un comportement du noyau (4B), sans changement de forme. | — |

Aussi : deux étapes du même nom sont refusées par `defineAutomation`, et le nom d'étape suit le motif des identifiants de C4.

## Conséquences
- C4 est gelé en v0.2.0. Ensuite : champs optionnels, nouveaux événements, nouvelles valeurs d'énumération côté émetteur seulement ; jamais un champ rendu obligatoire ni une valeur retirée.
- Les fixtures de C4 changent, `contrats.sha256` est recalculé par `node packages/contrats/scripts/empreinte.ts`.
- Les modules écrits pour v0.1.0 doivent porter `executer` et ne plus porter `nouvellesTentatives`.
- Le noyau de l'exécuteur suit seulement les types : le contexte, la clé d'intention et la console simulée.

2026-10-26

> Note : `contrats.sha256` est remplacé par `packages/contrats/empreintes/` (un fichier par contrat), voir l'ADR 0019.

> Note (26/10/2026) : la règle « nouvelles valeurs d'énumération côté émetteur seulement » est remplacée par « récepteur d'abord », pour les valeurs comme pour les champs (ADR 0032).
