import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { empreinteEmail, identifiantEvenementC3 } from "../../../../packages/contrats/src/c3/evenements-crm-vers-console.js";
import { EN_TETES, signer } from "../../../../packages/contrats/src/commun/signature.js";
import { ROUTES_C3 } from "../../../../packages/contrats/src/c3/lecture-entreprise.js";
import { brancherErreurs } from "../plugins/erreurs.js";
import { creerEnvoisCommerciaux } from "../envois/exclusions.js";
import { depotEnMemoire } from "./faits/depot-memoire.js";
import { creerRecepteurC3 } from "./recepteur-c3.js";
import { cibleDEnvoiCrm } from "./faits/fusion.js";
import { routeCrm } from "../routes/crm.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTRE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIREN = "812345676";
const ADRESSE = { ligne1: "1 rue des Essais", codePostal: "75001", ville: "Paris", pays: "FR" as const };
let n = 0;
const evt = (type: string, payload: object, crm = "crm-lemoine", cle: string = randomUUID()) => ({
  event_id: identifiantEvenementC3(type, cle),
  schema_version: 1 as const,
  occurred_at: "2026-11-02T10:00:00Z",
  emitted_at: "2026-11-02T10:00:01Z",
  sequence: ++n,
  producer: "axion-crm" as const,
  subject_ref: { crmCompanyId: crm },
  event_type: type,
  payload,
});
const devenue = (extra: object = {}, cle: string = randomUUID()) =>
  evt("entreprise.devenue_cliente", { crmCompanyId: "crm-lemoine", siren: SIREN, raisonSociale: "Lemoine Rénovation", adresse: ADRESSE, contacts: [{ nom: "Camille Test", email: "camille.test@exemple.fr" }], ...extra }, "crm-lemoine", cle);
function monter() {
  const depot = depotEnMemoire();
  const alertes: { type: string; reference: string }[] = [];
  const r = creerRecepteurC3({ depot, alertes: { signaler: async (a) => void alertes.push(a) } });
  return { depot, alertes, r };
}

describe("réception des faits du CRM : liaison", () => {
  it("[C-331] un client arrive du CRM et n'est jamais créé à la main ; la route de création manuelle n'existe pas", async () => {
    const serveur = Fastify();
    brancherErreurs(serveur);
    routeCrm(serveur, { entrant: { cles: { clesAcceptees: async () => [] }, memoire: { set: async () => "OK" }, actif: () => true }, recepteur: { recevoir: async (b) => ({ eventId: (b as { event_id: string }).event_id }) }, file: { add: async () => undefined } });
    for (const url of ["/api/console/v1/clients", "/api/crm/v1/clients", "/api/crm/v1/organisations"]) {
      expect((await serveur.inject({ method: "POST", url, payload: "{}" })).statusCode).toBe(404);
    }
    expect(ROUTES_C3.crmVersConsole.chemin).toBe("/api/crm/v1/evenements");
  });

  it("[C-331] entreprise.devenue_cliente pour un SIREN déjà connu lie la fiche sans créer de doublon", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    expect(await r.traiter(devenue())).toMatchObject({ resultat: "traite" });
    expect(depot.organisations()).toHaveLength(1);
    expect(depot.organisations()[0]?.crmCompanyId).toBe("crm-lemoine");
  });

  it("[C-331] @anti-doublon le même fait reçu deux fois ne crée qu'une organisation", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    const f = devenue({}, "fixe");
    expect(await r.traiter(f)).toMatchObject({ doublon: false });
    expect(await r.traiter(f)).toMatchObject({ doublon: true });
    expect(depot.organisations()).toHaveLength(1);
    expect(depot.faitsRanges()).toBe(1);
  });

  it("[C-726] un fait entreprise.devenue_cliente pour un SIREN inconnu ne crée aucune organisation", async () => {
    const { depot, r } = monter();
    expect(await r.traiter(devenue({ siren: "732829320" }))).toMatchObject({ resultat: "ignore" });
    expect(depot.organisations()).toHaveLength(0);
  });

  it("[C-726] un client de formation du CRM n'a aucune fiche dans la console", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Atelier Bertin", siren: "732829320", crmCompanyId: null });
    await r.traiter(devenue({ crmCompanyId: "crm-formation", raisonSociale: "Boulangerie Rivoire" }));
    expect(depot.organisations()).toHaveLength(1);
    expect(depot.organisations()[0]?.crmCompanyId).toBeNull();
  });

  it("[C-331] deux organisations pour un même SIREN : à trancher, rien n'est lié", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    depot.ajouterOrganisation({ id: AUTRE, raisonSociale: "Lemoine Rénovation Nord", siren: SIREN, crmCompanyId: null });
    expect(await r.traiter(devenue())).toMatchObject({ resultat: "a_trancher" });
    expect(depot.organisations().every((o) => o.crmCompanyId === null)).toBe(true);
  });
});

