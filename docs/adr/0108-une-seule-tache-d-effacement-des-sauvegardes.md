# 0108 · Une seule tâche d'effacement des sauvegardes, expiration automatique coupée

Date : 02/11/2026 · Statut : proposé (T1B-05, à confirmer par l'architecte du lot) · Contrat touché : aucun · Migration : aucune

## Contexte
La sauvegarde de la console part vers une Storage Box en **ajout seul** (C-593) : le serveur dépose, il n'efface ni n'écrase. Or `pgbackrest backup` lance aussi son propre `expire` à la fin de chaque sauvegarde. Sur une cible en ajout seul, cet `expire` échoue, donc la sauvegarde de nuit échouerait elle-même au-delà de 30 complètes. Depuis #59, `repo1-retention-full=9999` : la sauvegarde n'expire déjà aucune complète ; il ne reste que l'expiration automatique des journaux archivés.

## Décision
- **Une seule tâche efface** : `expirer.sh` (qui porte la garde de T1B-03 et `retention.ts`), lancée depuis un **compte distinct** de celui de la sauvegarde (configuration pgBackRest et clé SFTP propres). Rien d'autre n'efface. C'est aussi la tâche du « retrait de 35 jours » de T8A-04, qui n'y ajoute que la garde, le contrôle et l'ouverture par Will.
- **La sauvegarde de nuit coupe l'expiration automatique** : `--no-expire-auto` sur la ligne de commande et `expire-auto=n` sous `[global:backup]` du modèle (option de pgBackRest 2.59, la version épinglée). Une seule des deux suffirait ; les deux évitent qu'un changement du modèle ou de l'appel rouvre une deuxième tâche d'effacement.
- **Aucune règle d'effacement automatique du fournisseur de stockage** sur les sauvegardes : elle effacerait sans alerte ni journal et ferait une deuxième tâche. Les règles du fournisseur ne servent qu'à passer des fichiers au rangement froid et à abandonner les envois inachevés. Un test refuse un fichier d'exploitation versionné qui en porte une.
- **Si deux règles se contredisent, la plus prudente l'emporte** : on n'efface pas.
- **Rythme** : une complète par semaine, des différences chaque nuit (C-049 : 30 quotidiennes, 12 mensuelles, pour environ 4 fois moins de place que 30 complètes). Pas de copie annuelle de la console tant que J-1 (garde après la fin du contrat) n'est pas tranché.
- **Contrôle séparé** : `controle-fraicheur.sh` lit l'âge de la dernière sauvegarde valide ; il détecte une nuit où la tâche ne s'est pas lancée. Chaque passage écrit une ligne de journal (`journaliser.sh`), sous un nom de rangement unique.
- **Rotation de la phrase** : nouvelle stanza (ou nouveau dépôt), première complète, ancienne stanza gardée jusqu'à l'expiration de son contenu (README).

## Conséquences
- Si l'option `expire-auto` manquait dans une version future de pgBackRest : instantanés de la Storage Box à la place (alternative notée, non retenue).
- La cible d'essai ne simule pas l'ajout seul : le test de la 31e complète constate qu'aucun fichier n'est effacé et qu'aucun `expire` n'apparaît dans le journal de la sauvegarde ; il ne prouve pas l'ajout seul. La preuve sur la vraie cible est à T1B-09.
- Le second compte (clé SFTP propre, droit d'effacement) est à créer sur la vraie Storage Box (T1B-09) ; son installation (`planification.modele`) aussi.
- Les heures de la minuterie, le seuil de stockage (80 %) et le seuil de fraîcheur (26 h) sont des variables sans valeur de production, fixées en T8A-10.
