# create-axion-module

Modèle de départ d'une automatisation : `pnpm create axion-module <code>`.

1. Crée `modules/<code>/` : paquet `@axion-auto/<code>`, version `0.1.0`, `apiMoteur` à la version courante de C4.
2. Le manifeste contient 20 cas d'essai inventés (dont 1 panne et 1 e-mail piégé), la fonction `migrer` et un test.
3. Le code est refusé s'il porte un identifiant de client (même règle que `defineAutomation`).
4. Un module = code commun versionné + réglages par client : aucune valeur propre à un client dans le code.
5. Le modèle ne contient aucune logique métier ; écrire l'étape `traiter` et les réglages.
6. Le module créé passe `axion-dev test` sans retouche ; les fichiers du modèle sont dans `gabarit/` (suffixe `.modele`).
7. Un dossier `modules/<code>` déjà présent n'est jamais écrasé.
8. Le dossier `modules/` est couvert par l'espace de travail pnpm.
9. Ensuite : `axion-dev essai`, `axion-dev test`, `axion-dev emballer`, `axion-dev publier --recette`.
10. Les noms de clients réels n'ont leur place nulle part : entreprises inventées seulement.
