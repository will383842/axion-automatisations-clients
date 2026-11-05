import { z } from "zod";
import { MODELE, type Modele } from "./modele.js";

// Requête déclarée en STRUCTURE (T2-37c, ADR 0109) : aucun texte SQL n'entre dans le système. Schéma strict partout (une clé en trop est refusée, jamais ignorée) ;
// tout nom est une chaîne ASCII ET membre d'une liste blanche tirée du modèle (Map/Set, jamais un objet indexé). Le SQL est produit par generer.ts, et par lui seul.
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const NOM_REQUETE = /^[a-z][A-Za-z0-9]{0,63}$/;
// Noms qui ne sont jamais ceux d'un alias, d'un paramètre ou d'une requête : membres de Object.prototype, mots du SQL, fonctions de lecture, noms réservés à la session.
const PROTOTYPE = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype", "__proto__"].map((n) => n.toLowerCase()));
const MOTS_SQL = new Set(["or", "and", "not", "is", "in", "null", "true", "false", "union", "intersect", "except", "exists", "between", "select", "from", "where", "join", "group", "having", "order", "limit", "offset", "case", "when", "with", "all", "any", "as", "like", "ilike", "distinct", "insert", "update", "delete", "drop", "alter", "create", "grant", "copy", "do", "set", "lateral", "values", "into", "for", "fetch", "over", "filter", "window", "on", "using", "user", "table", "row", "current_user", "etablissement_id", "etablissements", "ts_stat", "to_json", "to_jsonb", "row_to_json"]);
const nomLibre = (n: string) => !PROTOTYPE.has(n.toLowerCase()) && !MOTS_SQL.has(n.toLowerCase()) && !/^(pg_|current_|set_config)|_to_(xml|json|jsonb)$/.test(n.toLowerCase());

const OPERATEURS = ["egal", "different", "inferieur", "inferieur_ou_egal", "superieur", "superieur_ou_egal", "dans", "est_nul", "n_est_pas_nul"] as const;
const SANS_VALEUR = new Set<string>(["est_nul", "n_est_pas_nul"]);
const ENTIERS = new Set(["integer", "bigint", "smallint"]);
const NUMERIQUES = new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);

const Colonne = z.string().regex(IDENT);
const Alias = z.string().regex(IDENT);
const Agregat = z.discriminatedUnion("fonction", [
  z.strictObject({ fonction: z.literal("compter"), alias: Alias }),
  z.strictObject({ fonction: z.literal("somme"), colonne: Colonne, alias: Alias }),
]);
const Filtre = z.strictObject({ colonne: Colonne, operateur: z.enum(OPERATEURS), parametre: z.string().regex(IDENT).optional() });
const Parametre = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("uuid"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("texte"), max: z.number().int().min(1).max(200), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("entier"), min: z.number().int(), max: z.number().int(), defaut: z.number().optional() }),
  z.strictObject({ type: z.literal("horodatage"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("liste_uuid"), max: z.number().int().min(1).max(100), defaut: z.array(z.string()).optional() }),
]);
export type Parametre = z.infer<typeof Parametre>;

// Schéma de la VALEUR d'un paramètre à l'appel, dérivé de sa déclaration. Un texte ne contient jamais le caractère nul.
export function schemaValeur(p: Parametre): z.ZodType {
  switch (p.type) {
    case "uuid": return z.uuid();
    case "texte": return z.string().max(p.max).refine((s) => !s.includes("\u0000"));
    case "entier": return z.number().int().min(p.min).max(p.max);
    case "horodatage": return z.iso.datetime({ offset: true });
    case "liste_uuid": return z.array(z.uuid()).max(p.max);
  }
}
const COMPATIBLES: Record<Parametre["type"], (t: string) => boolean> = {
  uuid: (t) => t === "uuid", texte: (t) => t === "text", entier: (t) => ENTIERS.has(t), horodatage: (t) => t === "timestamp with time zone", liste_uuid: (t) => t === "uuid",
};

