# 0048 · Copie du journal d'audit : limites connues et ancrage à venir

Date : 01/11/2026 · Statut : proposé

## Contexte
T2-10 copie chaque nuit les lignes de la veille du journal d'audit dans le compartiment `journal-audit` (verrouillage d'objets, mode COMPLIANCE, 5 ans), avec leur empreinte signée par OpenBao, après avoir vérifié la chaîne (ADR 0042). La relecture du tour 1 a relevé des limites qui ne sont pas corrigées dans cette PR. Elles sont écrites ici pour ne pas être oubliées.

## Décision
- La copie et la signature restent dans le même compartiment, sur le même serveur. C'est acceptable pour cette fiche, avec les limites ci-dessous.
- Les quatre points suivants deviennent des tâches à planifier (fiches suivantes), pas des corrections de T2-10.

## Limites connues
1. **Le serveur de stockage tient le verrou.** Avec SeaweedFS, COMPLIANCE est appliqué par la passerelle S3. Un accès au shell `weed`, au filer ou au disque permet de supprimer le compartiment entier. Parade à construire : copier aussi l'empreinte signée (jour, sha256, signature) **hors du serveur de stockage** (autre machine ou autre fournisseur).
2. **Clé d'écriture dédiée.** `creerPortCopieAws` reçoit les identifiants de l'appelant. Il faut une clé qui ne peut qu'écrire dans `journal-audit` (ni lire ailleurs, ni supprimer, ni changer la rétention), rangée dans le coffre.
3. **Ancrage dans la dernière copie.** `verifierChaine` accepte un paramètre `depuis` (dernière tête déjà copiée et signée) qui n'est pas encore alimenté : la vérification part du début de la chaîne. Quelqu'un qui réécrirait toute la chaîne de façon cohérente (superutilisateur de la base) passerait la vérification. Il faut lire la dernière signature copiée, vérifier sa signature auprès d'OpenBao, puis exiger que la chaîne en base la contienne à l'identifiant et à l'empreinte indiqués.
4. **Ligne validée après la copie.** `cree_le` vient de `clock_timestamp()` avant la prise du verrou du journal : une transaction à cheval sur minuit peut valider une ligne datée de la veille après la copie de la veille, qui ne figurera alors dans aucune copie. Parade : décaler l'heure du job (par exemple 02 h, bien après minuit) et, à l'ancrage (point 3), comparer avec la tête signée pour détecter une ligne datée de la veille apparue après coup.
5. **Verrouillage du compartiment.** `ops/socle/stockage/initialiser.sh` reconnaît désormais le nom exact du compartiment, mais ne relit pas encore la configuration de verrouillage d'un compartiment déjà présent (la commande `weed shell` qui l'affiche n'est pas vérifiée sur la version 4.51 épinglée). À faire : relire la configuration (`GetObjectLockConfiguration`) et échouer si elle est absente. Le compartiment doit être créé avec le verrouillage dès sa création ; un compartiment existant sans verrouillage est à recréer, pas à corriger.

6. **Effacement (T2-11) et copies verrouillées.** Les copies contiennent des lignes entières (`ancienne`, `nouvelle`, `ip`) pour cinq ans, et une copie COMPLIANCE ne peut jamais être réécrite. Contrainte pour T2-11 : l'effacement doit couvrir les copies verrouillées ; aucune solution par réécriture du journal ou des copies (par exemple, agir avant l'écriture au journal : chiffrement par organisation puis destruction de la clé, ou identifiants seulement). À décider avant la mise en service du job de nuit.
7. **Ce qui n'est pas encore branché.** Travailleur et planificateur de `copie-journal`, route `GET /equipe/journal` dans `serveur.ts`, type d'alerte `journal_rompu` dans `alertes/port.ts`. Les points 3 (ancrage) et 4 (heure du job) sont à faire avant ou avec la mise en service du job de nuit.
8. **Contenu du document signé.** Il porte `{jour, sha256, signature}` sans la tête de la chaîne : l'ancrage devra s'appuyer sur la dernière ligne du `.jsonl`, et un jour sans ligne n'aura pas d'ancre. Ajouter la tête est un changement du format de la copie, à décider avec l'ancrage.

## Précision (correction après #117)
La clé d'écriture dédiée du point 2 n'a besoin d'aucun droit de lecture : le dépôt est une écriture conditionnelle seule (`If-None-Match: *`), sans lecture préalable de la clé.

## Conséquences
- Tant que les points 1 à 4 ne sont pas faits, la copie prouve qu'une ligne copiée n'a pas été modifiée après coup, pas que toute la chaîne n'a pas été réécrite par un administrateur de la base et du stockage.
- Aucun workflow modifié.
