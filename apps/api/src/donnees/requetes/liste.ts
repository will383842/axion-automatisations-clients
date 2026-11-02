import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import { premieresRequetes } from "./premieres.js";

// Liste blanche des requêtes du service des données (A-170, B-172). Une requête = un nom, un schéma de ses paramètres (les clés en trop sont écartées, jamais lues),
// un SQL paramétré écrit ici et nulle part ailleurs, un mode, les colonnes rendues (aucune colonne chiffrée : le déchiffrement explicite est celui de T2-33) et le filtre d'établissement.
// `{{filtre}}` est l'emplacement du filtre : le service le remplace par « etablissement_id = ANY($n::uuid[]) » à partir de la SESSION, jamais d'un paramètre (B-173).
export const EMPLACEMENT_FILTRE = "{{filtre}}";

export interface Requete {
  nom: string;
  schema: ZodType<unknown>;
  sql: string;
  mode: "lecture" | "ecriture";
  // Vrai : rien que des comptes ou des tailles, seule chose que l'équipe lit sans vue « comme le client » (B-070, C-006).
  metadonnees: boolean;
  parEtablissement: boolean;
  colonnes: readonly string[];
  valeurs(parametres: never): unknown[];
}

const NOM = /^[a-z][A-Za-z0-9]{0,63}$/;
// Liste FERMÉE des colonnes chiffrées, lue dans le modèle des bases clients (migrations drizzle-cli) : toute colonne binaire (bytea), tout nom en _chiffre ou _empreinte,
// et « empreinte ». Une colonne ajoutée au modèle entre donc d'elle-même dans la liste ; sans modèle lisible, le module refuse de se charger (jamais de liste vide).
function colonnesChiffreesDuModele(): ReadonlySet<string> {
  const dossier = fileURLToPath(new URL("../../../drizzle-cli/", import.meta.url));
  const fichiers = readdirSync(dossier).filter((f) => f.endsWith(".sql"));
  if (fichiers.length === 0) throw new Error("modèle des bases clients introuvable");
  const noms = new Set<string>(["empreinte"]);
  for (const f of fichiers) {
    const texte = readFileSync(`${dossier}${f}`, "utf8");
    for (const m of texte.matchAll(/^\s*"([a-z_0-9]+)"\s+"?(\w+)"?/gm)) {
      const [, nom = "", type = ""] = m;
      if (type.toLowerCase() === "bytea" || /(_chiffre|_empreinte)$/.test(nom) || nom === "empreinte") noms.add(nom);
    }
  }
  return noms;
}
export const COLONNES_CHIFFREES: ReadonlySet<string> = colonnesChiffreesDuModele();
const mot = (nom: string) => new RegExp(`(?<![A-Za-z0-9_])"?${nom}"?(?![A-Za-z0-9_])`, "i");

