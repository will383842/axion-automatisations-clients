# 0020 · Exception de licence 0BSD pour tslib (ce qui est livré chez un client)

Date : 26/10/2026 · Statut : accepté (décision de l'architecte, déléguée par `will383842`)

## Contexte
L'exécuteur, livré chez un client, dépend de `tslib` (bibliothèque d'aide de TypeScript). Sa licence, 0BSD, est une licence très permissive (sans obligation de mention), mais elle n'est pas dans les six licences du livre (ADR 0012). La garde des licences refusait donc `tslib` dans ce qui est livré.

## Décision
Une exception NOMMÉE et minimale est ajoutée dans `scripts/garde-licences.ts` : paquet `tslib`, licence `0BSD` exacte, pour ce qui est livré chez un client. Sur le modèle de l'ADR 0011, la comparaison porte sur le nom entier du paquet et sur la licence entière : une autre casse, une expression composite ou un autre paquet en 0BSD restent refusés.

## Conséquences
- Ajouter une autre exception demande un nouvel ADR.
- 0BSD reste refusée pour tout autre paquet livré.
- Si `tslib` change de licence, la garde le refuse.
