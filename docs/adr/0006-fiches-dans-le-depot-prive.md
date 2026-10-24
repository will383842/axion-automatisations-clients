# 0006 · Les fiches de tâches vivent dans le dépôt privé

Date : 24/10/2026 · Statut : accepté

## Contexte
Les fiches de tâches citent le cahier des charges et des éléments commerciaux qui ne doivent pas être publics. Ce dépôt est public.

## Décision
Les fiches vivent dans le dépôt privé (`taches/<lot>/`). La routine reçoit sa fiche copiée dans son texte de lancement et lit seulement cette fiche, `CLAUDE.md` et les fichiers cités. Ce dépôt ne garde que le modèle (`docs/modele-fiche-tache.md`).

## Conséquences
- Aucune fiche, aucun extrait du cahier ici.
- Une routine ne dépend pas d'un accès au dépôt privé pour travailler ; elle reçoit tout ce qu'il lui faut.
- Les numéros d'exigences seuls sont publics (`spec/req-ids.json`).
