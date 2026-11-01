import { z } from "zod";
import { Connecteur } from "./connecteurs.ts";
import { Declencheur } from "./declencheurs.ts";
import { Etape } from "./etapes.ts";
import { Donnees, Fonction as FonctionUsage, GardeIa, MODES_IA_PAR_DEFAUT, ModeIa, Permission } from "../../contrats/src/c4/donnees.ts";
import { Ia } from "./ia.ts";

// Un module = code commun versionné + réglages par client. Le manifeste est strict (aucune clé
// inconnue) et son code ne peut pas porter un identifiant de client : jamais de code propre à un client.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CODE = /^[a-z][a-z0-9-]{1,62}$/;
const CODE_CLIENT = /(^|-)(cli|axi-cli|client)(-|$)|\d{9}/;

const Cas = z
  .object({ nom: z.string().min(1), categorie: z.enum(["nominal", "panne", "email_piege"]), entree: z.json(), attendu: z.json() })
  .strict();
const Ecran = z.object({ composant: z.string().min(1), proprietes: z.record(z.string(), z.json()) }).strict();
const Table = z
  .object({ nom: z.string().min(1), migrations: z.array(z.object({ version: z.number().int().positive(), instruction: z.string().min(1) }).strict()).min(1) })
  .strict();
const Fonction = <T extends (...a: never[]) => unknown>() => z.custom<T>((v) => typeof v === "function");
const Reglages = z.custom<z.ZodObject>((v) => v instanceof z.ZodObject && "actionsAutomatiquesAutorisees" in v.shape, "actionsAutomatiquesAutorisees obligatoire dans reglages");

// 0.4.0 (additif) : modes absent = via_axion ; garde absente = bornes de la plateforme ; utilise est déclaré par le module, jamais déduit.
const Ia04 = Ia.extend({ modes: z.array(ModeIa).min(1).default([...MODES_IA_PAR_DEFAUT]), garde: GardeIa.optional(), utilise: z.boolean().optional() });
const doublon = (noms: string[]) => noms.find((n, i) => noms.indexOf(n) !== i);

const ManifesteSchema = z
  .object({
    code: z.string().regex(CODE, "code invalide").refine((c) => !CODE_CLIENT.test(c), "code propre à un client"),
    version: z.string().regex(SEMVER, "version semver invalide"),
    apiMoteur: z.string().regex(/\d/, "plage semver attendue"),
    reglages: Reglages,
    declencheurs: z.array(Declencheur).min(1),
    etapes: z
      .array(Etape)
      .min(1)
      .superRefine((l, ctx) => {
        const double = l.map((e) => e.nom).find((n, i, noms) => noms.indexOf(n) !== i);
        if (double) ctx.addIssue({ code: "custom", message: `deux étapes portent le même nom : ${double}` });
      }),
    connecteurs: z.array(Connecteur).superRefine((l, ctx) => {
      const actions = l.flatMap((c) => c.actions);
      const double = actions.find((a, i) => actions.indexOf(a) !== i);
      if (double) ctx.addIssue({ code: "custom", message: `action déclarée par deux connecteurs : ${double}` });
    }),
    ia: Ia04,
    jeuEssai: z
      .array(Cas)
      .min(20, "jeuEssai : 20 cas au moins")
      .refine((l) => l.some((c) => c.categorie === "panne") && l.some((c) => c.categorie === "email_piege"), "jeuEssai : une panne et un e-mail piégé au moins"),
    migrer: Fonction<(depuis: string, reglages: unknown) => unknown>(),
    minutesGagneesParElement: z.number().int().nonnegative(),
    ecrans: z.array(Ecran),
    tables: z.array(Table),
    donnees: Donnees.optional(),
    permissions: z.array(Permission).max(50).optional(),
    fonctions: z.array(FonctionUsage).max(50).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const erreur = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const requetes = m.donnees?.requetes ?? [];
    const actions = m.donnees?.actions ?? [];
    const permissions = (m.permissions ?? []).map((p) => p.nom);
    const nomsDonnees = [...requetes, ...actions].map((d) => d.nom);
    if (doublon(nomsDonnees)) erreur(["donnees"], `deux requêtes ou actions portent le même nom : ${doublon(nomsDonnees)}`);
    if (doublon(permissions)) erreur(["permissions"], `deux permissions portent le même nom : ${doublon(permissions)}`);
    if (doublon((m.fonctions ?? []).map((f) => f.nom))) erreur(["fonctions"], "deux fonctions portent le même nom");
    [...requetes, ...actions].forEach((d, i) => {
      if (d.permission && !permissions.includes(d.permission)) erreur(["donnees", i < requetes.length ? "requetes" : "actions", i < requetes.length ? i : i - requetes.length, "permission"], `permission non déclarée : ${d.permission}`);
    });
    m.ecrans.forEach((e, i) => {
      const { source, action } = e.proprietes as { source?: unknown; action?: unknown };
      if (source !== undefined && !requetes.some((r) => r.nom === source)) erreur(["ecrans", i, "proprietes", "source"], "source non déclarée dans donnees.requetes");
      // Une action de Bouton sans `donnees` reste valide (0.3.0) ; dès que le module déclare des données, elle doit y figurer.
      if (action !== undefined && m.donnees && !actions.some((a) => a.nom === action)) erreur(["ecrans", i, "proprietes", "action"], "action non déclarée dans donnees.actions");
    });
  });

export type Manifeste = z.input<typeof ManifesteSchema>;

function figer<T>(v: T): T {
  // Le schéma Zod garde des caches internes : on ne le fige pas.
  if (!v || typeof v !== "object" || v instanceof z.ZodType) return v;
  for (const x of Object.values(v)) figer(x);
  return Object.freeze(v);
}

export function defineAutomation(manifeste: Manifeste) {
  const lecture = ManifesteSchema.safeParse(manifeste);
  if (!lecture.success) {
    throw new Error(`manifeste refusé : ${lecture.error.issues.map((i) => `${i.path.join(".") || "(racine)"} ${i.message}`).join(" ; ")}`);
  }
  const m = lecture.data;
  const schemaReglages = z.toJSONSchema(m.reglages, { target: "draft-2020-12" });
  const instancier = (valeurs: unknown) => figer(m.reglages.parse(valeurs) as Record<string, unknown> & { actionsAutomatiquesAutorisees: string[] });
  // C-539 : une action hors de la liste du client part en brouillon.
  const classerAction = (reglages: { actionsAutomatiquesAutorisees: readonly string[] }, action: string) =>
    reglages.actionsAutomatiquesAutorisees.includes(action) ? ("automatique" as const) : ("brouillon" as const);
  return figer({ ...m, paquet: `@axion-auto/${m.code}`, schemaReglages, instancier, classerAction });
}
