# 0026 · Briques communes de prospection conforme dans le SDK

Date : 26/10/2026 · Statut : proposé

## Contexte
Un module de prospection ne doit pas pouvoir envoyer un message non conforme. Les règles vivent dans le SDK (`packages/sdk-module/src/prospection`), pas recopiées dans chaque module. Ce sont des briques réutilisables, pas une automatisation.

## Décision
- `messageDeProspection` refuse un message sans raison sociale, sans adresse d'expéditeur, sans fonction du destinataire ou sans motif de lien, et produit les en-têtes de désinscription en un clic (adresse `mailto:` et URL HTTPS, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`).
- Une opposition met le contact à l'écart des envois : la donnée est gardée, l'interface de la liste d'exclusion n'offre aucune suppression. `verifierEnvoi` refuse tout message vers un contact exclu.
- `sourcesDeclarees` refuse un module sans source et toute source LinkedIn (nom ou domaine).
- `planifierInformations` : les informations dues au premier contact partent avec le premier message, sinon au plus tard 30 jours après l'obtention de la donnée.
- Les textes fixes sont injectés depuis le catalogue de messages (à relire par le juriste) ; le SDK n'en écrit aucun.

## Question ouverte (non tranchée)
La portée de la liste d'exclusion entre clients (par client ou partagée) n'est pas décidée. Les briques ne la fixent pas : la liste est celle du périmètre que l'appelant choisit. À trancher avant le contrôle à l'import (T4-37) et l'adresse de désinscription du portail (lot 6).

## Conséquences
- Il reste à brancher la rubrique `sources` dans le manifeste (fichier hors fiche T4-14) et à ajouter les clés du catalogue.
