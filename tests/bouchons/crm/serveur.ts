import { EvenementConsole } from "../../../packages/contrats/src/c3/evenements-console-vers-crm.ts";
import { EvenementCrm, identifiantEvenementC3 } from "../../../packages/contrats/src/c3/evenements-crm-vers-console.ts";
import { CHEMIN_LECTURE, LectureRequete, type LectureReponse } from "../../../packages/contrats/src/c3/lecture-entreprise.ts";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { demarrerNoyau, erreur, pousserSigne } from "../hub/noyau.ts";

export interface EntrepriseCrm {
  siren: string;
  crmCompanyId: string;
  raisonSociale: string;
  absorbeePar?: string;
}
export interface OptionsCrm {
  cles: Record<string, string>;
  entreprises?: EntrepriseCrm[];
  maintenant?: () => number;
}
export type BouchonCrm = Awaited<ReturnType<typeof demarrerBouchonCrm>>;

export const CHEMIN_EVENEMENTS_CONSOLE = "/api/console/v1/evenements";

// Même principe que le bouchon du Hub, pour C3 : lecture, faits reçus de la console, faits poussés vers la console.
export async function demarrerBouchonCrm(options: OptionsCrm) {
  const entreprises = options.entreprises ?? [];
  let sequence = 0;
  const noyau = await demarrerNoyau({
    ...options,
    traiter: (r, noter) => {
      if (r.methode === "GET" && r.chemin === CHEMIN_LECTURE) {
        const lu = LectureRequete.safeParse(Object.fromEntries(r.requete));
        if (!lu.success) return erreur("schema_invalide", "Un SIREN ou un SIRET, et un seul.");
        const siren = "siren" in lu.data ? lu.data.siren : undefined;
        const e = entreprises.find((x) => x.siren === siren);
        if (!e) return erreur("introuvable", "Entreprise inconnue.");
        const corps: LectureReponse = {
          crmCompanyId: e.crmCompanyId,
          raisonSociale: e.raisonSociale,
          adresse: { ligne1: "1 rue d'essai", codePostal: "75001", ville: "Ville-Test", pays: "FR" },
          siretEtablissement: `${e.siren}00017`,
          ...(e.absorbeePar ? { absorbeePar: e.absorbeePar } : {}),
        };
        return { statut: 200, corps };
      }
      if (r.methode === "POST" && r.chemin === CHEMIN_EVENEMENTS_CONSOLE) {
        if (!EvenementConsole.safeParse(r.corps).success) return erreur("schema_invalide", "Événement hors schéma C3.");
        noter("evenement-console", r.corps);
        return { statut: 200, corps: { recu: true } };
      }
      return erreur("action_interdite", "Route absente de C3.");
    },
  });
  return {
    ...noyau,
    // Pousse un fait CRM → console (dont consentement.retire et fiche.fusionnee) avec event_id et sequence.
    async pousser(url: string, ident: { cle: string; secret: string }, f: { type: string; crmCompanyId: string; payload: unknown }) {
      sequence += 1;
      const maintenant = new Date().toISOString();
      const evenement = EvenementCrm.parse({
        event_id: identifiantEvenementC3(f.type, `${f.crmCompanyId}:${sequence}`),
        schema_version: 1,
        event_type: f.type,
        occurred_at: maintenant,
        emitted_at: maintenant,
        producer: "axion-crm",
        subject_ref: { crmCompanyId: f.crmCompanyId },
        sequence,
        payload: f.payload,
      });
      return pousserSigne(url, ident, evenement, { cleIdempotence: cleDIntention("crm-fait", evenement.event_id) });
    },
  };
}
