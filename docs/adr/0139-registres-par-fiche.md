# 0139 · Registres par fiche : un fichier neuf par route, par action de route et par table

Date : 07/11/2026 · Statut : proposé (T-REG-1), à accepter par l'architecte · Contrat touché : aucun · Migration : aucune · S'appuie sur : ADR 0029 (index des ADR lu dans le dossier)

## Contexte
- Chaque fiche qui ajoute une route modifie 3 ou 4 lignes voisines de fichiers communs (apps/api/src/serveur.ts, scripts/liste-routes.ts, la matrice des droits, la garde des colonnes). Chaque fusion met donc les PR voisines en conflit : une session de développement et 10 à 15 minutes de CI à chaque fois.
- La branche main n'exige pas d'être à jour avant la fusion : un conflit n'est pas toujours visible.

## Décision
1. Un dossier par registre, lu à l'exécution (`readdirSync`, puis `import()` en top-level await), trié par nom de fichier (sans locale : ordre déterministe). Aucun fichier d'index ni liste générée : deux PR qui ajoutent chacune un fichier neuf n'ont aucune ligne commune.
2. T-REG-1 (cette décision) : `apps/api/src/routes/branchements/<module>.ts`, un fichier par module de routes, exporte par défaut `{ lister, serveur? }`. `serveur.ts` et `scripts/liste-routes.ts` parcourent le registre. Le typage des options de `construireServeur` vient d'une augmentation d'interface (`declare module "../branchement.js"`) écrite dans le fichier de la fiche.
3. Les deux autres registres suivent la même règle (T-REG-2 : `apps/api/src/droits/par-route/<module>.ts` ; T-REG-3 : `apps/api/src/db/colonnes/fragments/<fiche>.ts`, avec un socle figé des tables existantes). Nom de fichier : minuscules, chiffres et tirets, extension `.ts` ou `.js`.
4. Échec fermé au chargement : un fichier hors forme (`*.test.ts`, `*.d.ts`, majuscules, fichier parasite), un export sans `lister`, un `serveur` mal formé, une clé déclarée deux fois ou un dossier vide fait échouer le chargement. Un fichier n'est jamais ignoré en silence.
5. Un fichier de branchement n'importe jamais le chargeur du registre (le top-level await bloquerait le chargement) ; un test le garde.
6. Rien ne s'ouvre : un module sans `serveur` reste non branché par le serveur ; un module avec clé n'est branché que si l'appelant fournit ses dépendances (`if (d)`, comme avant). Les modules que le serveur ne branche pas aujourd'hui (gel, a-trancher, canaux, journal, reglages, entree, hub, donnees-module) n'ont toujours pas de `serveur`.
7. La garde `[C-536]` (toute route enregistrée dans le code figure dans la liste) et son fichier de test ne changent pas : elle compte toujours les enregistrements dans les sources.
8. Bascule : une PR ouverte qui touchait ces fichiers communs rejoue ses ajouts sous forme de fichiers neufs au `git merge origin/main`. Après les trois T-REG, les fichiers communs d'origine sont figés.

## Options écartées
- Liste générée et committée : encore un fichier commun, et il faut un générateur plus une garde de fraîcheur.
- `import.meta.glob` (Vite) : n'existe que sous Vitest, pas quand Node exécute le code.
- `merge=union` : GitHub l'ignore et, sur du code, l'union produit des doublons silencieux.
- `@fastify/autoload` : nouvelle dépendance (licences, audit) qui change l'encapsulation.
- Garder les fichiers communs et régler les conflits en train : coût mesuré trop élevé.

## Conséquences
- Limite : la découverte se fait par le disque. L'image d'exécution est immuable ; un fichier parasite fait échouer le démarrage et les tests, jamais le comportement.
- Une route neuve = un fichier dans routes/branchements/ (et, après T-REG-2, un dans droits/par-route/) ; une table neuve = un fichier dans db/colonnes/fragments/ (après T-REG-3). Ces fichiers neufs sont autorisés d'office pour les fiches ; la règle est à ajouter aux règles des routines par le chef d'orchestre.
- Restent communs, hors périmètre : packages/contrats/src/c5/invariants.ts (contrat gelé), apps/api/src/db/schema.ts, la liste des routes exemptées, la liste des exemptions des droits, le journal des migrations.
