import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { couleursDe, estBleu } from "../packages/design/src/jetons.ts";

// Garde des couleurs (C-595, C-597) : aucune couleur littérale hors de jetons.ts, aucun bandeau d'annotation dans le code.
// Hors garde : packages/design/src/jetons.ts et jetons.css (un test vérifie qu'il égale sa génération), tests, fixtures, node_modules.
// jetons.ts reste soumis au refus du bleu (C-597), sous toutes les formes de couleur.

const EXTENSIONS = /\.(?:[cm]?[jt]sx?|css|html|svg|vue|svelte|mdx?)$/;
const IGNORE = /(?:^|\/)(?:node_modules|dist|coverage|__fixtures__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|^packages\/design\/src\/jetons\.(?:ts|css)$/;
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/;
const FONCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const NOMS = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
  "darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
  "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
  "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
  "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown",
  "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
  "yellow", "yellowgreen",
];
const NOM = new RegExp(`(?<![\\w-])(?:${NOMS.join("|")})(?![\\w-])`, "i");
const PROPRIETE_COULEUR = /(?:color|background|border|fill|stroke|outline|shadow|gradient)\s*[:=]/i;
const NOM_SEUL = new RegExp(`["'\`](?:${NOMS.join("|")})["'\`]`, "i");
const TAILWIND = /(?<![\w-])(?:bg|text|border|fill|stroke|ring|outline|from|via|to|decoration|shadow|divide|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?![\w-])/;
const ANNOTATION = /POUR VOUS|POUR VOS CLIENTS/;

export function analyserFichier(nom: string, texte: string): string[] {
  const erreurs: string[] = [];
  texte.split("\n").forEach((ligne, i) => {
    const echec = (msg: string) => erreurs.push(`${nom}:${i + 1}: ${msg}`);
    if (HEX.test(ligne) || FONCTION.test(ligne)) echec("couleur littérale hors jetons (C-595) : utiliser un jeton");
    else if ((PROPRIETE_COULEUR.test(ligne) && NOM.test(ligne.replace(/var\([^)]*\)/g, ""))) || NOM_SEUL.test(ligne)) {
      echec("nom de couleur CSS hors jetons (C-595) : utiliser un jeton");
    }
    if (TAILWIND.test(ligne)) echec("classe de la palette par défaut de Tailwind (C-597) : utiliser un jeton");
    if (ANNOTATION.test(ligne)) echec("bandeau d'annotation interdit dans le code (« POUR VOUS », « POUR VOS CLIENTS »)");
  });
  return erreurs;
}

function fichiers(dossier: string, racine: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    const rel = relative(racine, chemin).split("\\").join("/") + (e.isDirectory() ? "/" : "");
    if (IGNORE.test(rel)) return [];
    if (e.isDirectory()) return fichiers(chemin, racine);
    return EXTENSIONS.test(e.name) ? [chemin] : [];
  });
}

const JETONS = "packages/design/src/jetons.ts";

function lire(action: () => string[]): string[] {
  try {
    return action();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export function verifierArbre(racine: string): string[] {
  const bleus = lire(() =>
    couleursDe(readFileSync(join(racine, JETONS), "utf8"))
      .filter(estBleu)
      .map((c) => `${JETONS}: bleu interdit (C-597) : ${c}`),
  );
  const fichiersTrouves = ["apps", "packages"].flatMap((d) =>
    lire(() =>
      fichiers(join(racine, d), racine).flatMap((f) =>
        analyserFichier(relative(racine, f).split("\\").join("/"), readFileSync(f, "utf8")),
      ),
    ),
  );
  return [...bleus, ...fichiersTrouves];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = verifierArbre(fileURLToPath(new URL("../", import.meta.url)));
  erreurs.forEach((e) => console.error(e));
  if (erreurs.length) process.exit(1);
  console.log("garde-couleurs : aucune couleur hors jetons");
}
