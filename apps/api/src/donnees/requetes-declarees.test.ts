import { describe, expect, it } from "vitest";
import { creerRequetesDeclarees, type InstanceInstallee, type PortsDeclarees, type SessionPortail } from "./requetes-declarees.js";

// Deux clients, A et B. Chaque instance est rangée sous (client, instance) : le port ne rend l'instance de B que si le client demandé est B.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAB_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const LECTURE = { nom: "personnes-recentes", mode: "lecture", parametres: { n: { type: "entier", min: 1, max: 50 } }, forme: { type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "id" }] }, limite: { parametre: "n" } } };
const COMPTE = { nom: "compte", mode: "lecture", permission: "voir-compte", parametres: {}, forme: { type: "simple", table: "commun.personnes", sortie: { agregats: [{ fonction: "compter", alias: "total" }] } } };
const CHIFFREE = { nom: "chiffree", mode: "lecture", parametres: {}, forme: { type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "email" }] }, limite: { fixe: 5 } } };
const base = (extra: Partial<InstanceInstallee> = {}): InstanceInstallee => ({ etat: "actif", installee: true, ecart: false, impaye: false, donnees: { requetes: [LECTURE, COMPTE, CHIFFREE], actions: [] }, ...extra });

function monter(instances: Record<string, InstanceInstallee>, permis = true) {
  const vus = { instances: [] as string[], bases: [] as string[], ouvertures: [] as string[], textes: [] as string[], valeurs: [] as unknown[][], fermetures: 0 };
  const ports: PortsDeclarees = {
    async instance(tenantId, instanceId) { vus.instances.push(`${tenantId}/${instanceId}`); return instances[`${tenantId}/${instanceId}`]; },
    async base(tenantId) { vus.bases.push(tenantId); return { nomBase: tenantId === A ? "cli_aaaaaaaaaaaa" : "cli_bbbbbbbbbbbb", etat: "active" }; },
    async ouvrir(nomBase, role) {
      vus.ouvertures.push(`${nomBase}/${role}`);
      return { async requete(texte, valeurs) { vus.textes.push(texte); vus.valeurs.push(valeurs); if (/current_setting\('transaction_read_only'\)/.test(texte)) return [{ ro: "on" }];
        return /count/.test(texte) ? [{ total: 3 }] : Array.from({ length: 300 }, (_, i) => ({ id: `id${i}`, email: "x@exemple.fr", etablissement_id: ETAB_A })); }, async fermer() { vus.fermetures += 1; } };
    },
    async permissionAccordee() { return permis; },
    maintenant: () => new Date("2026-11-06T10:00:00Z"),
  };
  return { service: creerRequetesDeclarees(ports), vus };
}
const session: SessionPortail = { tenantId: A, role: "client", acteur: "u1", etablissements: [ETAB_A] };
const refuse = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

