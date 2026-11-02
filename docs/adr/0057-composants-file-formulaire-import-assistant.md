# 0057 · Composants de validation, de formulaire, d'import et d'assistant

Date : 02/11/2026 · Statut : accepté (fiche T3-03, étape 2) · Contrat touché : aucun

## Contexte
Les écrans des lots 3, 5, 6 et 7 réutilisent quatre composants : file de validation, formulaire, import de fichier et assistant pas à pas. Ils reçoivent des données personnelles de clients : rien ne doit rester dans le navigateur.

## Décision
1. **Aucun stockage navigateur** : l'assistant confie son brouillon à une fonction passée en propriété (`onBrouillon`), appelée à chaque frappe. Ni `localStorage`, ni `sessionStorage` (test `[B-212]`).
2. **Un seul bouton principal par écran** : « Continuer » ou l'action finale. « Retour », « Accepter » et « Refuser » sont secondaires.
3. **Le composant ne fabrique rien** : l'import ne transmet le fichier qu'après contrôle du type et de la taille (reçus en propriétés ; `types` ne contient que des extensions comme « .csv », jamais des types MIME) ; le contrôle est exporté (`controlerFichier`) pour que le serveur applique la même règle. Le serveur doit aussi vérifier le contenu réel du fichier : l'extension se falsifie.
4. **Clavier** : la file de validation répond à A (accepter) et R (refuser) quand la ligne a le focus, en plus des deux boutons nommés par l'élément concerné.
5. **Erreurs et aide** : l'erreur sous le champ est reliée par `aria-describedby` et `aria-invalid` ; l'aide ne s'ouvre qu'à la demande.
6. **Vérification d'accessibilité** : la fonction `violations` existante (axe-core n'est pas branché sur ces quatre composants : il passe par Playwright, donc par la galerie de T0-19, hors de cette étape).

## Conséquences et limites
- Le contraste et la galerie à 1440 et 390 px ne sont pas couverts ici : la galerie de T0-19 relève de fichiers hors de cette étape.
- Le brouillon n'est pas relu au rechargement : l'appelant le fournit par `brouillonInitial`.
- **Critère de fin de la fiche non rempli** : la fiche demande une page par composant dans la galerie de T0-19, à 1440 et 390 px, vérifiée avec axe-core. Cela n'est PAS fait : T3-03 n'est pas terminée. Sous-tâche proposée : « T3-03 étape 3 : pages de la galerie pour la file de validation, le formulaire, l'import de fichier et l'assistant, contrôle axe-core à 1440 et 390 px ».
- Au changement d'étape, l'assistant place le focus sur l'intitulé « Étape X sur Y » et l'annonce aux lecteurs d'écran.
