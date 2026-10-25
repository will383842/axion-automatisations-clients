import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ACTIONS_MESSAGERIE } from "../capacites.ts";
import { ErreurConnecteur } from "../erreurs.ts";
import { declarer } from "../famille.ts";
import { verifierMessageId, type ConnecteurMessagerie } from "../familles/messagerie.ts";
import { creerJeton } from "../jeton.ts";
import type { Banc, Fabrique, Scenario } from "./messagerie.ts";

const Appel = z
  .object({
    methode: z.enum(["listerNouveaux", "lire", "etiqueter", "creerBrouillon", "envoyer"]),
    reponse: z.unknown().optional(),
    erreur: z.object({ classe: z.string(), code: z.string(), reprise: z.string().optional() }).strict().optional(),
  })
  .strict();
const Enregistrement = z.object({ nom: z.string(), appels: z.array(Appel), envoyes: z.number().int().min(0) }).strict();
export type Enregistrement = z.infer<typeof Enregistrement>;

export function chargerEnregistrement(nom: string): Enregistrement {
  if (!/^[a-z0-9_]+$/.test(nom)) throw new Error("nom d'enregistrement invalide");
  const chemin = fileURLToPath(new URL(`./enregistrements/messagerie/${nom}.json`, import.meta.url));
  return Enregistrement.parse(JSON.parse(readFileSync(chemin, "utf8")));
}

// Rejoue les réponses dans l'ordre ; un appel hors ordre ou en trop est une erreur definitive.
export const fabriqueRejouee: Fabrique = (s: Scenario): Banc => {
  const enreg = chargerEnregistrement(s.nom);
  const file = [...enreg.appels];
  const rejouer = (methode: string) => {
    const a = file.shift();
    if (!a || a.methode !== methode) throw new ErreurConnecteur("definitive", "appel_hors_enregistrement");
    if (a.erreur) throw new ErreurConnecteur(a.erreur.classe as never, a.erreur.code, a.erreur.reprise ? { reprise: a.erreur.reprise } : {});
    return a.reponse as never;
  };
  const exiger = (m: { messageId: string }) => {
    try { verifierMessageId(m.messageId); } catch { throw new ErreurConnecteur("definitive", "message_id_invalide"); }
  };
  const connecteur: ConnecteurMessagerie = {
    declaration: declarer({
      famille: "messagerie", outil: "enregistre", version: "1.0.0", portees: ["messagerie.lecture"],
      capacites: ACTIONS_MESSAGERIE.map((action) => ({ action, garantie: "verifiable_apres_coup" })),
    }),
    listerNouveaux: async () => rejouer("listerNouveaux"),
    lire: async () => rejouer("lire"),
    etiqueter: async () => rejouer("etiqueter"),
    creerBrouillon: async (_j, m) => (exiger(m), rejouer("creerBrouillon")),
    envoyer: async (_j, m) => (exiger(m), rejouer("envoyer")),
  };
  return { connecteur, jeton: creerJeton("jeton-fictif", Date.now() + 60_000), valeurJeton: "jeton-fictif", envoyes: () => enreg.envoyes };
};
