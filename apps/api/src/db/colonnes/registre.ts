import { readdirSync } from "node:fs";
import { TABLES_CLI_SOCLE, TABLES_SOCLE } from "./socle.ts";

// Registre des colonnes par fiche (T-REG-3, ADR 0139) : un fichier fragments/<fiche>.ts par fiche qui crée une table. Le chargement échoue (échec fermé) sur tout fichier hors forme, jamais ignoré.
export type FragmentColonnes = {
  fiche: string;
  tables: string[];
  communes?: string[];
  cli?: string[];
  textes: Record<string, number>;
};
export type Fusion = { fragments: readonly FragmentColonnes[]; tables: readonly string[]; cli: readonly string[]; communes: readonly string[] };

const NOM = /^t[0-9a-z]+-[0-9a-z-]+\.(?:ts|js)$/;
const BORNE_MAX = 4000;
const listeDeNoms = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

export function fusionnerFragments(entrees: { nom: string; module: unknown }[]): Fusion {
  const tables: string[] = [];
  const cli: string[] = [];
  const communes: string[] = [];
  const fragments: FragmentColonnes[] = [];
  for (const { nom, module } of [...entrees].sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0))) {
    if (!NOM.test(nom)) throw new Error(`fragment de colonnes : nom « ${nom} » hors de la forme t<n>-<fiche>.ts`);
    const f = (module as { default?: Partial<FragmentColonnes> } | undefined)?.default;
    const forme = f !== undefined && f !== null && typeof f === "object" && typeof f.fiche === "string" && listeDeNoms(f.tables) && (f.communes === undefined || listeDeNoms(f.communes)) && (f.cli === undefined || listeDeNoms(f.cli)) && f.textes !== null && typeof f.textes === "object" && !Array.isArray(f.textes);
    if (!forme) throw new Error(`fragment de colonnes ${nom} : forme de l'export invalide`);
    const frag = f as FragmentColonnes;
    if (frag.fiche !== nom.replace(/\.(?:ts|js)$/, "")) throw new Error(`fragment de colonnes ${nom} : la fiche « ${frag.fiche} » ne porte pas le nom du fichier`);
    for (const [liste, deja, socle, ou] of [
      [frag.tables, tables, TABLES_SOCLE, "console"],
      [frag.cli ?? [], cli, TABLES_CLI_SOCLE, "schema-cli"],
    ] as const) {
      for (const t of liste) {
        if (socle.includes(t)) throw new Error(`fragment ${nom} : la table ${ou} ${t} appartient au socle figé`);
        if (deja.includes(t)) throw new Error(`fragment ${nom} : la table ${ou} ${t} est revendiquée deux fois`);
        deja.push(t);
      }
    }
    for (const c of frag.communes ?? []) {
      if (!frag.tables.includes(c)) throw new Error(`fragment ${nom} : la table commune ${c} n'est pas dans ses tables (communes)`);
      communes.push(c);
    }
    for (const [cle, valeur] of Object.entries(frag.textes)) {
      const table = cle.split(".")[0] ?? "";
      if (!frag.tables.includes(table) && !(frag.cli ?? []).includes(table)) throw new Error(`fragment ${nom} : la colonne ${cle} n'est pas dans une table du fragment`);
      if (typeof valeur !== "number" || !Number.isInteger(valeur) || valeur < 1 || valeur > BORNE_MAX) throw new Error(`fragment ${nom} : borne de ${cle} hors de 1 à ${BORNE_MAX}`);
    }
    fragments.push(frag);
  }
  return Object.freeze({ fragments: Object.freeze(fragments), tables: Object.freeze(tables), cli: Object.freeze(cli), communes: Object.freeze(communes) });
}

const DOSSIER = new URL("./fragments/", import.meta.url);
// README.md est le seul fichier toléré hors de la forme.
export const FRAGMENTS = fusionnerFragments(await Promise.all(readdirSync(DOSSIER).filter((n) => n !== "README.md").sort().map(async (nom) => ({ nom, module: NOM.test(nom) ? await import(new URL(nom, DOSSIER).href) : undefined }))));
