import { z } from "zod";

// C4 0.5.0 (ADR 0109, ADR 0112) : forme d'une requête déclarée, sans texte SQL. Schémas indépendants du modèle des bases clients :
// la vérification contre ce modèle (colonnes, types, colonnes chiffrées) est faite à l'import (T4-50c). Même forme que
// apps/api/src/donnees/requetes/structure.ts, qui la reprendra (T4-50b).
export const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
// Lecture seule du schéma commun : aucun autre schéma n'est nommable.
export const TABLE_COMMUN = /^commun\.[a-z][a-z0-9_]{0,62}$/;
export const OPERATEURS = ["egal", "different", "inferieur", "inferieur_ou_egal", "superieur", "superieur_ou_egal", "dans", "est_nul", "n_est_pas_nul"] as const;

// Noms jamais déclarables comme colonne, alias ou paramètre : membres d'Object.prototype, noms réservés à la session, fonctions système.
// L'établissement n'est jamais choisi par le module (invariant d'isolation, ADR 0109) ; il est posé par le générateur.
const PROTOTYPE = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype", "__proto__"].map((n) => n.toLowerCase()));
const RESERVES = new Set(["etablissement_id", "etablissements", "tenant_id", "set_config", "user"]);
export const nomLibre = (n: string) => !PROTOTYPE.has(n.toLowerCase()) && !RESERVES.has(n.toLowerCase()) && !/^(pg_|current_)/.test(n.toLowerCase());
const Nom = z.string().regex(IDENT).refine(nomLibre, "nom réservé");
const Colonne = Nom;
const Alias = Nom;
export const Agregat = z.discriminatedUnion("fonction", [
  z.strictObject({ fonction: z.literal("compter"), alias: Alias }),
  z.strictObject({ fonction: z.literal("somme"), colonne: Colonne, alias: Alias }),
]);
export const Filtre = z.strictObject({ colonne: Colonne, operateur: z.enum(OPERATEURS), parametre: Nom.optional() });
export const Parametre = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("uuid"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("texte"), max: z.number().int().min(1).max(200), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("entier"), min: z.number().int(), max: z.number().int(), defaut: z.number().optional() }),
  z.strictObject({ type: z.literal("horodatage"), defaut: z.string().optional() }),
  z.strictObject({ type: z.literal("liste_uuid"), max: z.number().int().min(1).max(100), defaut: z.array(z.string()).optional() }),
]);
export type Parametre = z.infer<typeof Parametre>;
export const MAX_PARAMETRES = 30;
export const Parametres = z.record(Nom, Parametre).refine((p) => Object.keys(p).length <= MAX_PARAMETRES, `${MAX_PARAMETRES} paramètres au plus`);

const Table = z.string().regex(TABLE_COMMUN);
const Simple = z.strictObject({
  type: z.literal("simple"),
  table: Table,
  sortie: z.union([
    z.strictObject({ lignes: z.array(z.strictObject({ colonne: Colonne, alias: Alias.optional() })).min(1).max(30) }),
    z.strictObject({ agregats: z.array(Agregat).min(1).max(10) }),
  ]),
  filtres: z.array(Filtre).max(10).optional(),
  tri: z.array(z.strictObject({ colonne: Colonne, sens: z.enum(["asc", "desc"]) })).max(3).optional(),
  limite: z.union([z.strictObject({ parametre: Nom }), z.strictObject({ fixe: z.number().int().min(1).max(200) })]).optional(),
});
const Composee = z.strictObject({
  type: z.literal("composee"),
  parties: z.array(z.strictObject({ alias: Alias, table: Table, agregat: Agregat, filtres: z.array(Filtre).max(10).optional() })).min(2).max(5),
});
export const Forme = z.discriminatedUnion("type", [Simple, Composee]);
export type Forme = z.infer<typeof Forme>;

// Une clé « __proto__ » propre (venue d'un JSON.parse) est refusée à tout niveau avant la lecture du schéma.
export function sansProto(v: unknown, profondeur = 0): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (profondeur > 12 || Object.hasOwn(v, "__proto__")) return false;
  return Object.values(v).every((x) => sansProto(x, profondeur + 1));
}

// Valeur d'un paramètre à l'appel, dérivée de sa déclaration (sert à valider les défauts).
export function schemaValeur(p: Parametre): z.ZodType {
  switch (p.type) {
    case "uuid": return z.uuid();
    case "texte": return z.string().max(p.max).refine((s) => !s.includes("\u0000"));
    case "entier": return z.number().int().min(p.min).max(p.max);
    case "horodatage": return z.iso.datetime({ offset: true });
    case "liste_uuid": return z.array(z.uuid()).max(p.max);
  }
}

// Contrôles de cohérence qui ne dépendent pas du modèle ; types de colonnes et colonnes chiffrées : T4-50c.
export function verifierCoherence(parametres: Record<string, Parametre>, forme: Forme, refus: (m: string) => void): void {
  const decl = (n: string) => (Object.hasOwn(parametres, n) ? parametres[n] : undefined);
  const utilises = new Set<string>();
  for (const [n, p] of Object.entries(parametres)) {
    if (p.type === "entier" && p.min > p.max) refus(`bornes inversées : ${n}`);
    if (p.defaut !== undefined && !schemaValeur(p).safeParse(p.defaut).success) refus(`défaut invalide : ${n}`);
  }
  const filtres = (liste: z.infer<typeof Filtre>[] | undefined) => {
    for (const f of liste ?? []) {
      if (f.operateur === "est_nul" || f.operateur === "n_est_pas_nul") { if (f.parametre !== undefined) refus("paramètre inutile pour est_nul"); continue; }
      const p = f.parametre === undefined ? undefined : decl(f.parametre);
      if (!p) { refus("paramètre de filtre absent ou non déclaré"); continue; }
      utilises.add(f.parametre!);
      if ((f.operateur === "dans") !== (p.type === "liste_uuid")) refus(`opérateur incompatible avec le paramètre ${f.parametre}`);
    }
  };
  const alias: string[] = [];
  if (forme.type === "composee") {
    for (const part of forme.parties) { alias.push(part.alias); if (part.alias !== part.agregat.alias) refus("alias de partie et d'agrégat différents"); filtres(part.filtres); }
  } else {
    if ("agregats" in forme.sortie) {
      alias.push(...forme.sortie.agregats.map((a) => a.alias));
      if (forme.tri?.length || forme.limite) refus("tri ou limite avec agrégats");
    } else {
      alias.push(...forme.sortie.lignes.map((l) => l.alias ?? l.colonne));
      if (!forme.limite) refus("limite obligatoire sur des lignes");
    }
    filtres(forme.filtres);
    if (forme.limite && "parametre" in forme.limite) {
      const p = decl(forme.limite.parametre);
      if (p?.type !== "entier" || p.min < 1 || p.max > 200) refus("paramètre de limite hors bornes 1..200");
      else utilises.add(forme.limite.parametre);
    }
  }
  if (new Set(alias).size !== alias.length) refus("colonnes ou alias répétés");
  for (const n of Object.keys(parametres)) if (!utilises.has(n)) refus(`paramètre non utilisé : ${n}`);
}
