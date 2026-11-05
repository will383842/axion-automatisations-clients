import { z } from "zod";
import { Forme, Parametres, sansProto, verifierCoherence } from "./forme.ts";

// C4 0.4.0 (révision additive, ADR 0043) puis 0.5.0 (ADR 0109, ADR 0112) : ce qu'un module déclare pour être une petite application.
// 0.5.0 retire le texte SQL : une requête est une forme (forme.ts), lecture seule de `commun`, aucune action.
// La vérification contre le modèle des bases clients est faite à l'import (T4-50c).

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

const MSG_SQL = "C4 0.5.0 : sql retiré (ADR 0109), déclarer une forme";
// looseObject : manifeste.ts lit nom et permission des éléments, qui ne peuvent pourtant pas exister (max 0).
const MSG_ACTIONS = "C4 0.5.0 : aucune action déclarable, l'écriture est fermée (ADR 0109)";
// Une requête = un nom, la lecture, des paramètres typés et une forme ; rien d'autre (ni sql, ni colonnes, ni liste, ni pagination, ni parEtablissement).
export const Requete = z
  .strictObject(
    { nom: NomDeclare, mode: z.literal("lecture"), parametres: Parametres, forme: Forme, permission: NomDeclare.optional() },
    { error: (i) => (i.code === "unrecognized_keys" && i.keys.includes("sql") ? MSG_SQL : undefined) },
  )
  .superRefine((r, ctx) => verifierCoherence(r.parametres, r.forme, (message) => ctx.addIssue({ code: "custom", message })));

// `actions` reste dans la forme pour que 0.4.0 ait une réponse claire, mais doit être vide : aucune écriture déclarée.
const DonneesStricte = z.strictObject({ requetes: z.array(Requete).max(50).default([]), actions: z.array(z.looseObject({ nom: z.string(), permission: z.string().optional() })).max(0, MSG_ACTIONS).default([]) });
// Clé « __proto__ » propre refusée à tout niveau, jamais ignorée.
export const Donnees = z.unknown().refine(sansProto, "clé réservée").pipe(DonneesStricte);

export const Permission = z
  .object({ nom: NomDeclare, libelle: z.string().min(1).max(120), parDefaut: z.array(z.enum(ROLES_PORTAIL)).max(ROLES_PORTAIL.length) })
  .strict();
// Fonction d'usage : ce que l'état voulu d'une instance peut ouvrir (droitsUsage).
export const Fonction = z.object({ nom: NomDeclare, libelle: z.string().min(1).max(120) }).strict();
