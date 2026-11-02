# reglages-heritage

La fonction unique d'héritage des valeurs (B-515, A-160), sans base de données.

- Niveaux, du plus général au plus précis : `global` → `automatisation` → `metier` → `client` → `instance`. Liste unique, la même pour l'API (plan commercial, T2-08) et les réglages des modules (T4-30).
- `resoudre(cle, niveaux)` rend `{ valeur, source, version, imposee, origine }`, ou `null` si aucun niveau n'a la clé. Un `null` posé à un niveau est une valeur, pas une absence.
- `verifierEcriture(cle, niveau, niveaux)` refuse d'écrire sous une valeur `imposee`.
- Ne jamais écrire une seconde fonction d'héritage : réexporter celle-ci.
