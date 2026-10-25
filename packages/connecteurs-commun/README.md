# connecteurs-commun

Interface commune des connecteurs de messagerie et suite de tests que chacun doit passer.

## Écrire un connecteur
1. Déclare-le avec `declarer({ famille, outil, version, capacites, portees })` : version semver, actions de la famille seulement.
2. Pour chaque action, donne la garantie d'effet (`idempotent_par_cle`, `verifiable_apres_coup`, `au_plus_une_fois`).
3. Implémente `ConnecteurMessagerie` ; le jeton arrive en argument, ne lis jamais le coffre ni l'environnement.
4. Toute erreur sortante est une `ErreurConnecteur` d'une des 4 classes ; le reste devient `definitive`.
5. Ne réessaie jamais toi-même : le noyau décide du renvoi.
6. N'écris au journal que des identifiants et des codes (`journaliser`).
7. `envoyer` exige le `Message-ID` posé à la création.
8. Enregistre des réponses inventées (domaine `exemple.fr`), sans jeton ni vraie adresse, dans `src/suite/enregistrements/messagerie/`.
9. Passe la suite : `lancer(fabrique)` dans `src/suite/lanceur.ts`.
10. Le connecteur reste fermé : `CONNECTEURS_MESSAGERIE_OUVERT=1` pour l'ouvrir.
