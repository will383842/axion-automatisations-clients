import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.ts";
import { ErreurRegleMetier } from "./activer.ts";
import { activerAvecGardes, creerInstanceDans, lireDemandeCreation, type GardeActivation } from "./creer.ts";
import { FORMULES_V1, verifierFormule } from "./formule.ts";

// Faux client : répond selon le texte de la requête. La base reste la garantie (migration 0028, 0007, 0009) ; les essais en base sont dans db/clients.int.test.ts.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const AUTO = "55555555-5555-4555-8555-555555555555";
const INSTANCE = "66666666-6666-4666-8666-666666666666";
const CONFIG = "77777777-7777-4777-8777-777777777777";
type Rep = { rows: Record<string, unknown>[]; rowCount?: number };
function faux(o: { statut?: string; connexions?: Record<string, string[]>; doublon?: boolean; sansOrganisation?: boolean } = {}) {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const reglages: { instance: string; donnees: unknown; auteur: string }[] = [];
  const client = {
    async query(texte: string, valeurs: unknown[] = []): Promise<Rep> {
      appels.push({ texte, valeurs });
      if (texte.includes("FROM versions_automatisation")) return { rows: [{ id: VERSION, automatisation_id: AUTO, statut: o.statut ?? "publiee", code: "REL-001" }] };
      if (texte.includes("FROM organisations")) return { rows: o.sansOrganisation ? [] : [{ un: 1 }] };
      if (texte.includes("FROM connexions")) return { rows: (o.connexions?.[String(valeurs[0])] ?? []).includes(String(valeurs[1])) ? [{ un: 1 }] : [] };
      if (texte.startsWith("INSERT INTO instances")) {
        if (o.doublon) throw Object.assign(new Error("doublon"), { code: "23505", constraint: "instances_une_par_automatisation" });
        return { rows: [{ id: INSTANCE }] };
      }
      return { rows: [] };
    },
  };
  const ecrireReglages = async (_c: unknown, instance: string, donnees: unknown, auteur: string) => {
    reglages.push({ instance, donnees, auteur });
    return { id: CONFIG, numero: 1, donnees: donnees as Record<string, unknown>, auteur, motif: "installation", active: true };
  };
  return { client: client as never, appels, reglages, ecrireReglages: ecrireReglages as never };
}
const demande = (extra: Record<string, unknown> = {}) => lireDemandeCreation({ organisation_id: ORG, version_id: VERSION, formule: "abonnement", reglages: { delai_jours: 3 }, ...extra });

describe("formule d'une instance", () => {
  it("[B-312] la formule installation_maintenance est refusée en V1, la formule abonnement est acceptée", () => {
    expect(FORMULES_V1).toEqual(["abonnement"]);
    expect(verifierFormule("abonnement")).toBe("abonnement");
    expect(() => verifierFormule("installation_maintenance")).toThrowError(ErreurApi);
    expect(() => verifierFormule("installation_maintenance")).toThrowError(/abonnement/);
    expect(() => verifierFormule("gratuite")).toThrowError(ErreurApi);
  });
});

describe("créer une instance", () => {
  it("[B-312] une instance avec la formule achat est refusée en V1", async () => {
    const { client, appels, ecrireReglages } = faux();
    const erreur = await creerInstanceDans(client, A, demande({ formule: "achat" }), "equipe-essai", ecrireReglages).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurApi);
    expect(erreur).toMatchObject({ code: "regle_metier" });
    expect(appels).toEqual([]);
  });

  it("[B-312] une instance naît en pause, jamais active, avec le client de la session et sa première configuration", async () => {
    const { client, appels, reglages, ecrireReglages } = faux();
    const r = await creerInstanceDans(client, A, demande(), "equipe-essai", ecrireReglages);
    expect(r).toEqual({ instanceId: INSTANCE, configurationId: CONFIG, etat: "pause" });
    const insertion = appels.find((a) => a.texte.startsWith("INSERT INTO instances"));
    expect(insertion?.texte).toContain("'pause'");
    expect(insertion?.texte).not.toContain("'active'");
    expect(insertion?.valeurs[0]).toBe(A);
    expect(insertion?.valeurs).toContain(VERSION);
    expect(insertion?.valeurs).toContain("REL-001");
    expect(reglages).toEqual([{ instance: INSTANCE, donnees: { delai_jours: 3 }, auteur: "equipe-essai" }]);
  });

  it("[B-312] une version qui n'est pas publiée est refusée, aucune instance n'est écrite", async () => {
    for (const statut of ["brouillon", "recette", "pilote", "depreciee", "retiree"]) {
      const { client, appels, ecrireReglages } = faux({ statut });
      await expect(creerInstanceDans(client, A, demande(), "equipe-essai", ecrireReglages), statut).rejects.toMatchObject({ code: "regle_metier" });
      expect(appels.some((a) => a.texte.startsWith("INSERT")), statut).toBe(false);
    }
  });

  it("[B-312] une deuxième instance du même client, de la même automatisation et du même environnement répond « déjà installée »", async () => {
    const { client, ecrireReglages } = faux({ doublon: true });
    await expect(creerInstanceDans(client, A, demande(), "equipe-essai", ecrireReglages)).rejects.toMatchObject({ code: "identifiant_deja_pris" });
  });

  it("[B-312] @isolation créer une instance pour le client B avec une configuration ou une connexion du client A est refusé", async () => {
    // Le client A a une connexion de messagerie ; le client B n'en a aucune.
    const { client, appels, reglages, ecrireReglages } = faux({ connexions: { [A]: ["messagerie"] } });
    const avecReference = { reglages: { boite: "connexion:messagerie" } };
    await creerInstanceDans(client, A, demande(avecReference), "equipe-essai", ecrireReglages);
    const avant = reglages.length;
    await expect(creerInstanceDans(client, B, demande(avecReference), "equipe-essai", ecrireReglages)).rejects.toMatchObject({ code: "regle_metier" });
    const recherche = appels.filter((a) => a.texte.includes("FROM connexions")).at(-1);
    expect(recherche?.texte).toMatch(/tenant_id = \$1/);
    expect(recherche?.valeurs[0]).toBe(B);
    // Rien n'est écrit pour B : ni instance ni réglages.
    expect(reglages.length).toBe(avant);
    expect(appels.filter((a) => a.texte.startsWith("INSERT INTO instances")).map((a) => a.valeurs[0])).toEqual([A]);
    // Le client et la configuration ne viennent jamais du corps : toute clé inconnue est refusée.
    for (const cle of ["tenant_id", "configuration_id", "etat", "client_id"]) expect(() => demande({ [cle]: A }), cle).toThrowError(ErreurApi);
  });

  it("[B-312] une référence mal formée ou une valeur en clair dans les réglages n'est jamais prise pour une connexion", async () => {
    const { client, appels, ecrireReglages } = faux({ connexions: { [A]: ["messagerie"] } });
    await expect(creerInstanceDans(client, A, demande({ reglages: { boite: "connexion:Messagerie;DROP" } }), "equipe-essai", ecrireReglages)).rejects.toMatchObject({ code: "schema_invalide" });
    expect(appels.some((a) => a.texte.startsWith("INSERT"))).toBe(false);
  });
});

