import { createHash } from "node:crypto";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { STATUTS } from "./cycle-de-vie.js";

// Procédure en 10 étapes (C-240) : schémas STRICTS de ce que la route accepte pour chaque étape. Aucune clé libre, textes bornés, aucune donnée de client (la base filtre aussi, mais son filtre n'est pas exhaustif).
// L'étape 9 (7 jours de pilote) est calculée et l'étape 10 (signature de production) est rangée par le passage en publiee : aucune des deux ne se dépose à la main.
const refus = () => new ErreurApi("schema_invalide", "Requête invalide.");
const EMPREINTE = z.string().regex(/^[0-9a-f]{64}$/);
// Une suite de 9 chiffres ou plus (espaces, points ou tirets permis entre eux) ressemble à un téléphone ou à un SIREN ; une arobase, à une adresse.
const texte = (max: number) => z.string().trim().min(1).max(max).refine((t) => !t.includes("@") && !/(?:\d[\s.-]?){9,}/.test(t));
// Même forme que la contrainte de la base (preuves_procedure_reference_forme), sans « .. » ni nombre de 9 ou 14 chiffres (forme d'un SIREN ou d'un SIRET).
const REFERENCE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/#-]{0,254}$/).refine((r) => !r.includes("..") && !/^[0-9]{9}([0-9]{5})?$/.test(r));
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d) && d >= "2026-01-01" && d <= "2100-12-31";
});
const MODELE = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,127}$/).refine((m) => !m.includes(".."));

const entier = z.number().int();
const Rapport = z.strictObject({
  module: z.string().min(1).max(100),
  version: z.string().min(1).max(64),
  cas: z.array(z.strictObject({ id: z.string().min(1).max(100), categorie: z.string().min(1).max(100), reussi: z.boolean(), ecart: z.string().max(500).optional() })).max(1000),
  determinisme: z.array(z.strictObject({ etape: z.string().min(1).max(100), reussi: z.boolean() })).max(100),
  hostile: z.strictObject({ demandes: z.strictObject({ refusees: entier.min(0), brouillons: entier.min(0), automatiques: entier.min(0) }), appelsConnecteur: entier.min(0), violations: entier.min(0) }),
  totaux: z.strictObject({ reussis: entier.min(0), echoues: entier.min(0) }),
  codeSortie: z.union([z.literal(0), z.literal(1)]),
  // Liste des modèles d'IA essayés par la recette (C-202) : lue du rapport, jamais saisie à la main.
  modeles: z.array(MODELE).max(16).optional(),
});
const tri = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(tri) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, tri(x)])) : v;

const ParReference = (etape: 2 | 3 | 5 | 6 | 8) => z.strictObject({ etape: z.literal(etape), empreinte_sha256: EMPREINTE, reference: REFERENCE });
const Cadrage = z.strictObject({
  probleme: texte(500),
  declencheur: texte(300),
  minutes_par_element: entier.min(0).max(100_000),
  donnees_personnelles: z.strictObject({ presentes: z.boolean(), categories: z.array(texte(60)).max(10) }).refine((d) => d.presentes || d.categories.length === 0),
});
const Fiche = z.strictObject({ benefice: texte(300), prerequis: texte(300), temps_gagne: texte(300), prix: z.literal("[montant]") });
const CorpsPreuve = z.discriminatedUnion("etape", [
  z.strictObject({ etape: z.literal(1), empreinte_sha256: EMPREINTE, cadrage: Cadrage }),
  ParReference(2),
  ParReference(3),
  z.strictObject({ etape: z.literal(4), empreinte_sha256: EMPREINTE, rapport: Rapport }),
  ParReference(5),
  ParReference(6),
  z.strictObject({ etape: z.literal(7), empreinte_sha256: EMPREINTE, mesure_ms: entier.min(1).max(3_600_000), notes_de_version: texte(2000), fiche: Fiche }),
  ParReference(8),
]);

export interface DemandePreuve {
  etape: number;
  empreinte: string;
  reference: string | null;
  mesureMs: number | null;
  contenu: Record<string, unknown>;
  modeles: string[] | null;
  rapport?: { module: string; version: string; vert: boolean };
}
export function lireDemandePreuve(corps: unknown): DemandePreuve {
  const r = CorpsPreuve.safeParse(corps);
  if (!r.success) throw refus();
  const d = r.data;
  const base = { etape: d.etape, empreinte: d.empreinte_sha256, reference: null, mesureMs: null, contenu: {}, modeles: null };
  if (d.etape === 1) return { ...base, contenu: d.cadrage };
  if (d.etape === 7) return { ...base, mesureMs: d.mesure_ms, contenu: { notes_de_version: d.notes_de_version, fiche: d.fiche } };
  if (d.etape === 4) {
    const rap = d.rapport;
    const vert = rap.codeSortie === 0 && rap.totaux.echoues === 0 && rap.cas.every((c) => c.reussi) && rap.determinisme.every((x) => x.reussi) && rap.hostile.violations === 0;
    return { ...base, reference: `rapport:${createHash("sha256").update(JSON.stringify(tri(rap))).digest("hex")}`, modeles: rap.modeles ?? null, rapport: { module: rap.module, version: rap.version, vert } };
  }
  return { ...base, reference: d.reference };
}

const CorpsPassage = z.strictObject({
  depart: z.enum(STATUTS),
  vers: z.enum(STATUTS),
  empreinte_sha256: EMPREINTE,
  fin_annoncee_le: DATE.optional(),
  remplacante_id: z.uuid().optional(),
  prevenance_le: DATE.optional(),
  signature_production: REFERENCE.optional(),
});
export interface DemandePassage {
  depart: (typeof STATUTS)[number];
  vers: (typeof STATUTS)[number];
  empreinte: string;
  finAnnonceeLe: string | null;
  remplacanteId: string | null;
  prevenanceLe: string | null;
  signatureProduction: string | null;
}
// Chaque champ n'a de sens que pour son passage (comme les contraintes de passages_version) : dépréciation = date de fin ; retrait = remplaçante ET prévenance ; publication = signature de production.
export function lireDemandePassage(corps: unknown): DemandePassage {
  const r = CorpsPassage.safeParse(corps);
  if (!r.success) throw refus();
  const d = r.data;
  const depreciation = d.vers === "depreciee";
  const retrait = d.vers === "retiree";
  if ((d.fin_annoncee_le !== undefined) !== depreciation || (d.remplacante_id !== undefined) !== retrait || (d.prevenance_le !== undefined) !== retrait) throw refus();
  if (d.signature_production !== undefined && d.vers !== "publiee") throw refus();
  return { depart: d.depart, vers: d.vers, empreinte: d.empreinte_sha256, finAnnonceeLe: d.fin_annoncee_le ?? null, remplacanteId: d.remplacante_id ?? null, prevenanceLe: d.prevenance_le ?? null, signatureProduction: d.signature_production ?? null };
}
