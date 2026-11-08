# 0127 · Sentry : SDK, région européenne, aucune intégration automatique

Date : 07/11/2026 · Statut : accepté (accord de l'architecte, 08/11/2026 ; proposé par T5-13b-2) · Contrat touché : aucun · Migration : aucune · S'appuie sur : fiche T5-13, exigences A-113, A-065, C-025

## Contexte
- Les erreurs des trois applications (API, exécuteur, console) doivent arriver à Sentry sans donnée de client, sans secret et sans sortir de l'Union européenne.
- La garde des licences n'admet dans l'exécuteur livré que six licences. Les SDK complets `@sentry/node` et `@sentry/nextjs` tirent en production des paquets sous FSL et BlueOak : ils font rougir la garde.

## Décision
1. SDK : `@sentry/core` seul, en version exacte (MIT ; une seule dépendance, MIT elle aussi). Aucun autre paquet `@sentry/*` (test `[A-065]`).
2. Client : `ServerRuntimeClient` avec `integrations: []`, `maxBreadcrumbs: 0`, `traceLifecycle: "static"`, `sendDefaultPii: false`, aucun nom de serveur. Sans `traceLifecycle: "static"`, le SDK ignore `beforeSendTransaction` et ajoute une intégration d'envoi des spans : l'option est donc obligatoire.
3. Nettoyage dans le processus, avant le transport : `beforeSend` (liste fermée de champs), `beforeSendTransaction` et `beforeSendSpan` rendent null. Le masqueur des secrets réellement lus passe avant les motifs.
4. Transport : `fetch` natif injectable, abandon à 2 s, aucune file sur disque, aucune relance. Une enveloppe refusée ou perdue est abandonnée.
5. Région : l'hôte du DSN est `de.sentry.io` ou se termine par `.de.sentry.io`. Sinon, ou sans DSN, le démarrage est refusé avec un message pour l'équipe. Aucun drapeau de contournement ; les essais remplacent le `fetch`, jamais le DSN.
6. Navigateur : rien en 13b. Une capture côté navigateur exposerait un DSN public, toucherait la CSP et tirerait la relecture de session.
7. Démarrage : chaque application expose un module `instrumentation.ts`. Celui de la console est appelé par Next (`register`, `onRequestError`, moteur nodejs seulement). Ceux de l'API et de l'exécuteur ne sont pas encore appelés : le câblage reste porté par les fiches de câblage existantes.
8. Variables : `SENTRY_DSN`, `SENTRY_ECHANTILLONNAGE`, `SENTRY_CELLULE` (inventaire des secrets). Sans `SENTRY_DSN`, la console démarre sans signalement (interrupteur fermé par défaut) ; avec un DSN hors région, elle refuse de démarrer.

## Options écartées
- `@sentry/node` ou `@sentry/nextjs` : licences FSL et BlueOak refusées par la garde ; une exception demanderait de modifier la garde, interdit aux routines.
- Intégrations par défaut du SDK : fil d'Ariane HTTP, console et contexte du système peuvent porter des adresses, des jetons ou un nom d'hôte.
- Capture côté navigateur : voir la décision 6.

## Conséquences
- Limite (règle 9.4) : le masquage par motifs n'est pas exhaustif par nature ; le rempart est la liste fermée de champs, la borne de 500 caractères et le masqueur injecté.
- Dettes : câblage de l'API et de l'exécuteur, capture côté navigateur, compte Sentry européen et sous-traitance (lot 8a).
