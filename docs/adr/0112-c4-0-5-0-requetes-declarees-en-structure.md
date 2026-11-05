# 0112 · C4 0.5.0 : requêtes déclarées en structure, lecture seule de `commun`

Date : 05/11/2026 · Statut : accepté (arbitrage de l'architecte du 05/11/2026) · Contrat touché : C4 (0.4.0 → 0.5.0) · Migration : aucune

## Contexte
L'ADR 0109 supprime tout texte SQL fourni par un module ; l'ADR 0043 avait ouvert `donnees` avec un champ `sql`. Le contrat doit suivre : un module déclare une forme, jamais du SQL. Aucune version importée ne porte de `donnees` non vide (vérifié le 05/11/2026), aucune fixture gelée n'est touchée (C4 n'est pas gelé).

## Décision
- Requête = objet strict `{ nom, mode: "lecture", parametres, forme, permission? }`. Paramètres typés (`uuid`, `texte`, `entier`, `horodatage`, `liste_uuid`), 30 au plus. Forme Simple ou Composée, schémas Forme, Filtre, Agregat et Parametre de `apps/api/src/donnees/requetes/structure.ts` (les listes de noms refusés et le motif des noms de requête y diffèrent : à réunir en T4-50b), écrits dans `packages/contrats/src/c4/forme.ts` sans dépendre du modèle des bases.
- Retirés : `sql`, `colonnes`, `liste`, `pagination`, `parEtablissement`. Table au motif `^commun\.[a-z][a-z0-9_]{0,62}$` : aucun autre schéma n'est nommable. Le motif n'est qu'un préfiltre : T4-50c exige que la table existe dans le modèle et porte `etablissement_id`.
- `actions` doit rester vide : l'écriture est fermée jusqu'à T4-64, T4-65 et T2-55. `PortDonnees.ecrire` est retiré du SDK.
- Compatibilité : un manifeste 0.3.0 ou 0.4.0 sans `donnees` reste valide. Un 0.4.0 portant `sql` est refusé avec « C4 0.5.0 : sql retiré (ADR 0109), déclarer une forme » ; portant `actions` non vide, avec « aucune action déclarable, l'écriture est fermée ».

## Conséquences
- Rétrécissement permis en 0.x ; un seul cas concret, aucun module existant touché.
- Le schéma ne connaît pas le modèle : colonnes, types et colonnes chiffrées sont vérifiés à l'import (T4-50c). Le paquet de génération du SQL vient avec T4-50b, le port avec T4-50d.
- Le contrat refuse déjà `etablissement_id`, `tenant_id`, les noms d'`Object.prototype`, `pg_*` et `current_*` (colonne, alias, paramètre), toute clé `__proto__`, et vérifie la cohérence paramètres/forme. Écart connu avec `structure.ts` : noms de requête à tirets ici, sans tiret là-bas ; à réunir en T4-50b.
- Un écran peut encore nommer une `action` dans un manifeste sans `donnees` (`manifeste.ts`, hors fiche) : sans effet, le port n'a plus d'écriture ; dette portée par T4-65.
- Toute écriture future est un nouveau cas fermé du schéma, avec son ADR.
