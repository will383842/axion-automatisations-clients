import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { credsHumainOpenBao, definitionRoleHumain, idTacheRevocationHumaine, MAX_BAUX_LISTES, ouvrirAccesHumain, revoquerBailHumain, revoquerTousBauxHumains, revocationsParFile, type FileRevocations, type PortsAccesHumain } from "./acces-humain.js";
import { nomBaseDe } from "../provisionnement/etapes-base.js";

const T = randomUUID();
const BAIL = `database/creds/humain-lecture-${nomBaseDe(T)}/Zk3JdQ8wLm2Xr5Tn`;
const MAINTENANT = new Date("2027-03-01T10:00:00Z");
const accord = (o: { debut?: string; fin?: string; accords?: string[]; intervenant?: string; perimetre?: string } | null) => async () =>
  o === null ? undefined : { perimetre: o.perimetre ?? "lecture des relances", intervenant: o.intervenant ?? "equipe-1", debut: new Date(o.debut ?? "2027-03-01T08:00:00Z"), fin: new Date(o.fin ?? "2027-03-02T08:00:00Z"), accords: o.accords ?? ["2027-02-01"] };

function monter(intervention: PortsAccesHumain["intervention"], ttl = 3600, o: { echecProgrammation?: boolean; verrouPris?: boolean; echecEmission?: boolean } = {}) {
  const journal: Record<string, unknown>[] = [];
  const demandes: string[] = [];
  const programmees: { bail: string; delaiMs: number }[] = [];
  const revoques: string[] = [];
  let pris = o.verrouPris ?? false;
  const etatsVerrou: string[] = [];
  const p: PortsAccesHumain = {
    intervention,
    verrou: { prendre: async () => { if (pris) return undefined; pris = true; return async () => { pris = false; }; } },
    creds: { emettre: async (tenantId) => { etatsVerrou.push(`emission:${pris ? "verrou" : "libre"}`); if (o.echecEmission) throw new Error("coffre en panne"); demandes.push(tenantId); return { utilisateur: "v-essai-1", motDePasse: "secret-dynamique-d-essai", dureeSecondes: ttl, bail: BAIL }; } },
    bail: {
      programmerRevocation: async (_t, bail, delaiMs) => { etatsVerrou.push(`programmation:${pris ? "verrou" : "libre"}`); if (o.echecProgrammation) throw new Error("file en panne"); programmees.push({ bail, delaiMs }); },
      revoquer: async (_t, bail) => { revoques.push(bail); },
    },
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => MAINTENANT,
  };
  return { p, journal, demandes, programmees, revoques, etatsVerrou, verrouPris: () => pris, poser: (v: boolean) => { pris = v; } };
}

