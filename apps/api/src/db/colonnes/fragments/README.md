# Fragments de colonnes

Un fichier par fiche qui crée une table : `t<n>-<fiche>.ts` (par exemple `t5-04a.ts`). Tout autre fichier fait échouer le chargement ; `README.md` est le seul toléré.

```ts
import type { FragmentColonnes } from "../registre.ts";

export default {
  fiche: "t5-04a", // le nom du fichier, sans l'extension
  tables: ["occurrences_alertes", "clotures_alertes"],
  communes: [], // sous-ensemble de tables, sans tenant_id
  textes: { "clotures_alertes.raison": 64 }, // colonnes de texte, borne de 1 à 4000
} satisfies FragmentColonnes;
```

Les tests propres à une migration (additive, RLS, journal) vont dans un fichier de test NEUF de la fiche, jamais dans `garde-colonnes.test.ts` (figé).
