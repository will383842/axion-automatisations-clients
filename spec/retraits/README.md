# Retraits de tests déclarés

Un fichier par fiche : `spec/retraits/<id-fiche>.json`, ajouté par la PR qui fait baisser le nombre de tests d'un fichier (ADR 0019).

```json
{ "fichier": "scripts/exemple.test.ts", "avant": 5, "apres": 3, "raison": "deux cas fusionnés dans un tableau" }
```

- `avant` et `apres` doivent égaler le nombre mesuré par la CI (base puis PR) ; un fichier supprimé ou renommé s'écrit `apres: 0`.
- Seul un fichier AJOUTÉ par la PR compte : une ancienne déclaration ne sert jamais une seconde fois.
- Le `gardien-spec` relit la raison comme une preuve.
