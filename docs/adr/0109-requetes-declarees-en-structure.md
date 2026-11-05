# 0109 · Requêtes déclarées en structure : aucun texte SQL fourni, un seul générateur

Date : 05/11/2026 · Statut : accepté · Contrat touché : aucun (C4 à réviser, voir conséquences) · Migration : aucune

## Contexte
Le service des données acceptait un texte SQL écrit à la main avec un emplacement `{{filtre}}`. Pour être sûr, il fallait un analyseur qui comprenne le SQL comme PostgreSQL. Cinq tours d'audit ont chacun trouvé un contournement (OR et UNION, sous-requêtes, fonctions de lecture, chaînes `E'…'` et `U&`, `(expr).fonction`, espaces Unicode, `nom::text(1)`).

## Décision
- Aucun texte SQL n'est fourni par une requête, un module ou un client.
- Une requête est un objet validé par un schéma zod strict (clé en trop refusée) : table, colonnes, filtres, tri, limite, agrégats, paramètres typés.
- Un seul module (`generer.ts`) produit le SQL. Les identifiants viennent de listes blanches lues dans le modèle des bases clients ; les valeurs sont toujours liées (`$n`). Le filtre d'établissement est posé par le générateur, en premier conjonct, une fois par table lue.
- Le validateur lexical et l'analyseur de forme sont supprimés.
- Écriture : refusée au chargement (`mode: "lecture"` seulement) tant qu'une écriture déclarée n'existe pas.

## Options écartées
- Durcir encore le validateur de texte : cinq échecs, la surface reste la grammaire entière de PostgreSQL.
- Analyseur `libpg_query` : dépendance native, même risque d'écart avec le serveur.
- Une vue SQL par requête : migration par requête, hors fiche.

## Conséquences
- Toute extension (jointure, OR, regroupement, écriture) est un nouveau cas fermé du schéma et du générateur, avec son test d'attaque, jamais un texte.
- Le contrat C4 0.4.0 accepte encore un champ `sql` de module ; rien ne l'exécute. Sa révision (champ structuré, `sql` refusé à l'import) demande l'accord de l'architecte et reste une dette.
