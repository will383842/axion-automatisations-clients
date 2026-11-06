import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { echeance, type EtapeFin } from "./machine.js";
import { etatPreuve } from "./preavis.js";

// Mise à l'écart à J+30 (C-035, C-567). RIEN n'est détruit : la base, le compartiment, les sauvegardes et la clé du client sont gardés ; le client n'y a plus accès.
// La clé de chiffrement (T1A-06) n'a aucun port ici : ce fichier ne peut pas la toucher (A-245).

// Une confirmation ou une décision de Will ou du second administrateur, avec la preuve de sa réauthentification (jeton Keycloak de moins de 5 minutes, T1A-08).
export interface Validation { tenantId: string; acteur: string; role: string; a: Date; reauthLe: Date | null; jetonId: string }
export const FENETRE_REAUTH_MS = 5 * 60_000;
export const ECART_MINIMAL_MS = 24 * 3_600_000;

export const reauthentificationFraiche = (reauthLe: Date | null, a: Date): boolean => reauthLe !== null && reauthLe.getTime() <= a.getTime() && a.getTime() - reauthLe.getTime() <= FENETRE_REAUTH_MS;

// Double validation (C-567, appliquée aussi à l'effacement au titre de C-623) : deux validations de Will séparées de 24 heures au moins, OU une de Will et une du second administrateur.
// Ne comptent pas : un autre client, un rôle inconnu, une réauthentification absente ou trop ancienne, un jeton déjà vu (rejeu), le second administrateur qui serait Will.
export function doubleValidationAtteinte(tenantId: string, validations: Validation[]): boolean {
  const vus = new Set<string>();
  const valables = validations.filter((v) => {
    if (v.tenantId !== tenantId || (v.role !== "will" && v.role !== "second_administrateur") || v.acteur.trim() === "" || v.jetonId.trim() === "" || vus.has(v.jetonId)) return false;
    vus.add(v.jetonId);
    return reauthentificationFraiche(v.reauthLe, v.a);
  });
  const will = valables.filter((v) => v.role === "will").map((v) => v.a.getTime());
  const seconds = valables.filter((v) => v.role === "second_administrateur");
  const estSeconde = seconds.some((s) => valables.some((w) => w.role === "will" && w.acteur !== s.acteur));
  return estSeconde || (will.length >= 2 && Math.max(...will) - Math.min(...will) >= ECART_MINIMAL_MS);
}

type Retrait = (tenantId: string) => Promise<void>;
// Chaque retrait est rejouable. L'ordre est celui de la fiche ; marquerALEcart vient en dernier, donc une reprise après panne refait tout ce qui manque.
export interface PortsEcart {
  gel: Pick<GelLitige, "gelActif">;
  validations(tenantId: string): Promise<Validation[]>;
  etatBase(tenantId: string): Promise<string | undefined>;
  retirerPgBouncer: Retrait;
  revoquerConnect: Retrait;
  lectureSeuleCompartiment: Retrait;
  desactiverIdentifiants: Retrait;
  desactiverCleIa: Retrait;
  marquerALEcart: Retrait;
  alerter(a: { type: string; clientId: string; code: string }): Promise<void>;
  tracer(e: Record<string, unknown>): Promise<void>;
  maintenant(): Date;
}

export function etapeMiseALEcart(p: PortsEcart): EtapeFin {
  return {
    nom: "mise_a_l_ecart",
    sousGel: true,
    echeance: (d) => echeance(d.dateFin, 30),
    dejaFait: async (t) => (await p.etatBase(t)) === "a_l_ecart",
    async faire(t, d) {
      await exigerAucunGel(p.gel, t, "mise_a_l_ecart");
      // Trois préavis PROUVÉS : envoyé sans accusé ne suffit pas (dette T2-44). L'attente est signalée, la base reste gelée et lisible pour l'export.
      for (const jour of [1, 20, 27] as const) {
        if (etatPreuve(d.preavis[jour]) !== "prouve") {
          await p.alerter({ type: "fin_de_contrat", clientId: t, code: `preavis_j${jour}_sans_accuse` });
          return;
        }
      }
      if (d.exportReference === null) return;
      const validations = await p.validations(t);
      if (!doubleValidationAtteinte(t, validations)) {
        await p.alerter({ type: "fin_de_contrat", clientId: t, code: `confirmation_mise_a_l_ecart_attendue_${p.maintenant().toISOString().slice(0, 10)}` });
        return;
      }
      // Relu juste avant d'agir : un gel posé depuis les lectures ci-dessus l'emporte.
      await exigerAucunGel(p.gel, t, "mise_a_l_ecart");
      for (const retrait of [p.retirerPgBouncer, p.revoquerConnect, p.lectureSeuleCompartiment, p.desactiverIdentifiants, p.desactiverCleIa, p.marquerALEcart]) await retrait(t);
      await p.tracer({ type: "mise_a_l_ecart", tenantId: t });
    },
  };
}
