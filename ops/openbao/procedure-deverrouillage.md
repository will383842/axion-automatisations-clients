# Procédure de déverrouillage d'OpenBao (C-523)

OpenBao démarre toujours scellé : après un redémarrage, une panne ou une mise à jour, il faut le rouvrir à la main.

## Quand
Le coffre répond « scellé » (`bao status`) ou l'API signale `coffre_scelle`.

## Ce que fait l'API pendant le scellement
Elle répond `coffre_scelle`, suspend les envois et refuse toute lecture de secret. Rien n'est perdu : tout reprend dès que le coffre est ouvert.

## Qui détient les parts
Le secret est coupé en 5 parts ; il en faut 3 parts sur 5. Les parts se répartissent par RÔLE, jamais par nom :
- le responsable du produit ;
- une personne de confiance désignée ;
- une copie hors ligne (support chiffré rangé à part) ;
- les deux autres rôles sont tenus par le gestionnaire de mots de passe de l'équipe.

Une part n'est JAMAIS dans un dépôt, ni sur le serveur du coffre, ni dans un message, ni dans l'historique d'un terminal. Les parts ne sont jamais rangées avec l'instantané de secours.

## Geste
1. Réunir 3 détenteurs (ou leurs copies).
2. Lancer `bash ops/openbao/deverrouiller.sh` ; coller ou saisir une part par ligne (saisie masquée, rien d'affiché).
3. Lire la réponse : « déverrouillé », ou « encore scellé, n parts reçues sur 3 ». Si le coffre reste scellé, une part est fausse : reprendre avec une autre part.
4. Vérifier que l'API ne répond plus `coffre_scelle`.

## Essai chronométré
Chaque trimestre, refaire l'exercice sur un coffre d'essai, noter la durée et la date dans le dossier de reprise. Un essai raté se corrige avant la fin du mois.

## Perte de parts
Avec moins de 3 parts valides, le coffre est perdu : restaurer l'instantané dans un OpenBao neuf demande aussi 3 parts (voir `sauvegarde-de-secours.md`). Remplacer un détenteur qui part : régénérer les parts (`bao operator rekey`) le jour même.
