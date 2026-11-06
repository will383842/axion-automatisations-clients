import { analyserModele } from "@axion-auto/donnees-module";
import { describe, expect, it } from "vitest";
import type { BaseLecture } from "../courtier/client.ts";
import { creerFabriquePort, type ConnexionLecture, type InstanceInstallee, type PortsLecture } from "./port.ts";

// Données générées : aucun vrai client, aucun secret réel.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INST = "33333333-3333-4333-8333-333333333333";
const COR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAB = "44444444-4444-4444-8444-444444444444";
const MODELE = analyserModele('CREATE TABLE "commun"."factures_essai" (\n  "id" uuid PRIMARY KEY,\n  "etablissement_id" uuid NOT NULL,\n  "libelle" text\n);');
const LIMITES = { delaiMs: 300, delaiTotalMs: 5000, maxLignes: 2, hotes: ["pgbouncer-donnees.test"] };
const requete = (extra: object = {}) => ({ nom: "liste-factures", mode: "lecture", parametres: { motif: { type: "texte", max: 20 } }, forme: { type: "simple", table: "commun.factures_essai", sortie: { lignes: [{ colonne: "libelle" }] }, filtres: [{ colonne: "libelle", operateur: "egal", parametre: "motif" }], limite: { fixe: 10 } }, ...extra });
const instance = (donnees: unknown = { requetes: [requete()], actions: [] }, extra: Partial<InstanceInstallee> = {}): InstanceInstallee => ({ empreinte: "sha256:aaaa", installee: true, ecart: false, impaye: false, etat: "actif", donnees, ...extra });
const nomBase = (tenant: string): string => `cli_${tenant.replaceAll("-", "").slice(0, 12)}`; // dérivé de l'UUID du client, comme le courtier
const baseDe = (tenant: string): BaseLecture => ({ hote: "pgbouncer-donnees.test", base: nomBase(tenant), role: `${nomBase(tenant)}_lecture`, motDePasse: "mdp-d-essai", expire: new Date("2030-01-01"), valideJusqua: null });

interface Espion { ouvertures: BaseLecture[]; liberees: (Error | undefined)[]; demandes: [string, string][]; traces: Record<string, unknown>[]; textes: string[]; instances: string[] }
function ports(o: { instances?: Record<string, InstanceInstallee | undefined>; base?: (t: string) => BaseLecture; identite?: (b: BaseLecture) => { u: string; d: string }; lignes?: Record<string, unknown>[]; echec?: Error } = {}): { p: PortsLecture; e: Espion } {
  const e: Espion = { ouvertures: [], liberees: [], demandes: [], traces: [], textes: [], instances: [] };
  const p: PortsLecture = {
    instance: async (t, i) => { e.instances.push(`${t}|${i}`); return (o.instances ?? { [A]: instance() })[t]; },
    baseLecture: async (t, id) => { e.demandes.push([t, id]); return (o.base ?? ((x) => baseDe(x)))(t); },
    ouvrir: async (b) => {
      e.ouvertures.push(b);
      const id = o.identite?.(b) ?? { u: b.role, d: b.base };
      const c: ConnexionLecture = {
        query: async (texte) => {
          e.textes.push(texte);
          if (texte === "SAVEPOINT axion_sonde") throw Object.assign(new Error("x"), { code: "25P01" });
          if (texte.startsWith("SELECT current_setting")) return { rows: [{ ro: "on" }] };
          if (texte.includes("current_user")) return { rows: [{ u: id.u, d: id.d, id: ETAB }] };
          if (o.echec && texte.includes("factures_essai")) throw o.echec;
          return { rows: o.lignes ?? [{ libelle: "un" }, { libelle: "deux" }, { libelle: "trois" }] };
        },
        liberer: (err) => { e.liberees.push(err); },
      };
      return c;
    },
    tracer: (t) => { e.traces.push(t as unknown as Record<string, unknown>); },
  };
  return { p, e };
}
const ctx = (t = A) => ({ tenantId: t, instanceId: INST, idTache: "tache-1", correlation: COR });
const port = (o: Parameters<typeof ports>[0] = {}, t = A) => { const x = ports(o); return { ...x, lire: creerFabriquePort(x.p, LIMITES, MODELE)(ctx(t)).lire }; };

