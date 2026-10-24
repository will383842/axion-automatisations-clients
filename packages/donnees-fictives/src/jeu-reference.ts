import { creerGenerateur, type Generateur } from "./graine.js";
import { genererAdresse, genererCourrielEntreprise, genererNaf, genererRaisonSociale, genererTelephone, type Adresse } from "./entreprises.js";
import { genererPersonne, type Personne } from "./personnes.js";
import { genererSiren, genererSiret } from "./siren.js";

// Jeu de référence (plan 4 bis.1) : tout est FICTIF, montants en centimes entiers.
export const FORMULES = ["abonnement-mensuel", "6-mois", "12-mois"] as const;
export type Formule = (typeof FORMULES)[number];
export type StatutFacture = "payee" | "en-retard" | "impayee";

export type Entreprise = {
  id: string;
  raisonSociale: string;
  source: "hub" | "crm" | "console";
  siren?: string;
  siret?: string;
  naf: string;
  adresse: Adresse;
  email: string;
  telephone: string;
  contacts: Personne[];
  identifiantConsole?: string;
  doublonDe?: string;
  fusionneeDans?: string;
};
export type Particulier = Personne & { id: string };
export type Client = { id: string; entrepriseId: string; formule: Formule; statut: "actif" | "parti" };
export type Plan = { id: string; clientId: string; formule: Formule; statut: "actif" | "termine" };
export type Facture = { id: string; clientId: string; montantCentimes: number; statut: StatutFacture };
export type Tache = { id: string; clientId: string; type: "generation"; cle: string };

export type JeuReference = {
  entreprises: Entreprise[];
  particuliers: Particulier[];
  clients: Client[];
  plans: Plan[];
  factures: Facture[];
  taches: Tache[];
  pieges: {
    ficheHubSansSiren: string;
    ficheAbsorbeeAvecIdentifiantConsole: string;
    particulierEmailPartage: string;
    planEnDouble: string;
    planActifClientParti: string;
    tacheGenerationDeuxFois: string;
    deuxClientsContactsMemeNom: [string, string];
  };
};

const STATUTS: StatutFacture[] = ["payee", "en-retard", "impayee"];
const MONTANTS: Record<Formule, number> = { "abonnement-mensuel": 9900, "6-mois": 54000, "12-mois": 96000 };
const id = (prefixe: string, n: number) => `${prefixe}-${String(n + 1).padStart(3, "0")}`;

function entreprise(g: Generateur, n: number): Entreprise {
  const { nom, forme } = genererRaisonSociale(g);
  const avecSiren = n % 4 !== 3; // les fiches 3, 7, 11, 15, 19 n'ont pas de SIREN
  const siren = avecSiren ? genererSiren(g) : undefined;
  return {
    id: id("ent", n),
    raisonSociale: `${nom} ${forme}`,
    source: avecSiren ? "crm" : "hub",
    ...(siren === undefined ? {} : { siren, siret: genererSiret(g, siren) }),
    naf: genererNaf(g),
    adresse: genererAdresse(g),
    email: genererCourrielEntreprise(g, nom),
    telephone: genererTelephone(g),
    contacts: [genererPersonne(g)],
  };
}

export function genererJeuReference(graine: number | string = 1): JeuReference {
  const g = creerGenerateur(graine);
  const entreprises = Array.from({ length: 20 }, (_, n) => entreprise(g, n));
  const e = (n: number): Entreprise => entreprises[n] as Entreprise;

  // Doublons volontaires : deux fiches reprennent la raison sociale d'une autre.
  for (const [copie, origine] of [[16, 0], [17, 1]] as const) {
    Object.assign(e(copie), { raisonSociale: e(origine).raisonSociale, doublonDe: e(origine).id });
  }
  // Une fiche fusionnée, qui porte encore un identifiant console (piège).
  Object.assign(e(18), { fusionneeDans: e(2).id, identifiantConsole: "console-0018" });

  const particuliers: Particulier[] = Array.from({ length: 3 }, (_, n) => ({ id: id("par", n), ...genererPersonne(g) }));
  // Piège : un particulier partage l'e-mail d'un contact d'entreprise.
  (particuliers[0] as Particulier).email = (e(4).contacts[0] as Personne).email;
  // Piège : deux clients dont les contacts ont le même nom.
  const [prenom, nom] = [(e(5).contacts[0] as Personne).prenom, (e(5).contacts[0] as Personne).nom];
  Object.assign(e(6).contacts[0] as Personne, { prenom, nom });

  // 15 clients (5 par formule) sur les fiches 0 à 14, dont la 3, 7 et 11 sans SIREN.
  const clients: Client[] = Array.from({ length: 15 }, (_, n) => ({
    id: id("cli", n),
    entrepriseId: e(n).id,
    formule: FORMULES[n % 3] as Formule,
    statut: n === 8 ? "parti" : "actif",
  }));
  const plans: Plan[] = clients.map((c, n) => ({ id: id("pla", n), clientId: c.id, formule: c.formule, statut: "actif" }));
  plans.push({ id: id("pla", 15), clientId: (clients[9] as Client).id, formule: (clients[9] as Client).formule, statut: "actif" }); // plan en double
  const factures: Facture[] = clients.map((c, n) => ({
    id: id("fac", n),
    clientId: c.id,
    montantCentimes: MONTANTS[c.formule] + g.entier(0, 99) * 100,
    statut: STATUTS[n % 3] as StatutFacture,
  }));
  const cle = "generation-doc-0001";
  const taches: Tache[] = [0, 1].map((n) => ({ id: id("tac", n), clientId: (clients[2] as Client).id, type: "generation", cle }));

  return {
    entreprises,
    particuliers,
    clients,
    plans,
    factures,
    taches,
    pieges: {
      ficheHubSansSiren: e(3).id,
      ficheAbsorbeeAvecIdentifiantConsole: e(18).id,
      particulierEmailPartage: (particuliers[0] as Particulier).id,
      planEnDouble: (clients[9] as Client).id,
      planActifClientParti: (clients[8] as Client).id,
      tacheGenerationDeuxFois: cle,
      deuxClientsContactsMemeNom: [(clients[5] as Client).id, (clients[6] as Client).id],
    },
  };
}