describe("accès humain à une base client", () => {
  it("[A-211] un accès humain s'ouvre seulement avec un accord du client valide, pour 1 heure au plus, en lecture", async () => {
    const ok = monter(accord({}));
    const r = await ouvrirAccesHumain(ok.p, T, "equipe-1", "relances en double");
    expect(r.utilisateur).toBe("v-essai-1");
    expect(r.expire.getTime() - MAINTENANT.getTime()).toBeLessThanOrEqual(3_600_000);
    expect(r.lectureSeule).toBe(true);
    // Sans ligne, avant le début, après la fin, sans accord écrit : refus, aucun identifiant demandé.
    for (const cas of [null, { debut: "2027-03-01T11:00:00Z", fin: "2027-03-02T08:00:00Z" }, { debut: "2027-02-01T08:00:00Z", fin: "2027-03-01T09:00:00Z" }, { accords: [] }]) {
      const m = monter(accord(cas));
      await expect(ouvrirAccesHumain(m.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "accord_absent" });
      expect(m.demandes).toEqual([]);
    }
    await expect(ouvrirAccesHumain(ok.p, T, "  ", "x")).rejects.toMatchObject({ code: "demande_invalide" });
    await expect(ouvrirAccesHumain(ok.p, T, "equipe-1", "")).rejects.toMatchObject({ code: "demande_invalide" });
    await expect(ouvrirAccesHumain(ok.p, "pas-un-uuid", "equipe-1", "x")).rejects.toMatchObject({ code: "demande_invalide" });
    // Plus d'une heure rendue par le moteur : refusée.
    await expect(ouvrirAccesHumain(monter(accord({}), 7200).p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "duree_excessive" });
  });

  it("[A-211] l'identifiant dynamique expire seul : échéance bornée par l'intervention, trace sans valeur", async () => {
    const court = monter(accord({ fin: "2027-03-01T10:20:00Z" }));
    const r = await ouvrirAccesHumain(court.p, T, "equipe-1", "relances en double");
    expect(r.expire.toISOString()).toBe("2027-03-01T10:20:00.000Z");
    expect(JSON.stringify(court.journal)).not.toContain("secret-dynamique-d-essai");
    expect(court.journal[0]).toMatchObject({ evenement: "acces_humain_ouvert", tenantId: T, qui: "equipe-1", motif: "relances en double" });
    // Adaptateur OpenBao : un seul chemin (rôle de lecture), aucune redirection, aucun corps d'erreur repris.
    const refus = credsHumainOpenBao({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: (async () => new Response("mdp-dynamique-un", { status: 500 })) as unknown as typeof fetch });
    const e = await refus.emettre(T).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "coffre_indisponible" });
    expect(String((e as Error).message)).not.toContain("mdp-dynamique-un");
  });

  it("[A-211] @isolation l'identifiant émis pour A l'est par le rôle dynamique de A seulement, jamais par un chemin d'un autre client", async () => {
    const A = T;
    const B = randomUUID();
    const appels: { url: string; jeton: string }[] = [];
    const corps = (t: string) => JSON.stringify({ lease_id: `database/creds/humain-lecture-${nomBaseDe(t)}/Zk3JdQ8wLm2Xr5Tn`, lease_duration: 3600, data: { username: "v-lecture-1", password: "mdp-dynamique-un" } });
    const creds = credsHumainOpenBao({ url: "http://coffre.test", jeton: "jeton-humains", fetch: (async (u: string, i: RequestInit) => { appels.push({ url: u, jeton: (i.headers as Record<string, string>)["X-Vault-Token"]! }); return new Response(corps(A)); }) as unknown as typeof fetch });
    await expect(creds.emettre(A)).resolves.toEqual({ utilisateur: "v-lecture-1", motDePasse: "mdp-dynamique-un", dureeSecondes: 3600, bail: BAIL });
    expect(appels.map((a) => a.url)).toEqual([`http://coffre.test/v1/database/creds/humain-lecture-${nomBaseDe(A)}`]);
    expect(appels[0]!.url).not.toContain(nomBaseDe(B));
    // Un bail rendu pour un autre client est refusé et jamais transmis.
    const faux = credsHumainOpenBao({ url: "http://coffre.test", jeton: "j", fetch: (async () => new Response(corps(B))) as unknown as typeof fetch });
    await expect(faux.emettre(A)).rejects.toMatchObject({ code: "coffre_indisponible" });
    await expect(creds.emettre("pas-un-uuid")).rejects.toMatchObject({ code: "demande_invalide" });
    expect(appels).toHaveLength(1);
  });

  it("[A-211] le rôle dynamique d'un client ne se rattache qu'à cli_<id>_lecture, sans héritage, borné en connexions et en durée de requête", () => {
    const d = definitionRoleHumain(T);
    const base = nomBaseDe(T);
    expect(d.nom).toBe(`humain-lecture-${base}`);
    const creation = d.creation_statements.join("\n");
    // Rôle NOINHERIT : sans WITH INHERIT TRUE sur ce seul rattachement, il serait membre de _lecture sans aucun droit (constaté par l'essai réel).
    expect(creation).toContain(`GRANT "${base}_lecture" TO "{{name}}" WITH INHERIT TRUE`);
    expect(creation).toMatch(/NOINHERIT/);
    expect(creation).toMatch(/CONNECTION LIMIT [1-9]/);
    expect(creation).toMatch(/statement_timeout\s*=\s*'[1-9]\d*(ms|s|min)'/);
    expect(creation).toMatch(/default_transaction_read_only\s*=\s*on/);
    for (const interdit of [/_proprietaire/, /_app/, /provisionneur/, /SUPERUSER|CREATEROLE|CREATEDB/, /(?<!NO)BYPASSRLS/]) expect(creation).not.toMatch(interdit);
    expect(creation.match(/cli_[0-9a-f]{12}/g)!.every((n) => n === base)).toBe(true);
    // Fin du bail : sessions coupées, droits retirés, rôle supprimé.
    const fin = d.revocation_statements.join("\n");
    expect(fin).toMatch(/pg_terminate_backend/);
    // Course à la révocation : le rôle perd d'abord le droit de se connecter, PUIS ses sessions sont coupées, PUIS ses droits retirés, PUIS il est supprimé.
    const ordre = d.revocation_statements.map((o) => (/NOLOGIN/.test(o) ? "nologin" : /pg_terminate_backend/.test(o) ? "terminer" : /REVOKE/.test(o) ? "revoquer" : /DROP ROLE/.test(o) ? "supprimer" : "autre"));
    expect(ordre).toEqual(["nologin", "terminer", "revoquer", "supprimer"]);
    expect(d.revocation_statements[0]).toMatch(/^ALTER ROLE "\{\{name\}\}" NOLOGIN;$/);
    expect(fin).toMatch(/REVOKE ALL ON DATABASE/);
    expect(fin).toMatch(/DROP ROLE IF EXISTS "\{\{name\}\}"/);
    expect(d.default_ttl).toBe("1h");
    expect(d.max_ttl).toBe("1h");
    expect(() => definitionRoleHumain("pas-un-uuid")).toThrow();
  });

  it("[A-211] le bail est révoqué à la fin de l'intervention si elle tombe avant une heure ; l'identifiant est refusé ensuite", async () => {
    const court = monter(accord({ fin: "2027-03-01T10:20:00Z" }));
    await ouvrirAccesHumain(court.p, T, "equipe-1", "relances en double");
    expect(court.programmees).toEqual([{ bail: BAIL, delaiMs: 20 * 60_000 }]);
    // Intervention longue : le bail s'éteint à l'heure, mais la révocation est tout de même posée à l'heure pleine.
    const long = monter(accord({}));
    await ouvrirAccesHumain(long.p, T, "equipe-1", "x");
    expect(long.programmees).toEqual([{ bail: BAIL, delaiMs: 3_600_000 }]);
    // Tâche de révocation : bail de ce client seulement, trace sans valeur.
    await revoquerBailHumain(court.p, T, BAIL);
    expect(court.revoques).toEqual([BAIL]);
    expect(court.journal.at(-1)).toMatchObject({ evenement: "acces_humain_revoque", tenantId: T });
    expect(JSON.stringify(court.journal)).not.toContain("secret-dynamique-d-essai");
    await expect(revoquerBailHumain(court.p, T, `database/creds/humain-lecture-${nomBaseDe(randomUUID())}/Zk3JdQ8wLm2Xr5Tn`)).rejects.toMatchObject({ code: "demande_invalide" });
    await expect(revoquerBailHumain(court.p, T, "sys/policy/root")).rejects.toMatchObject({ code: "demande_invalide" });
    expect(court.revoques).toHaveLength(1);
    // Révocation impossible à programmer : le bail est révoqué aussitôt et rien n'est rendu (échec fermé).
    const panne = monter(accord({ fin: "2027-03-01T10:20:00Z" }), 3600, { echecProgrammation: true });
    await expect(ouvrirAccesHumain(panne.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "revocation_impossible" });
    expect(panne.revoques).toEqual([BAIL]);
  });

  it("[A-211] la révocation par OpenBao vise le seul bail du client, par le chemin des baux, sans reprendre le corps d'une erreur", async () => {
    const appels: { url: string; methode: string }[] = [];
    const bao = credsHumainOpenBao({ url: "http://coffre.test", jeton: "j", fetch: (async (u: string, i: RequestInit) => { appels.push({ url: u, methode: i.method ?? "GET" }); return new Response("mdp-dynamique-un", { status: 500 }); }) as unknown as typeof fetch });
    const e = await bao.revoquer(T, BAIL).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "coffre_indisponible" });
    expect(String((e as Error).message)).not.toContain("mdp-dynamique-un");
    expect(appels).toEqual([{ url: `http://coffre.test/v1/sys/leases/revoke/${BAIL}`, methode: "PUT" }]);
    await expect(bao.revoquer(T, "../../sys/policy/root")).rejects.toMatchObject({ code: "demande_invalide" });
    expect(appels).toHaveLength(1);
  });

  it("[A-211] qui est comparé à l'intervenant de la ligne d'accord et le périmètre doit être une lecture", async () => {
    const autre = monter(accord({ intervenant: "equipe-2" }));
    await expect(ouvrirAccesHumain(autre.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "intervenant_different" });
    expect(autre.demandes).toEqual([]);
    expect(autre.journal.at(-1)).toMatchObject({ evenement: "acces_humain_refuse", code: "intervenant_different" });
    const maj = monter(accord({ intervenant: " Equipe-1 " }));
    await expect(ouvrirAccesHumain(maj.p, T, "equipe-1", "x")).resolves.toMatchObject({ utilisateur: "v-essai-1" });
    for (const perimetre of ["", "   ", "modification des relances", "écriture des factures", "x".repeat(501)]) {
      const m = monter(accord({ perimetre }));
      await expect(ouvrirAccesHumain(m.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "perimetre_hors_lecture" });
      expect(m.demandes).toEqual([]);
    }
  });
});

