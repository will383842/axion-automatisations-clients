import { EnvoiRefuse, type creerExpediteur } from "../courriel/expediteur.js";
import { idTache } from "../files/files.js";

// Résumé hebdomadaire (B-186), INERTE : la ligne « resumeHebdomadaire » n'est pas dans la table des envois (décision D2 de Will) et aucun texte n'existe au catalogue,
// donc l'expéditeur refuse tout envoi. Les sources sont des ports : source absente ou en échec = rubrique omise, jamais un 0 inventé.
export interface PortsResume {
  // Lignes réservées « resume_hebdomadaire » (une par utilisateur qui a fait un choix).
  preferences(): Promise<{ tenantId: string; utilisateur: string; resumeHebdomadaire: boolean }[]>;
  heuresGagnees(tenantId: string): Promise<number | undefined>;
  enAttente(tenantId: string, utilisateur: string): Promise<number | undefined>;
  incidents(tenantId: string): Promise<number | undefined>;
}
export interface Rubriques { heuresGagnees?: number; enAttente?: number; incidents?: number }
export interface ResumePrepare { tenantId: string; utilisateur: string; semaine: string; jobId: string; rubriques: Rubriques }

// Semaine ISO « AAAA-Sss » du jour donné (UTC).
export function semaineIso(jour: Date): string {
  const d = new Date(Date.UTC(jour.getUTCFullYear(), jour.getUTCMonth(), jour.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const debut = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-S${String(Math.ceil(((d.getTime() - debut) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

const lire = async (source: () => Promise<number | undefined>): Promise<number | undefined> => {
  try {
    const v = await source();
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  } catch {
    return undefined;
  }
};

export async function preparerResumes(lundi: Date, ports: PortsResume): Promise<ResumePrepare[]> {
  const semaine = semaineIso(lundi);
  const resumes: ResumePrepare[] = [];
  for (const p of await ports.preferences()) {
    if (p.resumeHebdomadaire !== true) continue;
    const [heuresGagnees, enAttente, incidents] = await Promise.all([lire(() => ports.heuresGagnees(p.tenantId)), lire(() => ports.enAttente(p.tenantId, p.utilisateur)), lire(() => ports.incidents(p.tenantId))]);
    const rubriques: Rubriques = { ...(heuresGagnees === undefined ? {} : { heuresGagnees }), ...(enAttente === undefined ? {} : { enAttente }), ...(incidents === undefined ? {} : { incidents }) };
    resumes.push({ tenantId: p.tenantId, utilisateur: p.utilisateur, semaine, jobId: idTache({ tenantId: p.tenantId, type: "resume_hebdo", cle: `${p.utilisateur}:${semaine}` }), rubriques });
  }
  return resumes;
}

// Envoi par l'expéditeur des clients, qui refuse tant que la ligne et le texte n'existent pas. Dette : envoyerAuClient n'a pas de ciblage par utilisateur.
export async function expedierResumes(resumes: readonly ResumePrepare[], expediteur: Pick<ReturnType<typeof creerExpediteur>, "envoyerAuClient">): Promise<{ envoyes: number; refuses: number }> {
  let envoyes = 0;
  let refuses = 0;
  for (const r of resumes) {
    try {
      await expediteur.envoyerAuClient("resumeHebdomadaire", { tenantId: r.tenantId, role: "administrateur_client" }, {});
      envoyes++;
    } catch (e) {
      if (!(e instanceof EnvoiRefuse)) throw e;
      refuses++;
    }
  }
  return { envoyes, refuses };
}
