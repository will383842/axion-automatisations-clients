# 0011 · Exception de licence CC-BY-4.0 pour caniuse-lite (dépendance de production)

Date : 24/10/2026 · Statut : accepté

## Contexte
Next.js, imposé par la fiche T1A-17, dépend en production de `caniuse-lite` (via `browserslist`). Ce paquet contient des données de compatibilité des navigateurs sous licence CC-BY-4.0, absente de la liste fermée de la garde des licences. Source : https://github.com/browserslist/caniuse-lite (données de https://caniuse.com).

## Décision
Une exception NOMMÉE et minimale est ajoutée dans `scripts/garde-licences.ts` : paquet `caniuse-lite`, licence `CC-BY-4.0` exacte, dépendance de production seulement. La comparaison porte sur le nom entier du paquet (une autre portée est refusée) et sur la licence entière (casse, version, variante ou expression SPDX composite sont refusées).

CC-BY-4.0 exige d'indiquer l'auteur, la source, la licence et les modifications. Ces mentions sont livrées avec le produit dans `apps/console/public/attributions.txt` et `apps/portail/public/attributions.txt`. Un test vérifie leur contenu.

## Conséquences
- Ajouter une autre exception demande un nouvel ADR.
- CC-BY-4.0 reste refusée pour tout autre paquet.
- Si `caniuse-lite` change de licence, la garde le refuse.
