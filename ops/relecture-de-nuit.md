# Relecture de nuit des PR à risque haut (C-384)

Document de conduite. Il décrit ce qui doit se passer ; il ne prouve pas que cela tourne.

## Ce qui est relu
Les PR ouvertes classées « risque haut » (contrats, migration, argent, isolation entre clients, sécurité).

## Qui relit
Une relecture par IA, en routine privée, hors du workflow public. Le relecteur lit la PR et la fiche ; il ne modifie rien et ne fusionne jamais.

## Résultat
Un commentaire par PR, en français, avec les points bloquants d'abord. Aucun secret, aucun nom de vrai client, aucun prix.

## Ce qui existe aujourd'hui
Le workflow `nuit.yml` lance les tests complets et l'analyse de sécurité. Il ne relit pas les PR. S'il doit changer, le chef d'orchestre le fait : la fiche T1B-00 ne touche aucun workflow.

## État de l'exigence
Partielle tant qu'une relecture de nuit n'a pas été constatée sur une PR réelle. La ligne datée de `spec/preuves.md` s'écrit à ce constat.
