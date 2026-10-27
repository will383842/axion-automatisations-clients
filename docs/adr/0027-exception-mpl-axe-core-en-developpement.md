# 0027 · axe-core sous MPL-2.0, en développement seulement

Date : 26/10/2026 · Statut : accepté (routine T0-19, à confirmer par l'architecte)

## Contexte
La fiche T0-19 demande un contrôle d'accessibilité WCAG 2.2 AA sur les 3 pages de la galerie. Le seul moteur reconnu pour cela est `axe-core` (MPL-2.0), avec son lien Playwright `@axe-core/playwright` (MPL-2.0). La garde des licences ne permet MPL-2.0 que dans `apps/api`, `apps/console` et `apps/portail`.

## Décision
`axe-core` et `@axe-core/playwright` rejoignent la liste des exceptions NOMMÉES de développement de `scripts/garde-licences.ts` (ADR 0007). Ils ne servent qu'aux tests visuels de `packages/design` ; ils ne sont jamais livrés, ni chez un client, ni en production. S'ils devenaient une dépendance de production, la garde les refuserait.

## Conséquences
- Aucun fichier de `packages/design/src` n'importe ces paquets.
- Toute autre licence MPL-2.0 reste refusée hors des trois applications.

## Ajout : liste blanche des workflows
Le workflow `visuel-design.yml` tourne dans l'image Playwright épinglée par empreinte (les captures dépendent du système). La liste blanche de `scripts/garde-licences.ts` reçoit donc, en forme exacte : ce seul conteneur, la variable `MISE_A_JOUR`, la commande de test (par empreinte) et un second réglage de `actions/upload-artifact` (artefact `captures-reference`, produit à la main). Les droits restent en lecture seule.