describe("requêtes déclarées des versions installées (lecture seule)", () => {
  it("[C-624] @isolation une requête déclarée ne lit que la base du client de la session (instance de B refusée)", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base(), [`${B}/${INST_B}`]: base() });
    await service.lire(session, INST_A, "personnes-recentes", { n: 3 });
    expect(vus.ouvertures).toEqual(["cli_aaaaaaaaaaaa/lecture"]);
    const avant = JSON.stringify(vus);
    await refuse(service.lire(session, INST_B, "personnes-recentes", { n: 3 }), "introuvable");
    expect(vus.instances.at(-1)).toBe(`${A}/${INST_B}`);
    expect(vus.ouvertures).toHaveLength(1);
    expect(JSON.stringify(vus.valeurs)).not.toContain(B);
    expect(avant).not.toContain(B);
  });

  it("[C-624] @isolation l'identifiant d'un client, d'une base ou d'un établissement n'est jamais un paramètre", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    for (const p of [{ n: 3, tenantId: B }, { n: 3, base: "cli_bbbbbbbbbbbb" }, { n: 3, etablissementId: ETAB_A }, { n: 3, __proto__x: 1 }, JSON.parse('{"n":3,"__proto__":{"a":1}}')]) {
      await refuse(service.lire(session, INST_A, "personnes-recentes", p), "schema_invalide");
    }
    expect(vus.ouvertures).toEqual([]);
  });

  it("[C-624] une requête non déclarée est refusée, y compris un nom de prototype", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    for (const nom of ["inconnue", "__proto__", "constructor", "toString"]) await refuse(service.lire(session, INST_A, nom, {}), "introuvable");
    expect(vus.ouvertures).toEqual([]);
  });

  it("[C-624] une requête d'une version non installée, à l'écart, en pause, arrêtée ou impayée est refusée sans détail", async () => {
    for (const cas of [{ installee: false }, { ecart: true }, { etat: "pause" as const }, { etat: "arrete" as const }, { impaye: true }]) {
      const { service, vus } = monter({ [`${A}/${INST_A}`]: base(cas) });
      await expect(service.lire(session, INST_A, "personnes-recentes", { n: 3 })).rejects.toMatchObject({ code: "introuvable", message: "Ressource introuvable." });
      expect(vus.ouvertures, JSON.stringify(cas)).toEqual([]);
    }
  });

  it("[C-626] un utilisateur sans la permission déclarée reçoit interdit", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() }, false);
    await refuse(service.lire(session, INST_A, "compte", {}), "action_interdite");
    expect(vus.ouvertures).toEqual([]);
    expect(await monter({ [`${A}/${INST_A}`]: base() }).service.lire(session, INST_A, "compte", {})).toEqual([{ total: 3 }]);
  });

  it("[C-624] une session d'équipe ou illisible est refusée", async () => {
    const { service } = monter({ [`${A}/${INST_A}`]: base() });
    await refuse(service.lire({ ...session, role: "equipe" }, INST_A, "compte", {}), "action_interdite");
    await refuse(service.lire({ ...session, tenantId: "pas-un-uuid" }, INST_A, "compte", {}), "action_interdite");
    await refuse(service.lire(session, "pas-un-uuid", "compte", {}), "introuvable");
  });

  it("[A-170] le filtre d'établissement est imposé quand la requête le déclare (établissements de la session, en $1)", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    await service.lire(session, INST_A, "compte", {});
    expect(vus.valeurs.find((v) => v.length > 0)![0]).toEqual([ETAB_A]);
    expect(vus.textes.some((t) => t.includes('"etablissement_id" = ANY($1::uuid[])'))).toBe(true);
  });

  it("[A-170] la lecture est une transaction READ ONLY sous délai, sur la connexion de lecture, puis la connexion est fermée", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    await service.lire(session, INST_A, "compte", {});
    expect(vus.textes[0]).toBe("BEGIN READ ONLY");
    expect(vus.textes[1]).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(vus.textes[2]).toBe("SELECT current_setting('transaction_read_only') AS ro");
    expect(vus.textes[3]).toMatch(/^SELECT /); // la requête déclarée, après le contrôle
    expect(vus.textes.at(-1)).toBe("COMMIT");
    expect(vus.ouvertures.every((o) => o.endsWith("/lecture"))).toBe(true);
    expect(vus.fermetures).toBe(1);
  });

  it("[C-624] une colonne chiffrée déclarée n'est jamais rendue (refus, aucune connexion)", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    await refuse(service.lire(session, INST_A, "chiffree", {}), "introuvable");
    expect(vus.ouvertures).toEqual([]);
  });

  it("[C-624] seules les colonnes déclarées sont rendues et le nombre de lignes est borné", async () => {
    const { service, vus } = monter({ [`${A}/${INST_A}`]: base() });
    const lignes = await service.lire(session, INST_A, "personnes-recentes", { n: 3 });
    expect(vus.valeurs.find((v) => v.length > 0)).toContain(3); // la limite du module est liée au SQL
    expect(lignes).toHaveLength(200); // la base répond 300 lignes : filet de sortie à 200
    expect(Object.keys(lignes[0]!)).toEqual(["id"]);
  });

  it("[C-624] un manifeste qui porte une action ou du sql est refusé à la lecture (échec fermé)", async () => {
    for (const donnees of [{ requetes: [{ ...LECTURE, sql: "SELECT 1" }], actions: [] }, { requetes: [LECTURE], actions: [{ nom: "ecrire" }] }]) {
      const { service, vus } = monter({ [`${A}/${INST_A}`]: base({ donnees }) });
      await refuse(service.lire(session, INST_A, "personnes-recentes", { n: 3 }), "introuvable");
      expect(vus.ouvertures).toEqual([]);
    }
  });

  it("[C-624] une erreur d'exécution ne laisse sortir ni SQL ni nom de base", async () => {
    const { service } = monter({ [`${A}/${INST_A}`]: base() });
    const ports = { instance: async () => base(), base: async () => ({ nomBase: "cli_aaaaaaaaaaaa", etat: "active" }), ouvrir: async () => ({ requete: async (t: string) => { if (t === "BEGIN READ ONLY") throw new Error('SELECT secret FROM cli_aaaaaaaaaaaa'); return []; }, fermer: async () => undefined }), permissionAccordee: async () => true, maintenant: () => new Date() };
    await expect(creerRequetesDeclarees(ports).lire(session, INST_A, "compte", {})).rejects.toMatchObject({ code: "porte_fermee", message: "Service indisponible." });
    void service;
  });
});
