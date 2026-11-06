import { Forme, Parametres, sansProto, schemaValeur, type Parametre } from "@axion-auto/contrats/src/c4/forme.ts";
import { nomLibre, verifierForme } from "@axion-auto/donnees-module";
import { z } from "zod";
import { MODELE, type Modele } from "./modele.js";

// Requête déclarée en STRUCTURE (T2-37c, ADR 0109) : aucun texte SQL n'entre dans le système. Couche mince depuis T4-50b : la forme est le schéma de C4 0.5.0 (contrats), les contrôles qui
// dépendent du modèle sont ceux du paquet (verifierForme), le SQL est produit par le paquet (via generer.ts). Ici : la requête (nom, métadonnées, variantes) et ses paramètres.
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const NOM_REQUETE = /^[a-z][A-Za-z0-9]{0,63}$/;
export type { Parametre };
export { schemaValeur };

export function creerSchemaRequete(modele: Modele) {
  const brut = z.strictObject({
    nom: z.string().regex(NOM_REQUETE),
    mode: z.literal("lecture"),
    metadonnees: z.boolean(),
    parametres: Parametres,
    forme: Forme,
    variantes: z.array(z.strictObject({ depuis: z.number().int().min(1), forme: Forme })).max(5).optional(),
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
    // Forme de base puis variantes : contrôles du paquet, sur le modèle.
    const [principale, ...autres] = [r.forme, ...(r.variantes ?? []).map((v) => v.forme)].map((f) => verifierForme(f, r.parametres, modele));
    for (const x of [principale!, ...autres]) for (const m of x.refus) refus(m);
    for (const v of autres) {
      if (JSON.stringify(v.rendues) !== JSON.stringify(principale!.rendues)) refus("une variante change les colonnes rendues");
    }
    if (r.metadonnees && ![principale!, ...autres].every((x) => x.agregats)) refus("metadonnees vrai avec une sortie en lignes");
    const utilises = new Set([principale!, ...autres].flatMap((x) => [...x.utilises]));
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
