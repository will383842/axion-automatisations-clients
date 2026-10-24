# 0008 · Exception de licence MIT-0 pour nodemailer (dépendance de test)

Date : 24/10/2026 · Statut : accepté

## Contexte
Les versions de `nodemailer` qui corrigent les avis de sécurité (10.x) sont sous licence MIT-0. Cette licence est absente de la liste fermée de la garde des licences (T0-08), alors que la version 6.9.1, sous MIT, est visée par des avis. Les deux gardes se contredisaient pour ce paquet. `nodemailer` ne sert que de client SMTP de test dans `packages/harnais`.

## Décision
MIT-0 est plus permissive que MIT : elle n'impose aucune obligation, pas même de conserver la mention de licence. Elle n'est PAS ajoutée à la liste générale. Une exception NOMMÉE (paquet `nodemailer` + licence `MIT-0`) est ajoutée dans `scripts/garde-licences.ts`, sur le modèle de l'ADR 0007 : elle ne vaut que pour une dépendance de développement. Si `nodemailer` devient une dépendance de production, il est refusé. Toute autre dépendance en MIT-0 reste refusée.

## Conséquences
- Ajouter une autre exception demande un nouvel ADR.
- `nodemailer` passe de `dependencies` à `devDependencies` dans `packages/harnais` : il ne sert qu'aux tests.
- Un test vérifie que `nodemailer` passe et qu'un autre paquet en MIT-0 est refusé.
