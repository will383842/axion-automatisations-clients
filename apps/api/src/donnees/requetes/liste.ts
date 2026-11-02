import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodType } from "zod";
import { premieresRequetes } from "./premieres.js";

// Principe : LISTE BLANCHE, tout est refusé par défaut. Seuls sont admis les jetons, mots, fonctions, types et colonnes nommés explicitement ci-dessous ;
// chaînes E'', U&, B'', X'', antislash, identifiants entre guillemets, alias de table seul (ligne entière) : rien de cela n'est admis, jamais « toléré faute de mieux ».
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
// Colonnes connues et NON chiffrées de chaque table du modèle (clé « schéma.table », ou « table » sans schéma) : seules admises derrière « alias. » (B-173).
function tablesDuModele(): ReadonlyMap<string, ReadonlySet<string>> {
  const dossier = fileURLToPath(new URL("../../../drizzle-cli/", import.meta.url));
  const tables = new Map<string, Set<string>>();
  for (const f of readdirSync(dossier).filter((x) => x.endsWith(".sql"))) {
    for (const m of readFileSync(`${dossier}${f}`, "utf8").matchAll(/CREATE TABLE (?:"([a-z_0-9]+)"\.)?"([a-z_0-9]+)" \(\n([\s\S]*?)\n\);/g)) {
      const cles = new Set<string>();
      for (const c of (m[3] ?? "").matchAll(/^\s*"([a-z_0-9]+)"\s/gm)) if (!COLONNES_CHIFFREES.has(c[1] ?? "")) cles.add(c[1] ?? "");
      tables.set(m[1] ? `${m[1]}.${m[2]}` : (m[2] ?? ""), cles);
    }
  }
  if (tables.size === 0) throw new Error("tables du modèle des bases clients introuvables");
  return tables;
}
const TABLES_MODELE = tablesDuModele();
const mot = (nom: string) => new RegExp(`(?<![A-Za-z0-9_])"?${nom}"?(?![A-Za-z0-9_])`, "i");

