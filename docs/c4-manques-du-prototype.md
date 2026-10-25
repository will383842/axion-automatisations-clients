# Manques de C4 trouvés par le prototype (T4-02)

Chaque manque dit où il se trouve, la correction proposée et sa classe.
Le prototype ne change pas le contrat : T4-03 applique ces corrections.
« Additif » = on ajoute sans casser un module existant. « Rupture » = un module existant doit changer.

| # | Endroit | Manque | Correction proposée | Classe |
|---|---|---|---|---|
| 1 | `packages/sdk-module/src/etapes.ts` (`Etape`) | Aucune fonction d'exécution par étape. Le prototype lie le code par nom (`lierEtapes`). | Le manifeste porte `executer(ctx)` par étape, ou un registre nom → fonction validé par `defineAutomation`. | Additif |
| 2 | `packages/sdk-module` | Pas de contexte d'étape. Le prototype fournit réglages, signal d'arrêt et `effet()`. Il manque l'accès à l'IA et le journal du motif. | Type `ContexteEtape` dans le SDK : `reglages`, `signal`, `effet`, `ia`, `motif`. | Additif |
| 3 | `packages/contrats/src/c4/etat-voulu.ts` | Pas d'état « à trancher » ni d'arrêt des envois dans `EtatVoulu`. Seuls `actif`, `pause`, `arrete` existent. | Ajouter `arretEnvois` (booléen) et l'issue `a_trancher` côté exécution. | Additif |
| 4 | `packages/contrats/src/c4/configuration.ts` | Pas d'étiquettes client et automatisation sur l'instance (A-372). | Champs `clientId` et `automatisationId` dans `Configuration`, repris par chaque événement. | Additif |
| 5 | `packages/contrats/src/c4/evenements-executeur.ts` | Le signal de vie ne nomme pas la cellule. | Champ `celluleId` dans `signal_de_vie`. | Additif |
| 6 | Règle de dérivation de la clé d'intention | Non écrite. Le prototype dérive un UUID v5 de (instance, exécution, étape, élément), codés en tableau JSON. | Écrire la règle dans C4, avec l'espace de noms fixe. | Additif |
| 7 | Même règle | Deux actions sur le même élément d'une même étape donnent la même clé. | Mettre l'action dans la dérivation, ou interdire le cas dans le SDK. | Rupture (les clés changent) |
| 8 | `.claude/skills/connecteur/SKILL.md` | Parle de « au plus une fois, au moins une fois, ou idempotent ». Les garanties de `effets.ts` sont `idempotent_par_cle`, `verifiable_apres_coup`, `au_plus_une_fois`. « Au moins une fois » n'existe pas. | Aligner le texte sur `effets.ts`. | Additif |
| 9 | `Etape.nouvellesTentatives` | Redondant avec `POLITIQUES.passagere.essais` (5 essais). Le prototype ignore le champ. | Retirer le champ, ou dire qu'il réduit seulement le plafond de 5. | Rupture si retiré |
| 10 | `Connecteurs.appeler` | Le résultat d'un effet déjà fait n'est pas gardé : une reprise ne le retrouve pas. | Le port garde un identifiant de résultat dans l'intention (jamais le contenu). | Additif |
| 11 | `Console` | Aucune route pour mettre une instance en pause après une erreur d'identification. Le prototype a `mettreEnPause`. | Route C4 ou événement qui demande la pause, avec effet sur `EtatVoulu`. | Additif |
| 12 | `Evenement` `fin` | `elements` et `minutesGagnees` sont comptés par le noyau, mais `jetons` et `coutIaMicroCentimes` n'ont pas de source tant que l'IA n'est pas dans le contexte. | Voir manque 2. | Additif |
| 13 | Délai par étape | `delaiMaxSecondes` existe, mais la coupure d'une étape déjà partie ne peut pas annuler un effet en vol. Le prototype passe un signal d'arrêt. | Écrire dans C4 que le délai coupe l'attente, pas l'effet, et que l'étape suivante passe par la garantie. | Additif |

## Choix du prototype
- Une étape qui lève une erreur non classée sort en `definitive`, sans renvoi.
- Un code d'erreur hors du motif `^[a-z][a-z0-9_]{2,63}$` devient `erreur_inconnue` ; le message n'est jamais envoyé (A-323).
- Les attentes sont bornées à 24 h ; une date de quota absente, infinie ou passée ne donne jamais d'attente négative ni infinie.
- Les intentions sont propres à une exécution : deux exécutions d'une même instance ne se lisent pas.
