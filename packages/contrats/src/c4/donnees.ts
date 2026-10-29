import { z } from "zod";

// C4 0.4.0 (révision additive, ADR 0043) : ce qu'un module déclare pour être une petite application.
// Aucun champ de 0.3.0 n'est touché. Le SQL n'est jamais exécuté d'après ce schéma : il en fixe la forme ;
// la vraie vérification (schéma a_<code> seul en écriture, commun en lecture) est faite à l'import (T4-50).

// Même motif que Bouton.action des écrans : tirets, jamais de soulignés.
export const NOM_DECLARE = /^[a-z][a-z0-9-]{1,40}$/;
export const NomDeclare = z.string().regex(NOM_DECLARE);

export const MODES_IA = ["client_direct", "via_axion"] as const;
export const ModeIa = z.enum(MODES_IA);
export const ROLES_PORTAIL = ["administrateur", "utilisateur", "lecture", "comptable"] as const;
// Absence de ia.modes : le trafic passe par AXION.
export const MODES_IA_PAR_DEFAUT: readonly (typeof MODES_IA)[number][] = ["via_axion"];

const Entier = z.number().int().positive();
export const GardeIa = z
  .object({ appelsMaxParExecution: Entier, appelsMaxParElement: Entier, appelsMaxParMinute: Entier })
  .partial()
  .strict();

// SQL paramétré : des $1…$n et rien d'autre (ni littéral, ni commentaire, ni seconde instruction).
const ECRITURE = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call|do)\b/i;
const Sql = z
  .string()
  .min(1)
  .max(4000)
  .refine((s) => !/[;']|--|\/\*|\$(?!\d)/.test(s), "sql : paramètres $1…$n seulement, ni littéral, ni commentaire, ni point-virgule");

const Parametres = z
  .object({ type: z.literal("object"), properties: z.record(z.string().max(60), z.json()), required: z.array(z.string().max(60)).max(30).optional(), additionalProperties: z.literal(false) })
  .strict();

const Colonne = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const base = {
  nom: NomDeclare,
  parametres: Parametres,
  sql: Sql,
  colonnes: z.array(Colonne).min(1).max(30),
  // Une lecture de liste se pagine toujours par curseur (jamais de page sans borne).
  liste: z.boolean(),
  pagination: z.object({ curseur: Colonne }).strict().optional(),
  parEtablissement: z.boolean(),
  permission: NomDeclare.optional(),
};
const pagineeSiListe = (d: { liste: boolean; pagination?: unknown }, ctx: z.RefinementCtx) => {
  if (d.liste && !d.pagination) ctx.addIssue({ code: "custom", path: ["pagination"], message: "pagination par curseur obligatoire pour une liste" });
};

export const Requete = z
  .object({ ...base, mode: z.literal("lecture") })
  .strict()
  .superRefine(pagineeSiListe)
  .superRefine((d, ctx) => {
    if (ECRITURE.test(d.sql)) ctx.addIssue({ code: "custom", path: ["sql"], message: "sql : une requête de lecture n'écrit pas" });
  });

export const Action = z
  .object({ ...base, mode: z.enum(["lecture", "ecriture"]), historique: z.boolean().optional() })
  .strict()
  .superRefine(pagineeSiListe)
  .superRefine((d, ctx) => {
    // C-625 : la ligne d'historique est écrite par le port, jamais par le SQL du module.
    if (d.mode === "ecriture" && d.historique !== true) ctx.addIssue({ code: "custom", path: ["historique"], message: "historique: true obligatoire pour une écriture" });
    if (d.mode === "lecture" && ECRITURE.test(d.sql)) ctx.addIssue({ code: "custom", path: ["sql"], message: "sql : une action en lecture n'écrit pas" });
  });

export const Donnees = z.object({ requetes: z.array(Requete).max(50).default([]), actions: z.array(Action).max(50).default([]) }).strict();

export const Permission = z
  .object({ nom: NomDeclare, libelle: z.string().min(1).max(120), parDefaut: z.array(z.enum(ROLES_PORTAIL)).max(ROLES_PORTAIL.length) })
  .strict();
// Fonction d'usage : ce que l'état voulu d'une instance peut ouvrir (droitsUsage).
export const Fonction = z.object({ nom: NomDeclare, libelle: z.string().min(1).max(120) }).strict();
