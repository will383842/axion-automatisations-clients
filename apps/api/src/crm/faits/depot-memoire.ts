import { empreinteEmail } from "../../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import type { DepotC3, EcartPropose, OrganisationLue, ResultatFait, TxC3 } from "./types.js";

// Dépôt en mémoire pour les essais : même contrat que l'adaptateur SQL, annulation complète si la transaction échoue.
export function depotEnMemoire() {
  const etat = {
    orgs: [] as OrganisationLue[],
    contacts: [] as { orgId: string; email: string }[],
    faits: new Map<string, ResultatFait | null>(),
    exclusions: [] as { orgId: string; empreinte: string }[],
    liens: [] as { orgId: string; crmCompanyId: string; etat: "absorbe"; absorbePar: string }[],
    ecarts: [] as (EcartPropose & { orgId: string })[],
    copies: [] as { orgId: string; copie: object }[],
    apporteurs: [] as { orgId: string; apporteurId: string }[],
    aTrancher: [] as { orgId: string | null; motif: string }[],
  };
  const tx: TxC3 = {
    async rangerFait(f) {
      if (etat.faits.has(f.eventId)) return false;
      etat.faits.set(f.eventId, null);
      return true;
    },
    async marquerTraite(id, r) { etat.faits.set(id, r); },
    async organisationParCrm(id) { return etat.orgs.find((o) => o.crmCompanyId === id) ?? null; },
    async organisationsParSiren(siren) { return etat.orgs.filter((o) => o.siren === siren); },
    async lierCrm(orgId, crm) { const o = etat.orgs.find((x) => x.id === orgId); if (o) o.crmCompanyId = crm; },
    async rangerCopieCrm(orgId, copie) { etat.copies.push({ orgId, copie }); },
    async proposerEcart(orgId, ecart) { etat.ecarts.push({ orgId, ...ecart }); },
    async signalerATrancher(orgId, motif) { etat.aTrancher.push({ orgId, motif }); },
    async noterApporteur(orgId, apporteurId) { etat.apporteurs.push({ orgId, apporteurId }); },
    async absorber(orgId, absorbee, gardee) {
      etat.liens.push({ orgId, crmCompanyId: absorbee, etat: "absorbe", absorbePar: gardee });
      const o = etat.orgs.find((x) => x.id === orgId);
      if (o) o.crmCompanyId = gardee;
    },
    async exclure(empreinte) {
      const clients = [...new Set(etat.contacts.filter((c) => empreinteEmail(c.email) === empreinte).map((c) => c.orgId))];
      for (const orgId of clients) if (!etat.exclusions.some((x) => x.orgId === orgId && x.empreinte === empreinte)) etat.exclusions.push({ orgId, empreinte });
      return clients.length;
    },
    async gardeeDe(crm) { return etat.liens.find((l) => l.crmCompanyId === crm)?.absorbePar ?? null; },
  };
  const depot: DepotC3 = {
    async transaction(fn) {
      const copie = structuredClone({ ...etat, faits: [...etat.faits] });
      try {
        return await fn(tx);
      } catch (e) {
        Object.assign(etat, copie, { faits: new Map(copie.faits) });
        throw e;
      }
    },
  };
  return {
    ...depot,
    ajouterOrganisation: (o: OrganisationLue) => void etat.orgs.push({ ...o }),
    ajouterContact: (orgId: string, email: string) => void etat.contacts.push({ orgId, email }),
    organisations: () => etat.orgs,
    faitsRanges: () => etat.faits.size,
    ecarts: () => etat.ecarts,
    copies: () => etat.copies,
    apporteurs: () => etat.apporteurs,
    liens: () => etat.liens,
    exclusions: (orgId: string) => etat.exclusions.filter((x) => x.orgId === orgId).map((x) => x.empreinte),
    contacts: (orgId: string) => etat.contacts.filter((c) => c.orgId === orgId).map((c) => c.email),
    // Tout ce qui est rangé hors contacts : sert à vérifier qu'aucune adresse en clair n'est conservée.
    tout: () => ({ ...etat, contacts: [] }),
  };
}
