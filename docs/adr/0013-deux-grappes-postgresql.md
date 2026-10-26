# 0013 · Deux grappes PostgreSQL : la commune et celle des clients

Numéro 0013 : le 0009 était déjà pris par `0009-garde-statuses-write-limite.md` (renuméroté, la fiche T1A-14 demandait 0009).

## Contexte
L'archivage continu et la sauvegarde complète se font par grappe PostgreSQL. Si une seule grappe portait aussi les bases de travail des clients (`cli_<id>`, lot 2b), la sauvegarde de nuit en contiendrait les données de travail (interdit par C-052), et détruire la clé d'un client ne rendrait pas sa copie illisible.

## Décision
- La grappe COMMUNE porte `console`, `moteur`, `keycloak` et `passerelle_ia`. Elle seule est archivée et sauvegardée par le mécanisme de T1A-14.
- Les bases `cli_<id>` vivent dans une grappe DISTINCTE, même sur le seul serveur de la V1.
- Les bases des clients ont leur propre sauvegarde, chiffrée par la clé du client, au lot 2b.

## Conséquences
Deux services PostgreSQL à exploiter sur le serveur. Le test `[C-052]` vérifie qu'aucune base `cli_` n'est dans la grappe sauvegardée. L'architecte du lot 2b est prévenu par le sommaire de la PR.

2026-10-26
