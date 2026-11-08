import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { ErreurKeycloak } from "./keycloak-admin.js";
import { creerServiceMembres, type DepotMembres, type MembreEquipe } from "./membres.js";

// Service des membres de l'équipe (T3-07c). Faux adaptateur Keycloak et faux dépôt : la SÉQUENCE des appels est ce que l'on prouve.
const DIRIGEANT = { sujet: "kc-dirigeant-1", role: "dirigeant" as const };
const CLIENT_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_B = "22222222-2222-4222-8222-222222222222";
const KC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMAIL = "nadia.essai@exemple.fr";

function monde(opts: { dejaKeycloak?: boolean; echecInsertion?: boolean; echecActivation?: boolean; echecDesactivation?: boolean; envoi?: boolean; membres?: MembreEquipe[]; clients?: string[] } = {}) {
  const appels: string[] = [];
  const journal: string[] = [];
  const membres: MembreEquipe[] = opts.membres ?? [];
  const keycloak = {
    async chercherParEmail() { appels.push("kc.chercher"); return opts.dejaKeycloak ? { id: KC_ID, actif: false } : null; },
    async creerUtilisateur() { appels.push("kc.creer-desactive"); return { id: KC_ID }; },
    async activer() { appels.push("kc.activer"); if (opts.echecActivation) throw new ErreurKeycloak("indisponible", 500); },
    async envoyerActions() { appels.push("kc.envoyer"); },
    async desactiver() { appels.push("kc.desactiver"); if (opts.echecDesactivation) throw new ErreurKeycloak("indisponible", 500); },
    async supprimer() { appels.push("kc.SUPPRIMER"); },
  };
  const depot: DepotMembres = {
    async lister() { return membres; },
    async clientsExistent(ids) { appels.push("db.clients"); return ids.every((i) => (opts.clients ?? [CLIENT_A, CLIENT_B]).includes(i)); },
    async inserer(m) {
      appels.push("db.inserer");
      if (opts.echecInsertion) throw new Error("base indisponible pour nadia.essai@exemple.fr");
      membres.push({ id: "m-nouveau", sujet: m.sujet, role: m.role, actif: true, porteeClients: m.porteeClients, creeLe: new Date(0), desactiveLe: null });
      return { id: "m-nouveau" };
    },
    async desactiver(o, regle) {
      appels.push("db.desactiver");
      const cible = membres.find((m) => m.id === o.cibleId);
      if (!cible) return { etat: "introuvable" };
      if (!cible.actif) return { etat: "deja", sujet: cible.sujet };
      const dirigeantsActifs = membres.filter((m) => m.actif && m.role === "dirigeant").length;
      if (!regle({ cible: { sujet: cible.sujet, role: cible.role }, dirigeantsActifs })) return { etat: "refuse" };
      cible.actif = false;
      return { etat: "desactive", sujet: cible.sujet };
    },
  };
  const service = creerServiceMembres({ keycloak: keycloak as never, depot, invitationOuverte: () => opts.envoi === true, journaliser: (l) => journal.push(l) });
  return { service, appels, journal, membres };
}
const membre = (id: string, sujet: string, role: MembreEquipe["role"], actif = true): MembreEquipe => ({ id, sujet, role, actif, porteeClients: [], creeLe: new Date(0), desactiveLe: null });
const refus = async (p: Promise<unknown>): Promise<string> => { try { await p; return "aucun"; } catch (e) { return e instanceof ErreurApi ? e.code : `autre:${String(e)}`; } };