describe("réception des faits du CRM : liens existants", () => {
  it("[C-331] un lien CRM existant vers une autre fiche n'est jamais remplacé : à trancher, écart proposé", async () => {
    const { depot, alertes, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-ancienne" });
    expect(await r.traiter(devenue())).toMatchObject({ resultat: "a_trancher" });
    expect(depot.organisations()[0]?.crmCompanyId).toBe("crm-ancienne");
    expect(depot.ecarts()).toEqual([{ orgId: ORG, champ: "lien_crm", valeurHub: "crm-ancienne", valeurCrm: "crm-lemoine" }]);
    expect(alertes).toContainEqual({ type: "ecart_propose", reference: "crm-lemoine" });
  });

  it("[C-331] un sujet qui n'est pas la fiche du contenu est refusé : à trancher, rien n'est lié", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    const f = evt("entreprise.devenue_cliente", { crmCompanyId: "crm-lemoine", siren: SIREN, raisonSociale: "Lemoine Rénovation", adresse: ADRESSE, contacts: [] }, "crm-autre");
    expect(await r.traiter(f)).toMatchObject({ resultat: "a_trancher" });
    expect(depot.organisations()[0]?.crmCompanyId).toBeNull();
  });

  it("[C-331] un fait dont le sujet et le contenu concordent et dont le lien est le même reste traité", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    expect(await r.traiter(devenue())).toMatchObject({ resultat: "traite" });
    expect(depot.ecarts()).toEqual([]);
  });
});

describe("réception des faits du CRM : mise à jour et apporteur", () => {
  it("[C-725] une mise à jour du CRM ne change pas la raison sociale du Hub, elle propose un écart", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    await r.traiter(evt("entreprise.mise_a_jour", { crmCompanyId: "crm-lemoine", raisonSociale: "Lemoine Rénovation SARL" }));
    expect(depot.organisations()[0]?.raisonSociale).toBe("Lemoine Rénovation");
    expect(depot.ecarts()).toEqual([{ orgId: ORG, champ: "raison_sociale", valeurHub: "Lemoine Rénovation", valeurCrm: "Lemoine Rénovation SARL" }]);
    expect(depot.copies()).toHaveLength(1);
  });

  it("[C-725] une mise à jour identique au Hub ne propose aucun écart", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    await r.traiter(evt("entreprise.mise_a_jour", { crmCompanyId: "crm-lemoine", raisonSociale: " lemoine rénovation " }));
    expect(depot.ecarts()).toEqual([]);
  });

  it("[C-725] apporteur.rattache est noté pour la synchronisation des apporteurs", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    await r.traiter(evt("apporteur.rattache", { crmCompanyId: "crm-lemoine", apporteurId: "app-1" }));
    expect(depot.apporteurs()).toEqual([{ orgId: ORG, apporteurId: "app-1" }]);
  });
});

describe("réception des faits du CRM : fusion", () => {
  it("[C-457] une fusion de fiches dans le CRM met à jour l'identifiant dans la console", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-vieille" });
    await r.traiter(evt("fiche.fusionnee", { crmCompanyIdAbsorbee: "crm-vieille", crmCompanyIdGardee: "crm-gardee" }, "crm-vieille"));
    expect(depot.organisations()[0]?.crmCompanyId).toBe("crm-gardee");
    expect(depot.liens()).toEqual([{ orgId: ORG, crmCompanyId: "crm-vieille", etat: "absorbe", absorbePar: "crm-gardee" }]);
  });

  it("[C-457] plus aucun envoi ne vise la fiche absorbée", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-vieille" });
    await r.traiter(evt("fiche.fusionnee", { crmCompanyIdAbsorbee: "crm-vieille", crmCompanyIdGardee: "crm-gardee" }, "crm-vieille"));
    expect(await depot.transaction((tx) => cibleDEnvoiCrm(tx, "crm-vieille"))).toBe("crm-gardee");
    expect(await depot.transaction((tx) => cibleDEnvoiCrm(tx, "crm-gardee"))).toBe("crm-gardee");
  });
});

