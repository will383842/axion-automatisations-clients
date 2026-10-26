# 0021 · nodemailer en production et curseur de la famille messagerie

Date : 26/10/2026 · Statut : accepté par l'architecte (délégué par will383842)

## Contexte
1. Le connecteur IMAP/SMTP (T4-12) envoie par `nodemailer` à l'exécution. L'ADR 0008 limite l'exception MIT-0 à une dépendance de développement ; classer le paquet en développement contournait la garde et cassait le chargement du connecteur en installation de production.
2. Sur la dernière page de `listerNouveaux`, le contrat de la famille impose `suivant = null`. Le tour suivant repart donc de `null` et relit toute la boîte `INBOX`, alors que la fiche veut un curseur `UIDVALIDITY:UID` du dernier message vu.

## Décision
1. `nodemailer` (10.2.1, licence MIT-0) passe en `dependencies` du connecteur. `scripts/garde-licences.ts` reçoit une seconde exception NOMMÉE de production (paquet `nodemailer` + licence `MIT-0`, comparaison exacte), sur le modèle de l'ADR 0011. Toute autre dépendance en MIT-0 reste refusée, en développement comme en production. Cet ADR complète l'ADR 0008, qui reste valable pour `packages/harnais`.
2. Curseur : NON tranché ici, car cela change le contrat de famille (`packages/contrats` fait foi). Décision de l'architecte : on garde la relecture de `INBOX` quand `curseur` vaut `null` ; la mémorisation du curseur par le moteur reste une évolution possible. Proposition étudiée : le contrat de la famille garde `suivant` vide à la fin, mais le moteur mémorise le dernier curseur rendu et le repasse au tour suivant. Le connecteur relit `INBOX` depuis le début quand `curseur` vaut `null`.

## Conséquences
- Le test de la garde prouve que `nodemailer` passe en production et qu'un autre paquet en MIT-0 est refusé.
- Le réglage TLS des essais n'accepte qu'une autorité de test (`ca`) ; couper la vérification n'est possible qu'avec `NODE_ENV=test`.
- Une coupure après le début de `DATA` est classée « définitive » (`envoi_incertain`), alors qu'une coupure avant (`MAIL FROM`, `RCPT TO`) reste passagère ; le début de `DATA` est repéré par l'entrée « message » du journal de nodemailer : le message a pu partir, on ne le renvoie pas.
- L'export `suite` ajouté au `package.json` de `connecteurs-commun` est accepté.