describe("port données de l'exécuteur", () => {
  it("[C-624] un nom de requête non déclaré est refusé par le port", async () => {
    const { lire, e } = port();
    for (const nom of ["inconnue", "__proto__", "constructor", "Liste-Factures", ""]) await expect(lire(nom, {}), nom).rejects.toMatchObject({ code: "introuvable" });
    expect(e.ouvertures).toEqual([]); // aucun accès à une base pour un nom inconnu
  });

  it("[C-624] une version non installée chez ce client ne sert pas ses requêtes", async () => {
    for (const x of [undefined, instance(undefined, { installee: false }), instance(undefined, { ecart: true }), instance(undefined, { impaye: true }), instance(undefined, { etat: "pause" }), instance({ requetes: [requete()], actions: [{ nom: "ecrire" }] }), instance({ requetes: [requete({ sql: "SELECT 1" })], actions: [] })]) {
      const { lire, e } = port({ instances: { [A]: x } });
      await expect(lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "introuvable" });
      expect(e.ouvertures).toEqual([]);
    }
  });

  it("[C-624] une requête dont la forme sort du modèle est refusée à chaque appel, sans accès à une base", async () => {
    const hors = requete({ forme: { type: "simple", table: "commun.factures_essai", sortie: { lignes: [{ colonne: "secret" }] }, limite: { fixe: 5 } }, parametres: {} });
    const { lire, e } = port({ instances: { [A]: instance({ requetes: [hors], actions: [] }) } });
    await expect(lire("liste-factures", {})).rejects.toMatchObject({ code: "introuvable" });
    expect(e.ouvertures).toEqual([]);
  });

  it("[C-624] un paramètre non déclaré, dont un identifiant de client ou de base forgé, est refusé sans ouvrir de connexion", async () => {
    for (const forge of [{ tenantId: B }, { base: "cli_bbbbbbbbbbbb" }, { hote: "autre.test" }, { motif: "x", etablissement_id: ETAB }, { ["__proto__"]: 1 }, { motif: 12 }, { motif: "x".repeat(21) }]) {
      const { lire, e } = port();
      await expect(lire("liste-factures", JSON.parse(JSON.stringify(forge)) as Record<string, unknown>), JSON.stringify(forge)).rejects.toMatchObject({ code: "schema_invalide" });
      expect(e.ouvertures).toEqual([]);
    }
  });

  it("[C-624] @isolation le port n'exécute une requête que dans la base du client de l'exécution, avec le rôle _lecture", async () => {
    const { lire, e } = port();
    await lire("liste-factures", { motif: "x" });
    expect(e.demandes).toEqual([[A, "tache-1"]]);
    expect(e.ouvertures).toHaveLength(1);
    expect(e.ouvertures[0]).toMatchObject({ base: "cli_" + "1".repeat(12), role: "cli_" + "1".repeat(12) + "_lecture" });
    // Le client B ne reçoit que sa base à lui, même instance et même nom de requête.
    const b = port({ instances: { [B]: instance() } }, B);
    await b.lire("liste-factures", { motif: "x" });
    expect(b.e.demandes).toEqual([[B, "tache-1"]]);
    expect(b.e.ouvertures[0]?.base).toBe("cli_" + "2".repeat(12));
  });

  it("[C-624] @isolation une base remise qui n'est pas le rôle _lecture attendu, ou une identité de session différente, est refusée et la connexion jetée", async () => {
    const mauvaises: Parameters<typeof ports>[0][] = [
      { base: () => ({ ...baseDe(A), role: "cli_" + "1".repeat(12) + "_app" }) },
      { base: () => ({ ...baseDe(A), role: "cli_" + "2".repeat(12) + "_lecture" }) },
      { identite: (b) => ({ u: b.base + "_app", d: b.base }) },
      { identite: () => ({ u: "cli_" + "2".repeat(12) + "_lecture", d: "cli_" + "2".repeat(12) }) },
    ];
    for (const m of mauvaises) {
      const { lire, e } = port(m);
      await expect(lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "indisponible" });
      expect(e.textes.some((t) => t.includes("factures_essai"))).toBe(false); // la requête du module n'est jamais partie
      expect(e.liberees.every((x) => x instanceof Error)).toBe(true);
    }
  });

  it("[C-624] une requête qui déclare une permission est refusée (échec fermé : l'exécuteur n'a pas d'utilisateur)", async () => {
    const { lire, e } = port({ instances: { [A]: instance({ requetes: [requete({ permission: "voir-factures" })], actions: [] }) } });
    await expect(lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "interdit" });
    expect(e.ouvertures).toEqual([]);
  });

  it("[C-624] le manifeste en cache est propre à (client, empreinte) : un autre client ou une autre empreinte n'en profite pas", async () => {
    const x = ports({ instances: { [A]: instance(), [B]: instance({ requetes: [], actions: [] }) } });
    const fabrique = creerFabriquePort(x.p, LIMITES, MODELE);
    await fabrique(ctx(A)).lire("liste-factures", { motif: "x" });
    await expect(fabrique(ctx(B)).lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "introuvable" }); // même empreinte, autre client
    x.p.instance = async () => instance({ requetes: [], actions: [] }, { empreinte: "sha256:bbbb" });
    await expect(fabrique(ctx(A)).lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "introuvable" }); // nouvelle empreinte : le manifeste est relu
  });

  it("[A-170] au plus maxLignes lignes sont rendues, les établissements viennent de la base lue par la connexion de lecture", async () => {
    const { lire, e } = port();
    expect(await lire("liste-factures", { motif: "x" })).toEqual([{ libelle: "un" }, { libelle: "deux" }]);
    expect(e.textes.some((t) => t.includes("commun") && t.includes("etablissements"))).toBe(true);
  });

  it("[A-170] chaque appel prend sa propre connexion et la rend, avec l'erreur quand elle est perdue ; le message ne contient aucun SQL", async () => {
    const x = port();
    await x.lire("liste-factures", { motif: "x" });
    await x.lire("liste-factures", { motif: "y" });
    expect(x.e.ouvertures).toHaveLength(2);
    expect(x.e.liberees).toEqual([undefined, undefined]);
    const perdue = Object.assign(new Error("SELECT secret FROM commun.factures_essai"), { connexionPerdue: true });
    const y = port({ echec: perdue });
    const err = await y.lire("liste-factures", { motif: "x" }).catch((r) => r);
    expect(err).toMatchObject({ code: "indisponible" });
    expect(String(err.message)).not.toMatch(/SELECT|commun|cli_/);
    expect(y.e.liberees[0]).toBe(perdue);
  });

  it("[C-631] chaque lecture émet un événement portant la correlation de l'exécution, sans paramètre ni ligne", async () => {
    const { lire, e } = port();
    await lire("liste-factures", { motif: "valeur-secrete" });
    await lire("inconnue", {}).catch(() => undefined);
    expect(e.traces).toEqual([
      { correlation: COR, requete: "liste-factures", statut: "ok", lignes: 2 },
      { correlation: COR, requete: "inconnue", statut: "refus", lignes: 0 },
    ]);
    expect(JSON.stringify(e.traces)).not.toMatch(/valeur-secrete|libelle/);
  });

  it("[C-631] un contexte d'exécution illisible (client, instance, tâche ou corrélation) est refusé à la création", () => {
    const f = creerFabriquePort(ports().p, LIMITES, MODELE);
    for (const c of [{ ...ctx(), tenantId: "x" }, { ...ctx(), instanceId: "x" }, { ...ctx(), idTache: "a b" }, { ...ctx(), correlation: "x" }]) expect(() => f(c)).toThrow();
  });

  it("[A-170] deux lectures simultanées d'un même client n'ouvrent jamais plus d'une connexion à la fois (CONNECTION LIMIT partagée avec la console)", async () => {
    const x = ports();
    let actives = 0;
    let max = 0;
    const ouvrir = x.p.ouvrir;
    x.p.ouvrir = async (b) => {
      const c = await ouvrir(b);
      actives += 1; max = Math.max(max, actives);
      const q = c.query;
      return { query: async (t, v) => { await new Promise((ok) => setTimeout(ok, 5)); return q(t, v); }, liberer: (err) => { actives -= 1; c.liberer(err); } };
    };
    const lire = creerFabriquePort(x.p, LIMITES, MODELE)(ctx()).lire;
    await Promise.all([lire("liste-factures", { motif: "a" }), lire("liste-factures", { motif: "b" }), lire("liste-factures", { motif: "c" })]);
    expect(max).toBe(1);
    expect(x.e.ouvertures).toHaveLength(3);
  });

  it("[C-624] un manifeste modifié sous la même empreinte n'est pas servi depuis le cache", async () => {
    const x = ports();
    const lire = creerFabriquePort(x.p, LIMITES, MODELE)(ctx()).lire;
    await lire("liste-factures", { motif: "x" });
    x.p.instance = async () => instance({ requetes: [], actions: [] }); // même empreinte, contenu différent
    await expect(lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "introuvable" });
  });
  it("[C-624] @isolation une remise dont la base n'est pas celle du client de l'exécution est refusée", async () => {
    // Un courtier fautif remet la base (et le rôle) de B pour une exécution de A : la session est cohérente avec la remise, mais pas avec le client.
    const { lire, e } = port({ base: () => baseDe(B) });
    await expect(lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "indisponible" });
    expect(e.ouvertures).toEqual([]); // aucune session n'est ouverte sur la base d'un autre client
    expect(e.textes).toEqual([]);
  });

  it("[A-170] un client de plus de 1000 établissements est refusé explicitement, jamais lu en partie", async () => {
    const x = ports();
    const ouvrir = x.p.ouvrir;
    x.p.ouvrir = async (b) => {
      const c = await ouvrir(b);
      return { liberer: c.liberer, query: async (t, v) => (t.includes("etablissements") ? { rows: Array.from({ length: 1001 }, (_, i) => ({ u: b.role, d: b.base, id: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}` })) } : c.query(t, v)) };
    };
    await expect(creerFabriquePort(x.p, LIMITES, MODELE)(ctx()).lire("liste-factures", { motif: "x" })).rejects.toMatchObject({ code: "indisponible" });
    expect(x.e.textes.some((t) => t.includes("factures_essai"))).toBe(false);
    expect(x.e.liberees.every((r) => r instanceof Error)).toBe(true);
  });

  it("[A-170] une lecture dépasse au plus le délai total configuré, attente en file comprise", async () => {
    const x = ports();
    const ouvrir = x.p.ouvrir;
    x.p.ouvrir = async (b) => { const c = await ouvrir(b); return { liberer: c.liberer, query: async (t, v) => { await new Promise((ok) => setTimeout(ok, 60)); return c.query(t, v); } }; };
    const lire = creerFabriquePort(x.p, { ...LIMITES, delaiTotalMs: 150 }, MODELE)(ctx()).lire;
    const debut = Date.now();
    const res = await Promise.allSettled([lire("liste-factures", { motif: "a" }), lire("liste-factures", { motif: "b" }), lire("liste-factures", { motif: "c" })]);
    expect(Date.now() - debut).toBeLessThan(400);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason?.code === "indisponible")).toBe(true);
    expect(res.some((r) => r.status === "rejected")).toBe(true);
  });
});
