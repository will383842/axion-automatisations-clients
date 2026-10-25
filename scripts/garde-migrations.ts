import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Garde des migrations (A-233) : aucune migration ne supprime ni ne renomme ni ne change le type de ce qui existe.
// Lecture par un petit analyseur SQL (commentaires imbriqués, chaînes, chaînes E'…', dollars), jamais par expression régulière.
// Le texte des chaînes et des identifiants entre guillemets est ignoré ; le corps d'un bloc $$ … $$ est lu comme du code.
// Le SQL dynamique (EXECUTE) est interdit : sans lui, une chaîne ne peut pas cacher une instruction.

type Mot = { mot: string; ligne: number };

const estLettre = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c > "\u007f";
const estChiffre = (c: string) => c >= "0" && c <= "9";

export function decouper(texte: string): { mots: Mot[]; erreur?: string } {
  const mots: Mot[] = [];
  let i = 0;
  let ligne = 1;
  const avancer = (n: number) => {
    for (let k = 0; k < n; k++) if (texte[i + k] === "\n") ligne++;
    i += n;
  };
  const fin = (message: string, depart: number) => ({ mots, erreur: `${depart}: ${message}` });
  while (i < texte.length) {
    const c = texte[i] ?? "";
    const suivant = texte[i + 1] ?? "";
    if (c === "-" && suivant === "-") {
      while (i < texte.length && texte[i] !== "\n") i++;
    } else if (c === "/" && suivant === "*") {
      const depart = ligne;
      let profondeur = 0;
      do {
        if (texte.startsWith("/*", i)) {
          profondeur++;
          avancer(2);
        } else if (texte.startsWith("*/", i)) {
          profondeur--;
          avancer(2);
        } else avancer(1);
      } while (profondeur > 0 && i < texte.length);
      if (profondeur > 0) return fin("commentaire non fermé", depart);
    } else if (c === "'" || c === '"') {
      // Chaîne E'…' : l'antislash protège le guillemet. Chaîne normale ou identifiant : jamais (standard_conforming_strings).
      const echappe = c === "'" && i > 0 && "eE".includes(texte[i - 1] ?? "") && !estLettre(texte[i - 2] ?? " ") && !estChiffre(texte[i - 2] ?? " ");
      const depart = ligne;
      avancer(1);
      for (;;) {
        if (i >= texte.length) return fin(c === "'" ? "chaîne non fermée" : "identifiant non fermé", depart);
        if (echappe && texte[i] === "\\") avancer(2);
        else if (texte[i] === c && texte[i + 1] === c) avancer(2);
        else if (texte[i] === c) break;
        else avancer(1);
      }
      avancer(1);
    } else if (c === "$" && i > 0 && (estLettre(texte[i - 1] ?? "") || estChiffre(texte[i - 1] ?? ""))) {
      avancer(1);
    } else if (c === "$") {
      let j = i + 1;
      while (j < texte.length && (estLettre(texte[j] ?? "") || (j > i + 1 && estChiffre(texte[j] ?? "")))) j++;
      if (texte[j] === "$") {
        // Ouverture d'un bloc : l'étiquette est sautée, le corps reste lu comme du code jusqu'à la même étiquette.
        const etiquette = texte.slice(i, j + 1);
        avancer(etiquette.length);
        const reste = texte.indexOf(etiquette, i);
        if (reste < 0) return fin("bloc $ non fermé", ligne);
        const corps = decouper(texte.slice(i, reste));
        mots.push(...corps.mots.map((m) => ({ mot: m.mot, ligne: m.ligne + ligne - 1 })));
        if (corps.erreur) return { mots, erreur: corps.erreur };
        avancer(reste - i + etiquette.length);
      } else avancer(1);
    } else if (estLettre(c)) {
      let j = i;
      while (j < texte.length && (estLettre(texte[j] ?? "") || estChiffre(texte[j] ?? "") || texte[j] === "$")) j++;
      mots.push({ mot: texte.slice(i, j).toLowerCase(), ligne });
      i = j;
    } else avancer(1);
  }
  return { mots };
}

const INTERDITS = new Map([["drop", "DROP"], ["rename", "RENAME"], ["truncate", "TRUNCATE"], ["execute", "EXECUTE"]]);

export function analyserSql(nom: string, texte: string): string[] {
  const { mots, erreur } = decouper(texte);
  const erreurs: string[] = [];
  mots.forEach((m, k) => {
    const interdit = INTERDITS.get(m.mot);
    if (interdit) erreurs.push(`${nom}:${m.ligne}: instruction interdite : ${interdit}`);
    else if (m.mot === "type") {
      // « ALTER [COLUMN] x TYPE », « ALTER … SET DATA TYPE » ; « ADD COLUMN type text » et « CREATE TYPE » restent permis.
      const [m1, m2, m3] = [1, 2, 3].map((d) => mots[k - d]?.mot);
      if (m1 === "data" || m2 === "alter" || (m3 === "alter" && m2 === "column")) {
        erreurs.push(`${nom}:${m.ligne}: instruction interdite : ALTER … TYPE`);
      }
    }
  });
  if (erreur) erreurs.push(`${nom}:${erreur}`);
  return erreurs;
}

function fichiersSql(dossier: string): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (lstatSync(chemin).isSymbolicLink()) throw new Error(`${chemin}: lien symbolique interdit dans un dossier de migrations`);
    if (e.isDirectory()) return fichiersSql(chemin);
    return e.name.toLowerCase().endsWith(".sql") ? [chemin] : [];
  });
}

export function gardeMigrations(racine: string): string[] {
  const apps = join(racine, "apps");
  return readdirSync(apps, { withFileTypes: true })
    .filter((a) => a.isDirectory())
    .flatMap((a) => {
      try {
        return fichiersSql(join(apps, a.name, "drizzle"));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return [];
        return [`${a.name}/drizzle: ${(e as Error).message}`];
      }
    })
    .flatMap((f) => (f.includes(": ") ? [f] : analyserSql(relative(racine, f), readFileSync(f, "utf8"))));
}

// Usage : node scripts/garde-migrations.ts [racine]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const erreurs = gardeMigrations(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