describe("gardes d'activation", () => {
  // Faux client de l'activation : l'instance existe, le contrat de sous-traitance est signé.
  function fauxActivation(o: { instance?: boolean } = {}) {
    const appels: { texte: string; valeurs: unknown[] }[] = [];
    const client = {
      async query(texte: string, valeurs: unknown[] = []): Promise<Rep> {
        appels.push({ texte, valeurs });
        if (texte.includes("FOR UPDATE")) return { rows: o.instance === false ? [] : [{ id: INSTANCE }] };
        if (texte.includes("FROM instances")) return { rows: [{ organisation_id: ORG, code_automatisation: "REL-001" }], rowCount: 1 };
        if (texte.includes("FROM contrats")) return { rows: [{ un: 1 }], rowCount: 1 };
        if (texte.startsWith("UPDATE instances")) return { rows: [{ jour: "2026-11-07" }], rowCount: 1 };
        return { rows: [] };
      },
    };
    return { client: client as never, appels };
  }
  const oui: GardeActivation = async () => ({ ok: true });
  const non = (motif: string): GardeActivation => async () => ({ ok: false, motif });

  it("[C-628] une garde d'activation qui dit non bloque l'activation, avec le motif", async () => {
    const { client, appels } = fauxActivation();
    const erreur = await activerAvecGardes(client, A, INSTANCE, [non("paiement_absent")]).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurRegleMetier);
    expect(erreur).toMatchObject({ code: "regle_metier", motif: "paiement_absent" });
    expect(appels.some((a) => a.texte.startsWith("UPDATE"))).toBe(false);
  });

  it("[C-628] toutes les gardes doivent dire oui ; la première qui dit non donne son motif, activerInstance n'est pas appelée", async () => {
    const vues: string[] = [];
    const suivie = (nom: string, g: GardeActivation): GardeActivation => async (ctx) => (vues.push(nom), g(ctx));
    const refus = fauxActivation();
    await expect(activerAvecGardes(refus.client, A, INSTANCE, [suivie("un", oui), suivie("deux", non("cle_ia_absente")), suivie("trois", non("autre"))])).rejects.toMatchObject({ motif: "cle_ia_absente" });
    expect(vues).toEqual(["un", "deux"]);
    expect(refus.appels.some((a) => a.texte.startsWith("UPDATE") || a.texte.includes("FROM contrats"))).toBe(false);
    const accord = fauxActivation();
    await activerAvecGardes(accord.client, A, INSTANCE, [oui, oui]);
    const maj = accord.appels.find((a) => a.texte.startsWith("UPDATE instances"));
    expect(maj?.texte).toContain("etat = 'active'");
    expect(maj?.valeurs).toEqual([A, INSTANCE]);
    // L'instance est verrouillée avant la première garde, pour le client de la session.
    expect(accord.appels[0]?.texte).toMatch(/FROM instances WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/);
    expect(accord.appels[0]?.valeurs).toEqual([A, INSTANCE]);
  });

  it("[C-628] une instance inconnue pour ce client est refusée avant toute garde", async () => {
    const { client } = fauxActivation({ instance: false });
    let appelee = false;
    await expect(activerAvecGardes(client, B, INSTANCE, [async () => ((appelee = true), { ok: true })])).rejects.toMatchObject({ motif: "instance_introuvable" });
    expect(appelee).toBe(false);
  });

  it("[C-628] aucun fichier hors creer.ts n'importe activerInstance (hors tests)", () => {
    const racine = fileURLToPath(new URL("../", import.meta.url));
    const sources = (dossier: string): string[] =>
      readdirSync(dossier, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sources(`${dossier}${e.name}/`) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [`${dossier}${e.name}`] : []);
    const citent = sources(racine).filter((f) => /\bactiverInstance\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(racine.length)).sort();
    expect(citent).toEqual(["instances/activer.ts", "instances/creer.ts"]);
  });
});
