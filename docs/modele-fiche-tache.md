# Modèle de fiche de tâche

Les vraies fiches vivent dans le dépôt privé (`taches/<lot>/`) ; la routine reçoit sa fiche copiée dans son texte de lancement (voir ADR 0006). Ce modèle donne seulement la forme.

# T<lot>-<nn> · Titre

| Dépôt | Branche | Agent | Modèle | Risque | Dépend de | Durée | Coût estimé |
|---|---|---|---|---|---|---|---|
| PUBLIC | `lot-<n>/T<lot>-<nn>` | | | | | | |

## But
Une ou deux phrases.

## Exigences
Numéros des exigences couvertes.

## Fichiers autorisés
Liste exacte. Rien d'autre.

## Choix fixés
Ce qu'il ne faut pas changer sans ADR.

## Tests à écrire d'abord
Nom, numéro d'exigence entre crochets, ce qu'il vérifie. Rouge avant le code.

## Critère de fin
Ce qui doit être vrai pour que la PR soit verte.

## Pièges
Erreurs déjà rencontrées.

## Interdits
Aucun secret, aucun nom de vrai client, aucun prix, aucun extrait du cahier, ni adresse IP ni nom d'hôte interne.
