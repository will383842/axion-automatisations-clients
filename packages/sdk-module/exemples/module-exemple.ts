import { z } from "zod";
import { defineAutomation, type Manifeste } from "../src/index.ts";

// Module inventé « accusé de réception » : code commun, sans connecteur réel. Les réglages propres à chaque client viennent de la configuration.
const reglages = z.object({ actionsAutomatiquesAutorisees: z.array(z.string()), objetAccuse: z.string().min(1) });

const cas = (i: number, categorie: "nominal" | "panne" | "email_piege") => ({
  nom: `cas ${i + 1} (${categorie})`,
  categorie,
  entree: { expediteur: `personne${i + 1}@exemple.fr`, objet: `Demande ${i + 1}` },
  attendu: { accuse: categorie === "nominal" },
});

export const manifesteExemple = {
  code: "accuse-reception",
  version: "1.0.0",
  apiMoteur: "^0.1.0",
  reglages,
  declencheurs: [{ type: "sondage", intervalleSecondes: 60, curseur: "dernierMessage" }],
  etapes: [{ nom: "accuser", executer: async () => undefined }],
  connecteurs: [],
  ia: { modelesAdmis: [], unitesParElement: 0, risqueAiAct: "minimal" },
  jeuEssai: Array.from({ length: 20 }, (_, i) => cas(i, i === 18 ? "panne" : i === 19 ? "email_piege" : "nominal")),
  migrer: (depuis: string, anciens: unknown) => ({ ...(anciens as object), migreDepuis: depuis }),
  minutesGagneesParElement: 2,
  ecrans: [{ composant: "TableauSimple", proprietes: { titre: "Accusés envoyés" } }],
  tables: [{ nom: "accuses", migrations: [{ version: 1, instruction: "creer_table_accuses" }] }],
} satisfies Manifeste;

export const moduleExemple = defineAutomation(manifesteExemple);