const Forme = (modele: Modele) => {
  const Table = z.string().refine((t) => modele.tables.get(t)?.aEtablissement === true, "table non déclarable");
  const Simple = z.strictObject({
    type: z.literal("simple"),
    table: Table,
    sortie: z.union([
      z.strictObject({ lignes: z.array(z.strictObject({ colonne: Colonne, alias: Alias.optional() })).min(1).max(30) }),
      z.strictObject({ agregats: z.array(Agregat).min(1).max(10) }),
    ]),
    filtres: z.array(Filtre).max(10).optional(),
    tri: z.array(z.strictObject({ colonne: Colonne, sens: z.enum(["asc", "desc"]) })).max(3).optional(),
    limite: z.union([z.strictObject({ parametre: z.string().regex(IDENT) }), z.strictObject({ fixe: z.number().int().min(1).max(200) })]).optional(),
  });
  const Composee = z.strictObject({
    type: z.literal("composee"),
    parties: z.array(z.strictObject({ alias: Alias, table: Table, agregat: Agregat, filtres: z.array(Filtre).max(10).optional() })).min(2).max(5),
  });
  return z.discriminatedUnion("type", [Simple, Composee]);
};

// Une clé « __proto__ » propre (venue d'un JSON.parse) est refusée à tout niveau avant même la lecture du schéma.
function sansProto(v: unknown, profondeur = 0): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (profondeur > 12 || Object.hasOwn(v, "__proto__")) return false;
  return Object.values(v).every((x) => sansProto(x, profondeur + 1));
}

