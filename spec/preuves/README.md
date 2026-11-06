# Preuves et dettes : un fichier par fiche

Toute nouvelle ligne de preuve ou de dette va dans un fichier NEUF : `spec/preuves/<branche-assainie>.md`
(ex. branche `lot-0/preuves-par-fiche` → `spec/preuves/lot-0-preuves-par-fiche.md` ; minuscules, tout autre caractère que `a-z0-9` devient un tiret).

- Même format qu'avant : une ligne `<numéro> → <preuve>, <date>` par exigence ou dette.
- Une PR n'édite jamais le fichier d'une autre PR ni `spec/preuves.md` (historique figé, lecture seule par convention).
- Compléter une preuve existante : ligne `<numéro> (suite) → …` dans son propre fichier. Une seconde ligne `<numéro> → …` est un doublon, refusé par `couverture-req`.
- Les outils lisent l'agrégat (`scripts/agreger-preuves.ts`) : historique puis fichiers dans l'ordre des noms. Ce README n'en fait pas partie.

Décision : ADR 0029, section « Mise à jour du 05/11/2026 ».