// Analyse stricte (liste blanche de formes) d'une requête filtrée par établissement (B-173). Le texte est découpé en jetons (chaînes et identifiants entre guillemets = un jeton opaque),
// puis : un seul SELECT de premier niveau ; aucun mot de la liste noire (IS, NOT, OR, UNION…) ; {{filtre}} seulement comme conjonct AND de premier niveau d'un WHERE,
// suivi de AND, ORDER BY, LIMIT ou de la fin. Seule exception : une sous-requête de PROJECTION « (SELECT … WHERE {{filtre}} …) » d'un SELECT sans FROM, jamais ailleurs.
const MOTS_REFUSES = new Set(["IS", "NOT", "OR", "UNION", "INTERSECT", "EXCEPT", "EXISTS", "BETWEEN", "CASE", "WITH", "INTO", "FOR", "VALUES", "LATERAL", "DISTINCT_FROM", "UPDATE", "DELETE", "INSERT", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "COPY", "CALL", "DO", "SET"]);
// Dans un FROM : un seul nom de table (alias permis), jamais de jointure, de virgule ni de table dérivée (le filtre ne porterait alors que sur une des tables).
const MOTS_JOINTURE = new Set(["JOIN", "CROSS", "NATURAL", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "ON", "USING", "TABLESAMPLE", "ROWS"]);
const CLAUSES = new Set(["FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "WINDOW", "FETCH"]);
function jetons(cle: string, sql: string): string[] {
  const texte = sql;
  if (/--|\/\*|;|\\|\$(?!\d)/.test(texte.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, " "))) throw new Error(`commentaire, point-virgule ou syntaxe interdite : ${cle}`);
  const res: string[] = [];
  for (const m of texte.matchAll(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\{\{filtre\}\}|\$\d+|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|::|<>|<=|>=|\S/g)) res.push(m[0]);
  return res;
}
function validerFormeFiltree(cle: string, sql: string): void {
  const t = jetons(cle, sql);
  const mot = (j: string | undefined) => (j !== undefined && /^[A-Za-z_]/.test(j) ? j.toUpperCase() : "");
  if (mot(t[0]) !== "SELECT") throw new Error(`requête filtrée : seul un SELECT simple est permis : ${cle}`);
  // Chaque niveau de parenthèses a sa pile : dernier mot-clé de clause vu, et SELECT déjà ouvert ?
  type Niveau = { selectEstSousRequete: boolean; projection?: boolean; clause: string; fromVu: boolean; filtre?: boolean };
  const pile: Niveau[] = [{ selectEstSousRequete: false, clause: "SELECT", fromVu: false }];
  let selectsPremierNiveau = 0;
  let filtresTrouves = 0;
  for (let i = 0; i < t.length; i++) {
    const j = t[i]!;
    const m = mot(j);
    const niv = pile[pile.length - 1]!;
    if (m && MOTS_REFUSES.has(m)) throw new Error(`mot interdit « ${m} » dans une requête filtrée : ${cle}`);
    if (niv.clause === "FROM" && (j === "," || j === "(" || MOTS_JOINTURE.has(m))) throw new Error(`le FROM n'admet qu'une table, sans jointure, virgule ni sous-requête : ${cle}`);
    if (j === "(") {
      const sousRequete = mot(t[i + 1]) === "SELECT";
      if (sousRequete) {
        // Sous-requête : seulement dans la projection d'un SELECT de premier niveau sans FROM, un seul niveau de profondeur.
        const projection = pile.length === 1 && niv.clause === "SELECT" && !niv.fromVu;
        pile.push({ selectEstSousRequete: true, projection, clause: "SELECT", fromVu: false });
        i++; // saute le SELECT interne
      } else pile.push({ selectEstSousRequete: false, clause: "EXPRESSION", fromVu: false });
      continue;
    }
    if (j === ")") {
      if (pile.length === 1) throw new Error(`parenthèse fermante en trop : ${cle}`);
      const fermee = pile.pop()!;
      // Toute sous-requête qui lit une table porte elle-même le filtre.
      if (fermee.selectEstSousRequete && fermee.fromVu && !fermee.filtre) throw new Error(`sous-requête sans filtre : ${cle}`);
      continue;
    }
    if (m === "SELECT") {
      if (pile.length === 1) selectsPremierNiveau++;
      else throw new Error(`SELECT hors sous-requête de projection : ${cle}`);
      continue;
    }
    if (CLAUSES.has(m) && niv.clause !== "EXPRESSION") {
      if (m === "FROM") { if (niv.fromVu) throw new Error(`un seul FROM par SELECT : ${cle}`); niv.fromVu = true; }
      if (niv.clause === "WHERE" && (m === "WHERE" || m === "FROM")) throw new Error(`clause mal placée : ${cle}`);
      niv.clause = m;
      continue;
    }
    if (j === EMPLACEMENT_FILTRE) {
      filtresTrouves++;
      niv.filtre = true;
      const avant = mot(t[i - 1]);
      const apres = mot(t[i + 1]);
      const finNiveau = t[i + 1] === undefined || (t[i + 1] === ")" && niv.selectEstSousRequete);
      const niveauOk = pile.length === 1 || (pile.length === 2 && niv.selectEstSousRequete && niv.clause === "WHERE");
      const filtreDansProjection = pile.length === 2 && niv.clause === "WHERE" && niv.projection === true;
      if (!niveauOk || niv.clause !== "WHERE" || (pile.length === 2 && !filtreDansProjection)) throw new Error(`filtre mal placé (niveau ou clause) : ${cle}`);
      if (avant !== "WHERE" && avant !== "AND") throw new Error(`filtre mal placé (doit suivre WHERE ou AND) : ${cle}`);
      if (!finNiveau && apres !== "AND" && apres !== "ORDER" && apres !== "LIMIT") throw new Error(`filtre mal placé (suivi interdit) : ${cle}`);
      // Après le filtre, au même niveau, seules les clauses ORDER BY et LIMIT sont permises.
      let d = 0;
      for (let k = i + 1; k < t.length; k++) {
        if (t[k] === "(") d++;
        else if (t[k] === ")") { if (d === 0) break; d--; }
        else if (d === 0 && CLAUSES.has(mot(t[k])) && !["ORDER", "LIMIT"].includes(mot(t[k]))) throw new Error(`clause interdite après le filtre : ${cle}`);
      }
    }
  }
  if (pile.length !== 1) throw new Error(`parenthèses déséquilibrées : ${cle}`);
  if (selectsPremierNiveau !== 1) throw new Error(`un seul SELECT de premier niveau permis : ${cle}`);
  if (filtresTrouves !== sql.split(EMPLACEMENT_FILTRE).length - 1) throw new Error(`filtre mal placé : ${cle}`);
  // Un SELECT de premier niveau qui lit une table doit porter lui-même le filtre (un filtre seulement dans une sous-requête ne protège rien).
  if (pile[0]!.fromVu && !premierNiveauFiltre(t)) throw new Error(`le SELECT de premier niveau ne porte pas le filtre : ${cle}`);
}
function premierNiveauFiltre(t: string[]): boolean {
  let d = 0;
  for (const j of t) {
    if (j === "(") d++;
    else if (j === ")") d--;
    else if (d === 0 && j === EMPLACEMENT_FILTRE) return true;
  }
  return false;
}

// Refuse à la déclaration : filtre sans emplacement (ou l'inverse), nom qui ne suit pas sa clé, colonne chiffrée rendue ou nommée dans le texte SQL (alias, étoile compris),
// alias hors des colonnes rendues, filtre ailleurs qu'après WHERE ou AND, et OR dans une requête filtrée (un OR pourrait défaire le filtre d'établissement).
export function verifierListeBlanche(liste: Record<string, Requete>): void {
  for (const [cle, r] of Object.entries(liste)) {
    if (r.nom !== cle || !NOM.test(cle)) throw new Error(`requête mal nommée : ${cle}`);
    if (r.sql.includes(EMPLACEMENT_FILTRE) !== r.parEtablissement) throw new Error(`filtre d'établissement incohérent : ${cle}`);
    if (r.colonnes.some((c) => COLONNES_CHIFFREES.has(c) || /_chiffre$|_empreinte$/.test(c))) throw new Error(`colonne chiffrée rendue : ${cle}`);
    if (r.mode === "ecriture" && r.metadonnees) throw new Error(`écriture déclarée métadonnée : ${cle}`);
    const texte = r.sql.replaceAll(EMPLACEMENT_FILTRE, " ");
    if (r.parEtablissement && mot("etablissement_id").test(texte)) throw new Error(`etablissement_id nommé dans le SQL (seul le filtre le porte) : ${cle}`);
    for (const c of COLONNES_CHIFFREES) if (mot(c).test(texte)) throw new Error(`colonne chiffrée nommée dans le SQL : ${cle}`);
    if (/\bselect\s+(distinct\s+)?\*|,\s*\*|\.\*/i.test(texte)) throw new Error(`étoile dans le SQL : ${cle}`);
    for (const m of texte.matchAll(/\bAS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) if (!r.colonnes.includes(m[1] ?? "")) throw new Error(`alias hors des colonnes rendues : ${cle}`);
    if (r.parEtablissement) validerFormeFiltree(cle, r.sql);
  }
}

export const LISTE_BLANCHE: Readonly<Record<string, Requete>> = Object.freeze(premieresRequetes());
verifierListeBlanche(LISTE_BLANCHE);