// Fausse file BullMQ (forme structurelle) : mémoire, états ignorés ; remove() retire la tâche et le note.
function fausseFile(depart: { id: string; data: unknown }[] = []) {
  const taches = depart.map((t) => ({ ...t }));
  const ajouts: { nom: string; donnees: unknown; options: Record<string, unknown> }[] = [];
  const evenements: string[] = [];
  const file: FileRevocations = {
    add: async (nom, donnees, options) => { ajouts.push({ nom, donnees, options }); taches.push({ id: String(options["jobId"]), data: donnees }); },
    getJobs: async () => taches.map((t) => ({ id: t.id, data: t.data, remove: async () => { evenements.push(`retire:${t.id}`); taches.splice(taches.findIndex((x) => x.id === t.id), 1); } })),
  };
  return { file, taches, ajouts, evenements };
}
const bailDe = (tenantId: string, suffixe: string) => `database/creds/humain-lecture-${nomBaseDe(tenantId)}/${suffixe}`;
const tache = (tenantId: string, suffixe: string) => ({ id: idTacheRevocationHumaine(tenantId, bailDe(tenantId, suffixe)), data: { tenantId, bail: bailDe(tenantId, suffixe) } });
function portsRevocation(f: ReturnType<typeof fausseFile>, o: { echec?: (bail: string) => boolean; suspendu?: boolean } = {}) {
  const journal: Record<string, string | number | boolean>[] = [];
  const appels: string[] = [];
  return {
    appels, journal,
    p: {
      bail: { revoquer: async (_t: string, bail: string) => { appels.push(bail); f.evenements.push(`revoque:${bail}`); if (o.suspendu) return new Promise<void>(() => undefined); if (o.echec?.(bail)) throw new Error(`échec ${bail} secret-d-essai`); } },
      taches: revocationsParFile(f.file),
      journal: { tracer: (e: Record<string, string | number | boolean>) => { journal.push(e); } },
    },
  };
}