describe("réception des faits du CRM : consentement et effacement", () => {
  const empreinte = empreinteEmail("Camille.Test@exemple.fr");
  const retrait = (type = "consentement.retire") => evt(type, { personKey: "p-1", emailEmpreinte: empreinte });

  it("[C-458] un retrait de consentement reçu par le CRM coupe les e-mails commerciaux de la console vers cette personne", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    depot.ajouterOrganisation({ id: AUTRE, raisonSociale: "Garage Fontaine", siren: "732829320", crmCompanyId: "crm-garage" });
    depot.ajouterContact(AUTRE, "camille.test@exemple.fr");
    await r.traiter(retrait());
    const envoyes: string[] = [];
    const envois = creerEnvoisCommerciaux({ exclusions: { estExclue: async (c, e) => depot.exclusions(c).includes(e) }, transport: { envoyer: async (m) => void envoyes.push(m.destinataire) } });
    expect(await envois.envoyer({ type: "prospection", clientId: ORG, destinataire: "camille.test@exemple.fr" })).toEqual({ envoye: false, raison: "exclu" });
    expect(await envois.envoyer({ type: "facture", clientId: ORG, destinataire: "camille.test@exemple.fr" })).toEqual({ envoye: true });
    expect(depot.exclusions(AUTRE)).toEqual([]);
  });

  it("[C-458] l'exclusion est rangée en empreinte, jamais en clair", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    await r.traiter(retrait());
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
    expect(JSON.stringify(depot.tout())).not.toContain("camille.test@exemple.fr");
  });

  it("[C-458] l'exclusion est transmise au Hub ou signalée à reporter", async () => {
    const { depot, alertes, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    await r.traiter(retrait());
    expect(alertes).toContainEqual({ type: "exclusion_a_reporter_dans_le_hub", reference: empreinte });
  });

  it("[C-458] une demande d'effacement exclut aussi, alerte, et ne supprime rien", async () => {
    const { depot, alertes, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    await r.traiter(retrait("effacement.demande"));
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
    expect(depot.contacts(ORG)).toEqual(["camille.test@exemple.fr"]);
    expect(alertes.map((a) => a.type)).toContain("effacement_demande");
  });

  it("[C-458] retrait avant import : l'opposition reçue avant l'existence du contact est retrouvée à l'import", async () => {
    const { depot, r } = monter();
    await r.traiter(retrait());
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: null });
    expect(depot.exclusions(ORG)).toEqual([]);
    await r.traiter(devenue());
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
  });

  it("[C-458] le retrait de consentement est propre au client du sujet, l'effacement demandé vaut pour toute la plateforme", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterOrganisation({ id: AUTRE, raisonSociale: "Garage Fontaine", siren: "732829320", crmCompanyId: "crm-garage" });
    await r.traiter(retrait());
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
    expect(depot.exclusions(AUTRE)).toEqual([]);
    await r.traiter(retrait("effacement.demande"));
    expect(depot.exclusions(AUTRE)).toEqual([empreinte]);
  });

  it("[C-458] [C-457] l'exclusion suit la fiche après une fusion", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    await r.traiter(retrait());
    await r.traiter(evt("fiche.fusionnee", { crmCompanyIdAbsorbee: "crm-lemoine", crmCompanyIdGardee: "crm-gardee" }, "crm-lemoine"));
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
  });

  it("[C-458] signaler lève : le rejeu du même fait renvoie les alertes, une seule fois chacune", async () => {
    const depot = depotEnMemoire();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    const recues: string[] = [];
    let panne = true;
    const r = creerRecepteurC3({ depot, alertes: { signaler: async (a) => { if (panne) throw new Error("panne"); recues.push(a.type); } } });
    const f = retrait("effacement.demande");
    // T2-17b : la panne d'envoi ne fait plus échouer la tâche (pas d'essai BullMQ de plus) ; l'alerte reste non confirmée.
    await expect(r.traiter(f)).resolves.toMatchObject({ doublon: false });
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
    panne = false;
    expect(await r.traiter(f)).toEqual({ doublon: true });
    expect(recues.sort()).toEqual(["effacement_demande", "exclusion_a_reporter_dans_le_hub"]);
    await r.traiter(f);
    expect(recues).toHaveLength(2);
  });

  it("[C-458] atomicité : un effet qui échoue après rangerFait ne laisse ni le fait ni l'exclusion ni l'alerte", async () => {
    const depot = depotEnMemoire();
    const casse = { ...depot, transaction: <T,>(fn: (tx: Parameters<Parameters<typeof depot.transaction>[0]>[0]) => Promise<T>) => depot.transaction((tx) => fn({ ...tx, marquerTraite: async () => { throw new Error("effet en échec"); } })) };
    const r = creerRecepteurC3({ depot: casse, alertes: { signaler: async () => undefined } });
    await expect(r.traiter(retrait())).rejects.toThrow("effet en échec");
    expect(depot.faitsRanges()).toBe(0);
    expect(depot.tout().exclusions).toEqual([]);
    expect(depot.alertesRangees()).toEqual([]);
  });

  it("[C-458] le même retrait reçu deux fois n'exclut qu'une fois", async () => {
    const { depot, r } = monter();
    depot.ajouterOrganisation({ id: ORG, raisonSociale: "Lemoine Rénovation", siren: SIREN, crmCompanyId: "crm-lemoine" });
    depot.ajouterContact(ORG, "camille.test@exemple.fr");
    const f = retrait();
    await r.traiter(f);
    await r.traiter(f);
    expect(depot.exclusions(ORG)).toEqual([empreinte]);
  });
});