export function creerSchemaRequete(modele: Modele) {
  const FormeM = Forme(modele);
  const brut = z.strictObject({
    nom: z.string().regex(NOM_REQUETE),
    mode: z.literal("lecture"),
    metadonnees: z.boolean(),
    parametres: z.record(z.string().regex(IDENT), Parametre),
    forme: FormeM,
    variantes: z.array(z.strictObject({ depuis: z.number().int().min(1), forme: FormeM })).max(5).optional(),
  });
  return z.unknown().refine((v) => sansProto(v), "clé réservée").pipe(brut.superRefine((r, ctx) => {
    const refus = (message: string) => ctx.addIssue({ code: "custom", message });
    if (!nomLibre(r.nom)) refus("nom de requête réservé");
    const noms = Object.keys(r.parametres);
    for (const n of noms) {
      if (!IDENT.test(n) || !nomLibre(n)) refus(`nom de paramètre refusé : ${n}`);
      const p = Object.hasOwn(r.parametres, n) ? r.parametres[n] : undefined;
      if (!p) { refus("paramètre illisible"); continue; }
      if (p.type === "entier" && (p.min > p.max)) refus("bornes inversées");
      if (p.defaut !== undefined && !schemaValeur(p).safeParse(p.defaut).success) refus(`défaut invalide : ${n}`);
    }
    const parametre = (n: string): Parametre | undefined => (Object.hasOwn(r.parametres, n) ? r.parametres[n] : undefined);
    const utilises = new Set<string>();

    const colonneLisible = (table: string, nom: string) => {
      const def = modele.tables.get(table)?.colonnes.get(nom);
      if (!def || def.chiffree || nom === "etablissement_id") { refus(`colonne refusée : ${nom}`); return undefined; }
      return def;
    };
    const aliasOk = (a: string) => { if (!nomLibre(a) || modele.chiffrees.has(a)) refus(`alias refusé : ${a}`); };
    const filtres = (table: string, liste: z.infer<typeof Filtre>[] | undefined) => {
      for (const f of liste ?? []) {
        const def = colonneLisible(table, f.colonne);
        if (SANS_VALEUR.has(f.operateur)) { if (f.parametre !== undefined) refus("paramètre inutile pour est_nul"); continue; }
        const p = f.parametre === undefined ? undefined : parametre(f.parametre);
        if (!p || !def) { refus("paramètre de filtre absent ou non déclaré"); continue; }
        utilises.add(f.parametre!);
        if ((f.operateur === "dans") !== (p.type === "liste_uuid") || !COMPATIBLES[p.type](def.type)) refus(`paramètre incompatible avec la colonne ${f.colonne}`);
      }
    };
    const agregat = (table: string, a: z.infer<typeof Agregat>) => {
      aliasOk(a.alias);
      if (a.fonction === "somme") {
        const def = colonneLisible(table, a.colonne);
        if (def && !NUMERIQUES.has(def.type)) refus("somme sur colonne non numérique");
      }
    };
    // Rend la liste des colonnes rendues et si la sortie n'a que des agrégats.
    const forme = (f: z.infer<typeof FormeM>): { rendues: string[]; agregats: boolean } => {
      if (f.type === "composee") {
        const alias = new Set<string>();
        for (const part of f.parties) {
          if (part.alias !== part.agregat.alias) refus("alias de partie et d'agrégat différents");
          alias.add(part.alias);
          agregat(part.table, part.agregat);
          filtres(part.table, part.filtres);
        }
        if (alias.size !== f.parties.length) refus("alias de parties répétés");
        return { rendues: f.parties.map((p) => p.alias), agregats: true };
      }
      const agr = "agregats" in f.sortie;
      let rendues: string[];
      if ("agregats" in f.sortie) {
        for (const a of f.sortie.agregats) agregat(f.table, a);
        rendues = f.sortie.agregats.map((a) => a.alias);
      } else {
        rendues = f.sortie.lignes.map((l) => { colonneLisible(f.table, l.colonne); if (l.alias !== undefined) aliasOk(l.alias); return l.alias ?? l.colonne; });
      }
      if (new Set(rendues).size !== rendues.length) refus("colonnes rendues répétées");
      filtres(f.table, f.filtres);
      for (const t of f.tri ?? []) colonneLisible(f.table, t.colonne);
      if (agr && f.tri?.length) refus("tri avec agrégats");
      if (agr && f.limite) refus("limite avec agrégats");
      if (!agr && !f.limite) refus("limite obligatoire sur des lignes");
      if (f.limite && "parametre" in f.limite) {
        const p = parametre(f.limite.parametre);
        if (p?.type !== "entier" || p.min < 1 || p.max > 200) refus("paramètre de limite hors bornes 1..200");
        else utilises.add(f.limite.parametre);
      }
      return { rendues, agregats: agr };
    };

    const principale = forme(r.forme);
    const autres = (r.variantes ?? []).map((v) => forme(v.forme));
    for (const v of autres) {
      if (JSON.stringify(v.rendues) !== JSON.stringify(principale.rendues)) refus("une variante change les colonnes rendues");
    }
    if (r.metadonnees && ![principale, ...autres].every((x) => x.agregats)) refus("metadonnees vrai avec une sortie en lignes");
    for (const n of noms) if (!utilises.has(n)) refus(`paramètre non utilisé : ${n}`);
  }));
}

const SCHEMA = creerSchemaRequete(MODELE);
export type RequeteDeclaree = z.output<typeof SCHEMA>;
export type FormeDeclaree = RequeteDeclaree["forme"];
export const SchemaRequete = SCHEMA;

// Lève une erreur si l'objet n'est pas une requête déclarée valide.
export function declarer(objet: unknown): RequeteDeclaree {
  return SCHEMA.parse(objet);
}

// Schéma des paramètres d'appel, DÉRIVÉ de la déclaration : les clés en trop sont écartées, jamais lues.
export function schemaParametres(r: RequeteDeclaree): z.ZodType<Record<string, unknown>> {
  const forme: Record<string, z.ZodType> = {};
  for (const n of Object.keys(r.parametres)) {
    const p = r.parametres[n]!;
    const v = schemaValeur(p);
    forme[n] = p.defaut === undefined ? v : v.default(p.defaut as never);
  }
  return z.object(forme) as unknown as z.ZodType<Record<string, unknown>>;
}
