# Vérification PHP du contrat C3 (CRM)

La suite PHP du CRM (lot 2-ter) vérifie les mêmes fixtures que la console, octet pour octet.

1. Copier `fixtures/c3/` de ce dépôt, telle quelle (aucune réécriture, aucun changement de fin de ligne), dans le dépôt du CRM.
2. Copier aussi `empreintes/c3.sha256`.
3. Comparer les empreintes, depuis la racine de la copie :

```sh
sha256sum --check --strict empreintes/c3.sha256
```

La commande doit afficher `OK` pour chaque fichier. Un seul écart (fixture modifiée d'un seul côté) la fait échouer : c'est le test de contrat.

4. Les cas `valide: true` doivent être acceptés par le CRM, les cas `valide: false` refusés. La signature de chaque cas se recalcule avec la chaîne `v1\n<horodatage>\n<MÉTHODE>\n<chemin + requête>\n<sha256 du corps>` et le secret de test du cas (préfixe `TEST-NE-PAS-UTILISER-`).
5. Le CRM ne lit jamais `foreign_id` ni `external_ref` pour ce canal.
