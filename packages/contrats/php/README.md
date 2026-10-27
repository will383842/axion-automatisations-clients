# Vérification des contrats dans l'autre dépôt (CRM en PHP, axion-ia)

La suite PHP du CRM (lot 2-ter) vérifie les mêmes fixtures que la console, octet pour octet. axion-ia (Hub, lot 2-bis) fait de même pour C1, C2 et C6.

1. Copier, tels quels (aucune réécriture, aucun changement de fin de ligne), les dossiers de fixtures utiles et leurs empreintes :

| Dépôt | Fixtures | Empreintes |
|---|---|---|
| CRM | `fixtures/c3/`, `fixtures/commun/` | `empreintes/c3.sha256`, `empreintes/commun.sha256` |
| axion-ia | `fixtures/c1/`, `fixtures/c2/`, `fixtures/c6/`, `fixtures/commun/` | `empreintes/c1.sha256`, `empreintes/c2.sha256`, `empreintes/c6.sha256`, `empreintes/commun.sha256` |

`fixtures/commun/` est toujours copié : il porte la chaîne signée, les codes d'erreur, l'anti-rejeu, les limites et la liste des règles de fond (`reglesFond`) que les points 6 et 7 appliquent. Copier aussi `contrats.sha256` (sommaire, avec `VERSION`) : sa ligne `VERSION` dit quelle version a été copiée.
2. Comparer les empreintes, depuis la racine de la copie, une commande par fichier d'empreintes copié :

```sh
sha256sum --check --strict empreintes/c3.sha256 empreintes/commun.sha256
```

La commande doit afficher `OK` pour chaque fichier. Un seul écart (fixture modifiée d'un seul côté) la fait échouer : c'est le test de contrat.

3. Les cas `valide: true` doivent être acceptés par le CRM, les cas `valide: false` refusés. La signature de chaque cas se recalcule avec la chaîne `v1\n<horodatage>\n<MÉTHODE>\n<chemin + requête>\n<sha256 du corps>` et le secret de test du cas (préfixe `TEST-NE-PAS-UTILISER-`).
4. Le CRM ne lit jamais `foreign_id` ni `external_ref` pour ce canal.
5. Le JSON Schema (`fixtures/c3/json-schema.json`) refuse tout champ inconnu ; le mot-clé `x-axion-regles` y nomme les règles qu'il ne sait pas dire (ici `siren_luhn` : clé de Luhn du SIREN), que le CRM applique aussi (liste : `fixtures/commun/constantes.json`, clé `reglesFond` ; comment : `README.md`, « Règles de forme et de fond »).
6. Chaque requête est vérifiée avec la clé choisie par `X-Axion-Cle`, puis l'anti-rejeu (couple clé et signature gardé 600 s, 401 `rejeu`). Les événements se dédoublonnent par `event_id`. Un émetteur re-signe chaque essai avec un horodatage strictement plus récent que l'essai précédent (`horodatageSuivant`), jamais la même signature : une reprise après coupure n'est pas un rejeu.
7. Depuis le gel 1.0.0, `fixtures-gelees/1.0.0/` garde les fixtures de C1, C2, C3, C6 et commun : un exemple valide de 1.0.0 doit rester accepté par toute 1.x.