describe("membres de l'équipe : inviter", () => {
  it("[B-028] inviter crée l'utilisateur désactivé, insère le membre, puis l'active, dans cet ordre", async () => {
    const m = monde();
    const r = await m.service.inviter(DIRIGEANT, { email: EMAIL, role: "second_administrateur", portee_clients: [CLIENT_A] });
    expect(m.appels).toEqual(["kc.chercher", "db.clients", "kc.creer-desactive", "db.inserer", "kc.activer"]);
    expect(r).toEqual({ id: "m-nouveau", role: "second_administrateur", nombreClients: 1, invitationEnvoyee: false });
    expect(m.membres[0]?.sujet).toBe(KC_ID);
  });

  it("[B-028] un échec à l'insertion laisse l'utilisateur désactivé, sans aucune suppression ni adresse dans le journal", async () => {
    const m = monde({ echecInsertion: true });
    expect(await refus(m.service.inviter(DIRIGEANT, { email: EMAIL, role: "dirigeant", portee_clients: [] }))).toBe("erreur_interne");
    expect(m.appels).toEqual(["kc.chercher", "kc.creer-desactive", "db.inserer"]);
    expect(m.appels).not.toContain("kc.activer");
    expect(m.appels).not.toContain("kc.SUPPRIMER");
    expect(m.journal.length).toBeGreaterThan(0);
    expect(m.journal.join("\n")).not.toContain("exemple.fr");
  });

  it("[B-028] inviter refuse un rôle hors V1, une portée non UUID, un client inexistant, une portée non vide pour un dirigeant", async () => {
    const mauvaises: unknown[] = [
      { email: EMAIL, role: "lecteur", portee_clients: [] },
      { email: EMAIL, role: "second_administrateur", portee_clients: ["*"] },
      { email: EMAIL, role: "second_administrateur", portee_clients: ["pas-un-uuid"] },
      { email: EMAIL, role: "second_administrateur", portee_clients: [CLIENT_A, CLIENT_A] },
      { email: EMAIL, role: "second_administrateur", portee_clients: ["33333333-3333-4333-8333-333333333333"] },
      { email: EMAIL, role: "second_administrateur", portee_clients: [] },
      { email: EMAIL, role: "dirigeant", portee_clients: [CLIENT_A] },
      { email: "pas-une-adresse", role: "dirigeant", portee_clients: [] },
      { email: EMAIL, role: "dirigeant", portee_clients: [], motDePasse: "x" },
    ];
    for (const entree of mauvaises) {
      const m = monde();
      expect(["schema_invalide", "regle_metier"], JSON.stringify(entree)).toContain(await refus(m.service.inviter(DIRIGEANT, entree)));
      expect(m.appels, JSON.stringify(entree)).not.toContain("kc.creer-desactive");
      expect(m.appels, JSON.stringify(entree)).not.toContain("db.inserer");
    }
  });

  it("[B-028] inviter une adresse déjà membre, même désactivée, rend 409 identifiant_deja_pris sans rien créer", async () => {
    const m = monde({ dejaKeycloak: true });
    expect(await refus(m.service.inviter(DIRIGEANT, { email: EMAIL, role: "dirigeant", portee_clients: [] }))).toBe("identifiant_deja_pris");
    expect(m.appels).toEqual(["kc.chercher"]);
  });

  it("[B-028] l'envoi de l'e-mail d'invitation reste derrière l'interrupteur, fermé par défaut", async () => {
    const ferme = monde();
    await ferme.service.inviter(DIRIGEANT, { email: EMAIL, role: "dirigeant", portee_clients: [] });
    expect(ferme.appels).not.toContain("kc.envoyer");
    const ouvert = monde({ envoi: true });
    expect((await ouvert.service.inviter(DIRIGEANT, { email: EMAIL, role: "dirigeant", portee_clients: [] })).invitationEnvoyee).toBe(true);
    expect(ouvert.appels.at(-1)).toBe("kc.envoyer");
  });

  it("[B-028] Keycloak injoignable rend 503 porte_fermee, sans détail", async () => {
    const m = monde({ echecActivation: true });
    expect(await refus(m.service.inviter(DIRIGEANT, { email: EMAIL, role: "dirigeant", portee_clients: [] }))).toBe("porte_fermee");
  });
});

describe("membres de l'équipe : désactiver", () => {
  const D1 = membre("m-d1", "kc-dirigeant-1", "dirigeant");
  const D2 = membre("m-d2", "kc-dirigeant-2", "dirigeant");
  const S1 = membre("m-s1", "kc-second-1", "second_administrateur");

  it("[LOT3-securite] le dernier dirigeant actif ne peut pas être désactivé", async () => {
    const m = monde({ membres: [membre("m-d1", "kc-dirigeant-1", "dirigeant"), membre("m-d2", "kc-dirigeant-2", "dirigeant", false)] });
    expect(await refus(m.service.desactiver({ sujet: "kc-autre", role: "dirigeant" }, "m-d1"))).toBe("regle_metier");
    expect(m.appels).not.toContain("kc.desactiver");
  });

  it("[LOT3-securite] un membre ne se désactive pas lui-même", async () => {
    const m = monde({ membres: [{ ...D1 }, { ...D2 }] });
    expect(await refus(m.service.desactiver(DIRIGEANT, "m-d1"))).toBe("regle_metier");
    expect(m.appels).not.toContain("kc.desactiver");
  });

  it("[LOT3-securite] désactiver coupe la base d'abord, puis Keycloak, et garde la ligne", async () => {
    const m = monde({ membres: [{ ...D1 }, { ...D2 }, { ...S1 }] });
    await m.service.desactiver(DIRIGEANT, "m-s1");
    expect(m.appels).toEqual(["db.desactiver", "kc.desactiver"]);
    expect(m.membres.find((x) => x.id === "m-s1")?.actif).toBe(false);
    expect(m.membres).toHaveLength(3);
  });

  it("[LOT3-securite] un membre inconnu rend 404 sans appel à Keycloak", async () => {
    const m = monde({ membres: [{ ...D1 }] });
    expect(await refus(m.service.desactiver(DIRIGEANT, "m-absent"))).toBe("introuvable");
    expect(m.appels).toEqual(["db.desactiver"]);
  });

  it("[LOT3-securite] une 2e désactivation répare seulement Keycloak si l'étape Keycloak avait échoué", async () => {
    const m = monde({ membres: [{ ...D1 }, { ...D2 }, { ...S1 }], echecDesactivation: true });
    expect(await refus(m.service.desactiver(DIRIGEANT, "m-s1"))).toBe("porte_fermee");
    expect(m.membres.find((x) => x.id === "m-s1")?.actif).toBe(false);
    const reparation = monde({ membres: [{ ...D1 }, { ...D2 }, { ...S1, actif: false }] });
    await reparation.service.desactiver(DIRIGEANT, "m-s1");
    expect(reparation.appels).toEqual(["db.desactiver", "kc.desactiver"]);
  });
});

describe("membres de l'équipe : lister", () => {
  it("[B-028] la liste ne rend que des champs fermés : ni sujet Keycloak ni portée détaillée", async () => {
    const m = monde({ membres: [membre("m-d1", "kc-dirigeant-1", "dirigeant")] });
    const [premier] = await m.service.lister();
    expect(Object.keys(premier ?? {}).sort()).toEqual(["actif", "creeLe", "desactiveLe", "id", "nombreClients", "role"]);
  });
});
