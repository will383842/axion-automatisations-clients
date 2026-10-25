# Copie de secours d'OpenBao (A-303)

Décision : ADR 0017. La clé de signature `modules-signature` n'est pas exportable ; le secours est un instantané raft de tout OpenBao (clés de signature, clés HMAC de `technique/`, secrets clients). Il est chiffré par la barrière du coffre : sans 3 parts sur 5, il est inutilisable.

## Faire la copie
1. Prendre le jeton du rôle `secours` (lecture de `sys/storage/raft/snapshot` seulement) dans le gestionnaire de mots de passe.
2. `bao operator raft snapshot save <fichier>` depuis un poste sûr.
3. Ranger le fichier dans le gestionnaire de mots de passe, avec la date. Ne jamais le laisser dans un journal de CI, un dépôt ou un message.
4. Les parts de déverrouillage ne sont jamais rangées avec l'instantané.

## Restaurer dans un OpenBao neuf
1. Lancer un OpenBao neuf, l'initialiser une fois, puis restaurer : `bao operator raft snapshot restore -force <fichier>`.
2. Le coffre restauré redevient scellé : le déverrouiller avec les parts d'origine (`procedure-deverrouillage.md`).
3. Vérifier qu'une signature faite avant la copie est valide, et que `technique/echanges` répond.

## Rythme et essai
Une copie après toute création ou rotation de clé, et au moins une par semaine. Essai de restauration chaque trimestre, avec l'essai de déverrouillage.
