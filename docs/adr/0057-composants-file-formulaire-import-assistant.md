# 0057 · Composants de validation, de formulaire, d'import et d'assistant

Date : 02/11/2026 · Statut : accepté (fiche T3-03, étape 2) · Contrat touché : aucun

## Contexte
Les écrans des lots 3, 5, 6 et 7 réutilisent quatre composants : file de validation, formulaire, import de fichier et assistant pas à pas. Ils reçoivent des données personnelles de clients : rien ne doit rester dans le navigateur.

## Décision
1. **Aucun stockage navigateur** : l'assistant confie son brouillon à une fonction passée en propriété (`onBrouillon`), appelée à chaque frappe. Ni `localStorage`, ni `sessionStorage` (test `[B-212]`).
2. **Un seul bouton principal par écran** : « Continuer » ou l'action finale. « Retour », « Accepter » et « Refuser » sont secondaires.
3. **Le composant ne fabrique rien** : l'import ne transmet le fichier qu'après contrôle du type et de la taille (reçus en propriétés) ; le contrôle est exporté (`controlerFichier`) pour que le serveur applique la même règle.
4. **Clavier** : la file de validation répond à A (accepter) et R (refuser) quand la ligne a le focus, en plus des deux boutons nommés par l'élément concerné.
5. **Erreurs et aide** : l'erreur sous le champ est reliée par `aria-describedby` et `aria-invalid` ; l'aide ne s'ouvre qu'à la demande.
6. **Vérification d'accessibilité** : la fonction `violations` existante (la bibliothèque axe-core est refusée par la garde des licences).

## Conséquences et limites
- Le contraste et la galerie à 1440 et 390 px ne sont pas couverts ici : la galerie de T0-19 relève de fichiers hors de cette étape.
- Le brouillon n'est pas relu au rechargement : l'appelant le fournit par `brouillonInitial`.
