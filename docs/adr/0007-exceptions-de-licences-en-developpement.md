# 0007 · Exceptions de licences pour deux dépendances de développement

Date : 24/10/2026 · Statut : accepté

## Contexte
La garde des licences (T0-08) n'accepte qu'une liste fermée. Deux dépendances de développement d'eslint en sortent : `argparse` (Python-2.0) et `minimatch` (BlueOak-1.0.0). Les deux licences sont permissives.

## Décision
Une liste d'exceptions NOMMÉES (paquet + licence) est écrite dans `scripts/garde-licences.ts`. Elle ne vaut que pour une dépendance de développement : si le paquet est aussi une dépendance de production, il est refusé. Tout autre paquet ou toute autre licence reste refusé.

## Conséquences
- Ajouter une exception demande un nouvel ADR.
- Les licences Python-2.0 et BlueOak-1.0.0 ne sont pas ajoutées à la liste générale.