describe("révocation de tous les baux humains d'un client", () => {
  it("[A-209] rotation immédiate : chaque bail humain du client est révoqué par le coffre, puis sa tâche différée est retirée", async () => {
    const f = fausseFile([tache(T, "Zk3JdQ8wLm2Xr5Tn"), tache(T, "Ab1Cd2Ef3Gh4Ij5K")]);
    const r = portsRevocation(f);
    const bilan = await revoquerTousBauxHumains(r.p, T);
    expect(bilan).toEqual({ revoques: 2, etrangers: 0, echecs: 0, complet: true });
    const ids = [tache(T, "Zk3JdQ8wLm2Xr5Tn").id, tache(T, "Ab1Cd2Ef3Gh4Ij5K").id];
    expect(f.evenements).toEqual([`revoque:${bailDe(T, "Zk3JdQ8wLm2Xr5Tn")}`, `retire:${ids[0]}`, `revoque:${bailDe(T, "Ab1Cd2Ef3Gh4Ij5K")}`, `retire:${ids[1]}`]);
    expect(f.taches).toEqual([]);
  });

  it("[A-209] rotation immédiate : une tâche n'est retirée qu'après une révocation réussie", async () => {
    const f = fausseFile([tache(T, "Zk3JdQ8wLm2Xr5Tn"), tache(T, "Ab1Cd2Ef3Gh4Ij5K")]);
    const r = portsRevocation(f, { echec: (b) => b.endsWith("Zk3JdQ8wLm2Xr5Tn") });
    const bilan = await revoquerTousBauxHumains(r.p, T);
    expect(bilan).toEqual({ revoques: 1, etrangers: 0, echecs: 1, complet: false });
    expect(f.taches.map((t) => t.id)).toEqual([tache(T, "Zk3JdQ8wLm2Xr5Tn").id]);
    // 3 passes sur le bail en échec, une seule sur l'autre.
    expect(r.appels.filter((b) => b.endsWith("Zk3JdQ8wLm2Xr5Tn"))).toHaveLength(3);
    expect(r.appels.filter((b) => b.endsWith("Ab1Cd2Ef3Gh4Ij5K"))).toHaveLength(1);
  });

  it("[A-209] rotation immédiate : un bail d'un autre client trouvé dans la file n'est jamais révoqué et il est tracé bail_etranger", async () => {
    const B = randomUUID();
    const pref = `revocation-humain-${nomBaseDe(T)}-`;
    const f = fausseFile([
      { id: `${pref}Zk3JdQ8wLm2Xr5Tn`, data: { tenantId: T, bail: bailDe(B, "Zk3JdQ8wLm2Xr5Tn") } },
      { id: `${pref}../Zk3JdQ8w`, data: { tenantId: T, bail: `database/creds/humain-lecture-${nomBaseDe(T)}/../Zk3JdQ8w` } },
      { id: `${pref}Ab1Cd2Ef3Gh4Ij5K`, data: { tenantId: T, bail: bailDe(T, "Zk3JdQ8wLm2Xr5Tn") } },
      { id: `${pref}Qw9Er8Ty7Ui6Op5A`, data: { tenantId: T } },
      { id: `${pref}Qw9Er8Ty7Ui6Op5B`, data: null },
    ]);
    const r = portsRevocation(f);
    const bilan = await revoquerTousBauxHumains(r.p, T);
    expect(r.appels).toEqual([]);
    expect(bilan).toMatchObject({ revoques: 0, etrangers: 5, echecs: 0 });
    expect(f.taches).toHaveLength(5);
    expect(r.journal.filter((e) => e["evenement"] === "bail_etranger")).toHaveLength(5);
    expect(JSON.stringify(r.journal)).not.toMatch(/database\/creds|humain-lecture|Zk3JdQ8w/);
  });

  it("[A-209] @isolation la révocation des baux de A ne touche aucune tâche de B", async () => {
    const B = randomUUID();
    const f = fausseFile([tache(T, "Zk3JdQ8wLm2Xr5Tn"), tache(B, "Zk3JdQ8wLm2Xr5Tn"), tache(B, "Ab1Cd2Ef3Gh4Ij5K")]);
    const r = portsRevocation(f);
    expect(await revoquerTousBauxHumains(r.p, T)).toMatchObject({ revoques: 1, etrangers: 0, complet: true });
    expect(r.appels).toEqual([bailDe(T, "Zk3JdQ8wLm2Xr5Tn")]);
    expect(f.taches.map((t) => t.id)).toEqual([tache(B, "Zk3JdQ8wLm2Xr5Tn").id, tache(B, "Ab1Cd2Ef3Gh4Ij5K").id]);
    await expect(revoquerTousBauxHumains(r.p, "pas-un-uuid")).rejects.toMatchObject({ code: "demande_invalide" });
  });

  it("[A-209] rotation immédiate : coffre lent, au plus 3 essais de 5 s par bail et le verrou est rendu", async () => {
    vi.useFakeTimers();
    try {
      const f = fausseFile([tache(T, "Zk3JdQ8wLm2Xr5Tn")]);
      const r = portsRevocation(f, { suspendu: true });
      const attente = revoquerTousBauxHumains(r.p, T);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await attente).toEqual({ revoques: 0, etrangers: 0, echecs: 1, complet: false });
      expect(r.appels).toHaveLength(3);
      expect(f.taches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[A-209] une liste de tâches pleine (500) rend revocation_incomplete, jamais un succès partiel silencieux", async () => {
    const f = fausseFile(Array.from({ length: MAX_BAUX_LISTES }, (_, i) => tache(T, `Ab1Cd2Ef${String(i).padStart(4, "0")}`)));
    const r = portsRevocation(f);
    const bilan = await revoquerTousBauxHumains(r.p, T);
    expect(bilan.complet).toBe(false);
    expect(bilan.revoques).toBe(MAX_BAUX_LISTES);
    // File en panne : même issue fermée.
    const panne = { ...r.p, taches: { lister: async () => { throw new Error("redis absent"); } } };
    expect(await revoquerTousBauxHumains(panne, T)).toMatchObject({ complet: false, revoques: 0 });
  });
});

describe("accès humain et verrou de rotation", () => {
  it("[A-211] aucun accès humain n'est émis pendant qu'une rotation tient le verrou du client (rotation_en_cours)", async () => {
    const m = monter(accord({}), 3600, { verrouPris: true });
    await expect(ouvrirAccesHumain(m.p, T, "equipe-1", "relances en double")).rejects.toMatchObject({ code: "rotation_en_cours" });
    expect(m.demandes).toEqual([]);
    expect(m.programmees).toEqual([]);
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "acces_humain_refuse", tenantId: T, code: "rotation_en_cours" }));
  });

  it("[A-211] course : un accès demandé pendant la révocation est refusé, celui demandé après la libération est émis et programmé", async () => {
    const m = monter(accord({}));
    // La rotation prend le verrou (même instance, même clé) et le garde pendant la révocation.
    const rendre = (await m.p.verrou.prendre(T))!;
    await expect(ouvrirAccesHumain(m.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "rotation_en_cours" });
    expect(m.demandes).toEqual([]);
    await rendre();
    await expect(ouvrirAccesHumain(m.p, T, "equipe-1", "x")).resolves.toMatchObject({ utilisateur: "v-essai-1" });
    expect(m.demandes).toEqual([T]);
    expect(m.programmees).toHaveLength(1);
    // Le verrou est TENU pendant l'émission et la programmation (jamais un contrôle « libre » suivi de l'action).
    expect(m.etatsVerrou).toEqual(["emission:verrou", "programmation:verrou"]);
  });

  it("[A-211] l'accès humain rend le verrou même si l'émission ou la programmation échoue", async () => {
    const emission = monter(accord({}), 3600, { echecEmission: true });
    await expect(ouvrirAccesHumain(emission.p, T, "equipe-1", "x")).rejects.toThrow();
    expect(emission.verrouPris()).toBe(false);
    const programmation = monter(accord({}), 3600, { echecProgrammation: true });
    await expect(ouvrirAccesHumain(programmation.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "revocation_impossible" });
    expect(programmation.verrouPris()).toBe(false);
    const ok = monter(accord({}));
    await ouvrirAccesHumain(ok.p, T, "equipe-1", "x");
    expect(ok.verrouPris()).toBe(false);
    // Un refus d'accord avant l'émission ne touche pas au verrou.
    const refus = monter(accord(null));
    await expect(ouvrirAccesHumain(refus.p, T, "equipe-1", "x")).rejects.toMatchObject({ code: "accord_absent" });
    expect(refus.verrouPris()).toBe(false);
  });

  it("[A-211] la tâche de révocation programmée a l'identifiant revocation-humain-<base>-<suffixe> et ne porte que tenantId et bail", async () => {
    const f = fausseFile();
    const adaptateur = revocationsParFile(f.file);
    await adaptateur.programmerRevocation(T, BAIL, 90_000);
    expect(f.ajouts).toHaveLength(1);
    expect(f.ajouts[0]).toMatchObject({ nom: "revocation-humaine", donnees: { tenantId: T, bail: BAIL }, options: { jobId: `revocation-humain-${nomBaseDe(T)}-Zk3JdQ8wLm2Xr5Tn`, delay: 90_000, removeOnComplete: true } });
    expect(Object.keys(f.ajouts[0]!.donnees as object).sort()).toEqual(["bail", "tenantId"]);
    expect(f.ajouts[0]!.options["jobId"]).not.toMatch(/[:/]/);
    expect(idTacheRevocationHumaine(T, BAIL)).toBe(`revocation-humain-${nomBaseDe(T)}-Zk3JdQ8wLm2Xr5Tn`);
    // Bail d'un autre client ou piégé : refus avant tout dépôt.
    for (const mauvais of [bailDe(randomUUID(), "Zk3JdQ8wLm2Xr5Tn"), "sys/policy/root", `${BAIL}/../x`]) {
      expect(() => idTacheRevocationHumaine(T, mauvais)).toThrow();
      await expect(adaptateur.programmerRevocation(T, mauvais, 1000)).rejects.toThrow();
    }
    expect(f.ajouts).toHaveLength(1);
  });
});
