import type { AlerteC3, FaitCrm, FaitDe, ResultatFait, TxC3 } from "./types.js";

export interface Issue {
  resultat: ResultatFait;
  alertes: AlerteC3[];
}
type Pour<T extends FaitCrm["event_type"]> = FaitDe<T>;
const nettoyer = (s: string) => s.trim().toLowerCase();

// C-726 : ce fait ne crée AUCUNE organisation. Il lie celle que « Nouveau client » (T3-29) a préparée.
export async function devenueCliente(tx: TxC3, e: Pour<"entreprise.devenue_cliente">): Promise<Issue> {
  const p = e.payload;
  // Le sujet et le contenu doivent désigner la même fiche du CRM : sinon le fait est incohérent, rien n'est lié.
  if (e.subject_ref.crmCompanyId !== p.crmCompanyId) {
    await tx.signalerATrancher(null, "identifiant_crm_incoherent");
    return { resultat: "a_trancher", alertes: [{ type: "ecart_propose", reference: e.subject_ref.crmCompanyId }] };
  }
  const parCrm = await tx.organisationParCrm(p.crmCompanyId);
  if (parCrm) return { resultat: "traite", alertes: [] };
  const parSiren = await tx.organisationsParSiren(p.siren);
  if (parSiren.length === 0) return { resultat: "ignore", alertes: [{ type: "fait_hors_perimetre", reference: p.crmCompanyId }] };
  if (parSiren.length > 1) {
    await tx.signalerATrancher(null, "siren_absent_ressemblance");
    return { resultat: "a_trancher", alertes: [] };
  }
  const org = parSiren[0]!;
  // Un lien CRM existant vers une AUTRE fiche n'est jamais remplacé : l'équipe tranche (proposition d'écart).
  if (org.crmCompanyId !== null && org.crmCompanyId !== p.crmCompanyId) {
    await tx.proposerEcart(org.id, { champ: "lien_crm", valeurHub: org.crmCompanyId, valeurCrm: p.crmCompanyId });
    await tx.signalerATrancher(org.id, "lien_crm_different");
    return { resultat: "a_trancher", alertes: [{ type: "ecart_propose", reference: p.crmCompanyId }] };
  }
  await tx.lierCrm(org.id, p.crmCompanyId);
  return { resultat: "traite", alertes: [] };
}

// C-725 : le Hub fait foi pour l'identité. La valeur du CRM est rangée en copie ; un écart est proposé, jamais appliqué.
export async function miseAJour(tx: TxC3, e: Pour<"entreprise.mise_a_jour">): Promise<Issue> {
  const p = e.payload;
  const org = await tx.organisationParCrm(p.crmCompanyId);
  if (!org) return { resultat: "ignore", alertes: [] };
  await tx.rangerCopieCrm(org.id, { ...(p.raisonSociale !== undefined && { raisonSociale: p.raisonSociale }), ...(p.adresse !== undefined && { adresse: p.adresse }) });
  if (p.raisonSociale !== undefined && nettoyer(p.raisonSociale) !== nettoyer(org.raisonSociale)) {
    await tx.proposerEcart(org.id, { champ: "raison_sociale", valeurHub: org.raisonSociale, valeurCrm: p.raisonSociale });
    return { resultat: "traite", alertes: [{ type: "ecart_propose", reference: p.crmCompanyId }] };
  }
  return { resultat: "traite", alertes: [] };
}

export async function apporteurRattache(tx: TxC3, e: Pour<"apporteur.rattache">): Promise<Issue> {
  const org = await tx.organisationParCrm(e.payload.crmCompanyId);
  if (!org) return { resultat: "ignore", alertes: [] };
  await tx.noterApporteur(org.id, e.payload.apporteurId);
  return { resultat: "traite", alertes: [] };
}

export async function ficheFusionnee(tx: TxC3, e: Pour<"fiche.fusionnee">): Promise<Issue> {
  const { crmCompanyIdAbsorbee: absorbee, crmCompanyIdGardee: gardee } = e.payload;
  const org = await tx.organisationParCrm(absorbee);
  if (!org) return { resultat: "ignore", alertes: [] };
  // La fiche gardée a déjà une autre organisation : deux fiches de la console pour une seule du CRM, l'équipe tranche.
  const autre = await tx.organisationParCrm(gardee);
  if (autre && autre.id !== org.id) {
    await tx.signalerATrancher(org.id, "fiche_absorbee");
    return { resultat: "a_trancher", alertes: [] };
  }
  await tx.absorber(org.id, absorbee, gardee);
  return { resultat: "traite", alertes: [] };
}
