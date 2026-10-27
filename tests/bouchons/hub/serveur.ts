import { PREFIXE_C1, ROUTES_C1, type RouteC1 } from "../../../packages/contrats/src/c1/routes.ts";
import { verifierLigneDevis } from "../../../packages/contrats/src/c1/regles.ts";
import { Fait } from "../../../packages/contrats/src/c2/faits.ts";
import { cleDIntention } from "../../../packages/contrats/src/commun/idempotence.ts";
import { demarrerNoyau, erreur, pousserSigne, type Reponse, type Requete } from "./noyau.ts";

export interface FicheHub {
  siren: string;
  axiCli: string;
  raisonSociale: string;
  absorbeePar?: string;
}
export interface OptionsHub {
  cles: Record<string, string>;
  fiches?: FicheHub[];
  maintenant?: () => number;
}
export type BouchonHub = Awaited<ReturnType<typeof demarrerBouchonHub>>;

// Champs lus dans les corps déjà validés par les schémas de C1.
interface Corps {
  siren?: string;
  raisonSociale: string;
  consoleClientId: string;
  statut: string;
  lignes: Array<{ activite: string; tauxTvaBps: number }>;
  depuis: string;
  apres: string;
}

const normaliser = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
// Raison sociale « proche » : l'une contient l'autre une fois accents et ponctuation retirés.
const proche = (a: string, b: string) => normaliser(a).includes(normaliser(b)) || normaliser(b).includes(normaliser(a));

// Le bouchon n'importe rien de l'API : il ne s'appuie que sur packages/contrats.
export async function demarrerBouchonHub(options: OptionsHub) {
  const fiches = [...(options.fiches ?? [])];
  const consoleIds = new Map<string, string>();
  const faits: Fait[] = [];
  const sequences = new Map<string, number>();
  let compteur = 100;
  let devis = 0;

  const itineraires = Object.entries(ROUTES_C1).map(([nom, route]) => ({
    nom,
    route: route as RouteC1,
    motif: new RegExp(`^${(PREFIXE_C1 + route.chemin).replace(/\{[^}]+\}/g, "([^/]+)")}$`),
  }));

  const noyau = await demarrerNoyau({
    ...options,
    traiter: (r: Requete, noter): Reponse => {
      const trouve = itineraires.find((i) => i.route.methode === r.methode && i.motif.test(r.chemin));
      if (!trouve) return erreur("action_interdite", "Route absente de C1.");
      const params = trouve.motif.exec(r.chemin)?.slice(1) ?? [];
      const entree = trouve.route.methode === "GET" ? Object.fromEntries(r.requete) : r.corps;
      const lu = trouve.route.requete?.safeParse(entree);
      if (lu && !lu.success) return erreur("schema_invalide", "Requête hors schéma.");
      const d = (lu?.data ?? {}) as unknown as Corps;
      const fait = (corps: unknown, statut = 200): Reponse => {
        noter(trouve.nom, entree);
        return { statut, corps };
      };
      switch (trouve.nom) {
        case "clients-retrouver-ou-creer": {
          const connue = fiches.find((f) => f.siren === d.siren);
          if (connue?.absorbeePar) return erreur("fiche_absorbee", "Fiche absorbée par une fusion.");
          if (connue) return { statut: 200, corps: { resultat: "retrouve", axiCli: connue.axiCli } };
          if (!d.siren && fiches.some((f) => proche(f.raisonSociale, d.raisonSociale))) {
            noter(trouve.nom, entree);
            return { statut: 202, corps: { resultat: "a_trancher", idDemande: `demande-${++compteur}` } };
          }
          const axiCli = `AXI-CLI-${String(++compteur).padStart(6, "0")}`;
          if (d.siren) fiches.push({ siren: d.siren, axiCli, raisonSociale: d.raisonSociale });
          return fait({ resultat: "cree", axiCli });
        }
        case "clients-statut": {
          const fiche = fiches.find((f) => f.axiCli === params[0]);
          if (!fiche) return erreur("introuvable", "Fiche inconnue.");
          if (fiche.absorbeePar) return erreur("fiche_absorbee", "Fiche absorbée par une fusion.");
          const porteur = consoleIds.get(d.consoleClientId);
          if (porteur && porteur !== fiche.axiCli) return erreur("identifiant_deja_pris", "consoleClientId déjà porté par une autre fiche.");
          consoleIds.set(d.consoleClientId, fiche.axiCli);
          return fait({ axiCli: fiche.axiCli, statut: d.statut });
        }
        case "devis": {
          const refus = d.lignes.map(verifierLigneDevis).find(Boolean);
          if (refus) return erreur(refus.code, "Taux de TVA interdit.");
          return fait({ numeroDevis: `AXI-DEV-${String(++devis).padStart(6, "0")}` }, 201);
        }
        case "plans-recurrents":
          return fait({ idPlan: `plan-${++compteur}` }, 201);
        case "plans-recurrents-clore":
          return fait({ idPlan: params[0], brouillonsNonEmis: [] });
        case "factures-ponctuelles":
          return fait({ idBrouillon: `brouillon-${++compteur}` }, 201);
        case "statuts":
          return { statut: 200, corps: { elements: [], curseur: d.depuis } };
        case "clients-apporteurs":
          return { statut: 200, corps: { apporteurs: [] } };
        default:
          return { statut: 200, corps: { faits: faits.filter((f) => f.sequence > Number(d.apres)) } };
      }
    },
  });

  return {
    ...noyau,
    // Pousse un fait C2 vers `url`, avec event_id (UUID v4 dérivé) et sequence croissante par sujet.
    async pousser(url: string, ident: { cle: string; secret: string }, f: { type: string; axiCli: string; payload: unknown }) {
      const sequence = (sequences.get(f.axiCli) ?? 0) + 1;
      sequences.set(f.axiCli, sequence);
      const maintenant = new Date().toISOString();
      const fait = Fait.parse({
        event_id: cleDIntention(`hub:${f.type}`, `${f.axiCli}:${sequence}`),
        schema_version: 1,
        event_type: f.type,
        occurred_at: maintenant,
        emitted_at: maintenant,
        producer: "axion-ia-hub",
        subject_ref: { axiCli: f.axiCli },
        sequence,
        payload: f.payload,
      });
      faits.push(fait);
      return pousserSigne(url, ident, fait);
    },
  };
}