// Analyse stricte (liste blanche de formes) d'une requête filtrée par établissement (B-173). Le texte est découpé en jetons ADMIS (chaîne ordinaire = un jeton opaque ; tout autre caractère est refusé),
// puis : un seul SELECT de premier niveau ; aucun mot de la liste noire (IS, NOT, OR, UNION…) ; {{filtre}} seulement comme conjonct AND de premier niveau d'un WHERE,
// suivi de AND, ORDER BY, LIMIT ou de la fin. Seule exception : une sous-requête de PROJECTION « (SELECT … WHERE {{filtre}} …) » dans un SELECT de premier niveau SANS FROM (contrôlé en fin d'analyse), jamais ailleurs.
// Fonctions et types : listes fermées. Chaque identifiant doit être un mot admis, une étiquette « AS », une colonne connue de la table du niveau ou « alias.colonne connue » : un nom de table ou d'alias NU désigne la ligne entière et est refusé.
const MOTS_REFUSES = new Set(["IS", "NOT", "OR", "UNION", "INTERSECT", "EXCEPT", "EXISTS", "BETWEEN", "CASE", "WITH", "INTO", "FOR", "VALUES", "LATERAL", "DISTINCT_FROM", "UPDATE", "DELETE", "INSERT", "TRUNCATE", "DROP", "ALTER", "CREATE", "GRANT", "COPY", "CALL", "DO", "SET", "WINDOW", "FETCH", "OVER", "FILTER"]);
// Dans un FROM : un seul nom de table (alias permis), jamais de jointure, de virgule ni de table dérivée (le filtre ne porterait alors que sur une des tables).
const MOTS_JOINTURE = new Set(["JOIN", "CROSS", "NATURAL", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "ON", "USING", "TABLESAMPLE", "ROWS"]);
const CLAUSES = new Set(["FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET"]);
// Liste FERMÉE des fonctions admises dans une requête filtrée (agrégats et scalaires sans accès à d'autres lignes ni à d'autres tables). Tout autre « nom( » est refusé :
// table_to_xml, query_to_xml, row_to_json, to_jsonb, pg_… lisent des lignes entières ou exécutent du SQL en dehors du filtre.
const FONCTIONS_SURES = new Set(["COUNT", "SUM", "MIN", "MAX", "AVG", "COALESCE", "NULLIF", "LOWER", "UPPER", "DATE_TRUNC", "ROUND", "ABS", "LENGTH", "GREATEST", "LEAST"]);
// Liste FERMÉE des types admis après « :: » (jamais un nom de table : « p::text » est la ligne entière en texte).
const TYPES_SURS = new Set(["int", "integer", "int4", "int8", "bigint", "smallint", "float4", "float8", "numeric", "text", "date", "timestamp", "timestamptz", "uuid", "boolean", "bool"]);
// Seuls mots nus admis en dehors d'une colonne : mots-clés du modèle de requête et constantes.
const MOTS_SURS = new Set(["SELECT", "DISTINCT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET", "AS", "AND", "IN", "ANY", "ASC", "DESC", "NULLS", "FIRST", "LAST", "TRUE", "FALSE", "NULL", "LIKE", "ILIKE"]);
// Mots qui peuvent précéder une parenthèse sans être une fonction.
const MOTS_AVANT_PARENTHESE = new Set(["AND", "IN", "ANY", "AS", "WHERE", "FROM", "SELECT", "LIMIT", "BY", "ON"]);
// Jetons admis, et seulement eux : espaces, chaîne ordinaire, emplacement du filtre, paramètre $n, identifiant SIMPLE, nombre, opérateurs simples.
// Refusés par construction : guillemets doubles, antislash, « ; », « $$ », « & » (U&), crochets, caractères non ASCII hors chaîne.
const JETON = /\s+|('(?:[^']|'')*')|(\{\{filtre\}\})|(\$\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?)|(::|<>|<=|>=|\|\||[(),.=<>+\-*/])/y;
function jetons(cle: string, sql: string): string[] {
  if (sql.includes("\\")) throw new Error(`antislash interdit : ${cle}`);
  if (/--|\/\*/.test(sql.replace(/'(?:[^']|'')*'/g, " "))) throw new Error(`commentaire interdit : ${cle}`);
  const res: string[] = [];
  JETON.lastIndex = 0;
  while (JETON.lastIndex < sql.length) {
    const debut = JETON.lastIndex;
    const m = JETON.exec(sql);
    if (!m) throw new Error(`caractère ou syntaxe hors liste blanche (guillemets doubles, point-virgule, $$…) : ${cle}`);
    if (m[0].length === 0) throw new Error(`jeton vide : ${cle}`);
    // Un mot collé à une chaîne (E'…', B'…', X'…', N'…', U&'…') est un préfixe de chaîne : refusé.
    if (m[4] !== undefined && sql[JETON.lastIndex] === "'") throw new Error(`préfixe de chaîne interdit (E, B, X, N, U&) : ${cle}`);
    if (sql[debut] !== undefined && /\s/.test(sql[debut]!)) continue;
    res.push(m[0]);
  }
  return res;
}
const estMot = (j: string | undefined) => j !== undefined && /^[A-Za-z_]/.test(j);
function validerFormeFiltree(cle: string, sql: string): void {
  const t = jetons(cle, sql);
  const mot = (j: string | undefined) => (estMot(j) ? j!.toUpperCase() : "");
  if (mot(t[0]) !== "SELECT") throw new Error(`requête filtrée : seul un SELECT simple est permis : ${cle}`);
  type Table = { cles: string[]; alias?: string; colonnes: ReadonlySet<string> };
  type Niveau = { selectEstSousRequete: boolean; projection?: boolean | undefined; clause: string; fromVu: boolean; filtre?: boolean; table?: Table; aliasPris: boolean; attendAlias: boolean; etiquettes: Set<string>; chaines: string[][] };
  const niveau = (sousRequete: boolean, clause: string, projection?: boolean): Niveau => ({ selectEstSousRequete: sousRequete, projection, clause, fromVu: false, aliasPris: false, attendAlias: false, etiquettes: new Set(), chaines: [] });
  const pile: Niveau[] = [niveau(false, "SELECT")];
  const sousClause = (c: string) => c === "EXPRESSION";
  // À la fermeture d'un SELECT : chaque identifiant relevé doit être admis. Un nom de table ou d'alias NU (ligne entière, colonnes chiffrées comprises) est refusé ;
  // « alias.identifiant » n'est admis que si identifiant est une colonne connue (non chiffrée) de la table de cet alias.
  const verifier = (n: Niveau) => {
    const tb = n.table;
    const visibles = tb ? (tb.alias !== undefined ? [tb.alias] : tb.cles) : [];
    for (const ch of n.chaines) {
      const noms = ch.map((x) => x.toLowerCase());
      if (noms.length === 1) {
        const [nu = ""] = noms;
        if (visibles.includes(nu) || (tb && tb.cles.includes(nu))) throw new Error(`ligne entière (nom de table ou d'alias seul) : ${cle}`);
        if (MOTS_SURS.has(nu.toUpperCase()) || n.etiquettes.has(nu) || tb?.colonnes.has(nu)) continue;
        throw new Error(`identifiant « ${nu} » hors liste blanche (ni mot admis, ni colonne connue) : ${cle}`);
      }
      if (!tb) throw new Error(`identifiant qualifié sans table : ${cle}`);
      const colonne = noms[noms.length - 1]!;
      const qualif = noms.slice(0, -1).join(".");
      const ok = tb.alias !== undefined ? qualif === tb.alias : tb.cles.includes(qualif);
      if (!ok || !tb.colonnes.has(colonne)) throw new Error(`« ${noms.join(".")} » : alias inconnu ou colonne inconnue ou chiffrée : ${cle}`);
    }
  };
  let sousRequetes = 0;
  let selectsPremierNiveau = 0;
  let filtresTrouves = 0;
  for (let i = 0; i < t.length; i++) {
    const j = t[i]!;
    const m = mot(j);
    const niv = pile[pile.length - 1]!;
    if (m && MOTS_REFUSES.has(m)) throw new Error(`mot interdit « ${m} » dans une requête filtrée : ${cle}`);
    if (niv.clause === "FROM" && (j === "," || j === "(" || MOTS_JOINTURE.has(m))) throw new Error(`le FROM n'admet qu'une table, sans jointure, virgule ni sous-requête : ${cle}`);
    if (j === "(") {
      const avantParenthese = t[i - 1];
      if (avantParenthese !== undefined && avantParenthese !== "(" && /^[A-Za-z_"]/.test(avantParenthese) && !MOTS_AVANT_PARENTHESE.has(mot(avantParenthese)) && t[i - 2] !== "::") {
        if (t[i - 2] === "." || !FONCTIONS_SURES.has(mot(avantParenthese))) throw new Error(`fonction hors liste fermée « ${avantParenthese} » : ${cle}`);
      }
      const sousRequete = mot(t[i + 1]) === "SELECT";
      if (sousRequete) {
        // Sous-requête : seulement dans la projection d'un SELECT de premier niveau sans FROM, un seul niveau de profondeur.
        const projection = pile.length === 1 && niv.clause === "SELECT" && !niv.fromVu;
        sousRequetes++;
        pile.push(niveau(true, "SELECT", projection));
        i++; // saute le SELECT interne
      } else pile.push(niveau(false, "EXPRESSION"));
      continue;
    }
    if (j === ")") {
      if (pile.length === 1) throw new Error(`parenthèse fermante en trop : ${cle}`);
      const fermee = pile.pop()!;
      if (fermee.selectEstSousRequete) verifier(fermee);
      // Une parenthèse d'expression confie ses identifiants au SELECT qui la contient (la table n'est connue qu'à la fin de ce SELECT).
      else pile[pile.length - 1]!.chaines.push(...fermee.chaines);
      // Toute sous-requête qui lit une table porte elle-même le filtre.
      if (fermee.selectEstSousRequete && fermee.fromVu && !fermee.filtre) throw new Error(`sous-requête sans filtre : ${cle}`);
      continue;
    }
    if (m === "SELECT") {
      if (pile.length === 1) selectsPremierNiveau++;
      else throw new Error(`SELECT hors sous-requête de projection : ${cle}`);
      continue;
    }
    if (CLAUSES.has(m) && !sousClause(niv.clause)) {
      if (m === "FROM") { if (niv.fromVu) throw new Error(`un seul FROM par SELECT : ${cle}`); niv.fromVu = true; }
      if (niv.clause === "WHERE" && (m === "WHERE" || m === "FROM")) throw new Error(`clause mal placée : ${cle}`);
      niv.clause = m;
      continue;
    }
    if (niv.clause === "FROM") {
      // FROM : « [schéma.]table [AS] [alias] », table connue du modèle, rien d'autre.
      if (m === "AS" && niv.table && !niv.aliasPris && !niv.attendAlias) { niv.attendAlias = true; continue; }
      if (!estMot(j)) throw new Error(`le FROM n'admet qu'une table connue et son alias : ${cle}`);
      if (!niv.table) {
        const schema = t[i + 1] === "." && estMot(t[i + 2]) ? j.toLowerCase() : undefined;
        const nom = (schema !== undefined ? t[i + 2]! : j).toLowerCase();
        if (schema !== undefined) i += 2;
        const cles = schema !== undefined ? [`${schema}.${nom}`] : [...TABLES_MODELE.keys()].filter((k) => k === nom || k.endsWith(`.${nom}`));
        const colonnes = cles.length === 1 ? TABLES_MODELE.get(cles[0]!) : undefined;
        if (!colonnes) throw new Error(`table inconnue du modèle ou ambiguë « ${nom} » : ${cle}`);
        // Sans alias, la table se nomme par « table » ou « schéma.table ».
        niv.table = { cles: [nom, cles[0]!], colonnes };
      } else if (!niv.aliasPris) { niv.table.alias = j.toLowerCase(); niv.aliasPris = true; niv.attendAlias = false; }
      else throw new Error(`le FROM n'admet qu'une table et son alias : ${cle}`);
      continue;
    }
    if (estMot(j)) {
      if (t[i - 1] === "::") {
        // Après « :: » : un type de la liste fermée, jamais un nom de table (ni qualifié).
        if (!TYPES_SURS.has(j.toLowerCase()) || t[i + 1] === ".") throw new Error(`type « ${j} » hors liste fermée : ${cle}`);
        continue;
      }
      if (t[i - 1] === ".") continue; // maillon d'une chaîne déjà relevée
      if (t[i + 1] === "(") continue; // nom de fonction, contrôlé à la parenthèse
      if (m === "AS") continue;
      if (mot(t[i - 1]) === "AS") { niv.etiquettes.add(j.toLowerCase()); continue; }
      // Chaîne « a », « a.b » ou « a.b.c » : relevée, vérifiée à la fermeture du niveau.
      const chaine = [j];
      while (t[i + 1] === ".") {
        if (!estMot(t[i + 2])) throw new Error(`« . » suivi d'autre chose qu'un identifiant simple : ${cle}`);
        chaine.push(t[i + 2]!);
        i += 2;
      }
      if (chaine.length > 3) throw new Error(`identifiant trop qualifié : ${cle}`);
      niv.chaines.push(chaine);
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
  verifier(pile[0]!);
  // Une sous-requête n'est permise que dans un SELECT sans FROM : avec un FROM, le filtre non qualifié d'une table sans etablissement_id se corrèle sur la requête extérieure.
  if (pile[0]!.fromVu && sousRequetes > 0) throw new Error(`sous-requête interdite dans un SELECT qui a un FROM : ${cle}`);
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
    // Contrôle lexical (liste blanche de jetons) pour TOUTE requête ; l'analyse de forme et d'identifiants pour les requêtes filtrées.
    jetons(cle, r.sql);
    if (r.parEtablissement) validerFormeFiltree(cle, r.sql);
  }
}

export const LISTE_BLANCHE: Readonly<Record<string, Requete>> = Object.freeze(premieresRequetes());
verifierListeBlanche(LISTE_BLANCHE);