describe("route C3 du CRM", () => {
  const MAINTENANT = Math.floor(Date.now() / 1000);
  const CLE = { kid: "crm-essai", secret: Buffer.alloc(32, 7) };
  const monterRoute = (actif: boolean) => {
    const ajouts: { donnees: unknown; opts: { jobId?: string; removeOnComplete?: { age: number }; removeOnFail?: { age: number } } | undefined }[] = [];
    const serveur = Fastify();
    brancherErreurs(serveur);
    routeCrm(serveur, { entrant: { cles: { clesAcceptees: async () => [CLE] }, memoire: { set: async () => "OK" }, actif: () => actif, maintenant: () => MAINTENANT }, recepteur: { recevoir: async (b) => ({ eventId: (b as { event_id: string }).event_id }) }, file: { add: async (_n, donnees, opts) => void ajouts.push({ donnees, opts }) } });
    const base = { "content-type": "application/json", "idempotency-key": randomUUID(), [EN_TETES.cle]: CLE.kid, [EN_TETES.horodatage]: String(MAINTENANT) };
    const envoyer = (corps: string) => serveur.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: corps, headers: { ...base, [EN_TETES.signature]: signer(CLE.secret.toString("base64"), String(MAINTENANT), "POST", ROUTES_C3.crmVersConsole.chemin, corps) } });
    const envoyerFausse = (corps: string) => serveur.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: corps, headers: { ...base, [EN_TETES.signature]: `v1=${"0".repeat(64)}` } });
    const envoyerSansSignature = (corps: string) => serveur.inject({ method: "POST", url: ROUTES_C3.crmVersConsole.chemin, payload: corps, headers: base });
    return { ajouts, envoyer, envoyerFausse, envoyerSansSignature };
  };

  it("[C-331] la porte du canal C3 est fermée par défaut : un fait signé n'est pas rangé", async () => {
    const { ajouts, envoyer } = monterRoute(false);
    expect((await envoyer(JSON.stringify(devenue()))).statusCode).toBe(503);
    expect(ajouts).toEqual([]);
  });

  it("[C-331] un fait sans signature est refusé et n'entre pas dans la file", async () => {
    const { ajouts, envoyerSansSignature } = monterRoute(true);
    expect((await envoyerSansSignature(JSON.stringify(devenue()))).statusCode).toBe(401);
    expect(ajouts).toEqual([]);
  });

  it("[C-331] un en-tête de signature de bon format mais faux est refusé (401) avant la file", async () => {
    const { ajouts, envoyerFausse } = monterRoute(true);
    expect((await envoyerFausse(JSON.stringify(devenue()))).statusCode).toBe(401);
    expect(ajouts).toEqual([]);
  });

  it("[C-331] un fait bien signé entre dans la file sans nom ni e-mail de contact, avec une durée de conservation", async () => {
    const { ajouts, envoyer } = monterRoute(true);
    const f = devenue();
    expect((await envoyer(JSON.stringify(f))).statusCode).toBe(200);
    expect(ajouts).toHaveLength(1);
    expect(JSON.stringify(ajouts[0]?.donnees)).not.toContain("camille.test@exemple.fr");
    expect(JSON.stringify(ajouts[0]?.donnees)).not.toContain("Camille Test");
    expect(ajouts[0]?.opts).toMatchObject({ jobId: f.event_id, removeOnComplete: { age: expect.any(Number) }, removeOnFail: { age: expect.any(Number) } });
  });
});
