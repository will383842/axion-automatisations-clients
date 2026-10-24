import { z } from "zod";
import { Connecteur } from "./connecteurs.ts";
import { Declencheur } from "./declencheurs.ts";
import { Etape } from "./etapes.ts";
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

const ManifesteSchema = z
  .object({
    code: z.string().regex(CODE, "code invalide").refine((c) => !CODE_CLIENT.test(c), "code propre à un client"),
    version: z.string().regex(SEMVER, "version semver invalide"),
    apiMoteur: z.string().regex(/\d/, "plage semver attendue"),
    reglages: Reglages,
    declencheurs: z.array(Declencheur).min(1),
    etapes: z.array(Etape).min(1),
    connecteurs: z.array(Connecteur),
    ia: Ia,
    jeuEssai: z
      .array(Cas)
      .min(20, "jeuEssai : 20 cas au moins")
      .refine((l) => l.some((c) => c.categorie === "panne") && l.some((c) => c.categorie === "email_piege"), "jeuEssai : une panne et un e-mail piégé au moins"),
    migrer: Fonction<(depuis: string, reglages: unknown) => unknown>(),
    minutesGagneesParElement: z.number().int().nonnegative(),
    ecrans: z.array(Ecran),
    tables: z.array(Table),
  })
  .strict();

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
