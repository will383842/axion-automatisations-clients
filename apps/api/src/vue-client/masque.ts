import { COLONNES_CHIFFREES, type Requete } from "../donnees/requetes/liste.js";

// Colonnes masquées pendant la vue (B-068) : liste FERMÉE = colonnes chiffrées du modèle (T2-33) + la clé de stockage d'un fichier (chemin de téléchargement).
// Contrôle STATIQUE sur la déclaration, avant tout accès à la base : aucun oracle par la valeur, le message ou le temps.
// Limite écrite (règle 9.4) : la garde est une liste de noms ; une colonne sensible ajoutée au modèle doit y être ajoutée (dette de contrôle de contenu, preuves).
export const MASQUE_VUE: ReadonlySet<string> = new Set(["commun.index_fichiers.cle_objet", ...COLONNES_CHIFFREES]);

const masquee = (table: string, colonne: string) => MASQUE_VUE.has(`${table}.${colonne}`) || MASQUE_VUE.has(colonne);
type Filtres = { colonne: string }[] | undefined;

function formePermise(f: Requete["forme"]): boolean {
  const filtresOk = (table: string, filtres: Filtres) => (filtres ?? []).every((x) => !masquee(table, x.colonne));
  if (f.type === "composee") {
    return f.parties.every((p) => ("colonne" in p.agregat ? !masquee(p.table, p.agregat.colonne) : true) && filtresOk(p.table, p.filtres));
  }
  const rendues = "lignes" in f.sortie ? f.sortie.lignes.map((l) => l.colonne) : f.sortie.agregats.flatMap((a) => ("colonne" in a ? [a.colonne] : []));
  return rendues.every((c) => !masquee(f.table, c)) && filtresOk(f.table, f.filtres) && (f.tri ?? []).every((x) => !masquee(f.table, x.colonne));
}

// Vrai si la requête déclarée ne cite aucune colonne masquée, ni en sortie, ni en filtre, ni en tri, ni en agrégat, ni dans une partie ou une variante.
export function permiseEnVue(r: Requete): boolean {
  return [r.forme, ...(r.variantes ?? []).map((v) => v.forme)].every(formePermise);
}
