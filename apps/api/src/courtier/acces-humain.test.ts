import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { credsHumainOpenBao, definitionRoleHumain, ouvrirAccesHumain, revoquerBailHumain, type PortsAccesHumain } from "./acces-humain.js";
import { nomBaseDe } from "../provisionnement/etapes-base.js";

const T = randomUUID();
const BAIL = `database/creds/humain-lecture-${nomBaseDe(T)}/Zk3JdQ8wLm2Xr5Tn`;
const MAINTENANT = new Date("2027-03-01T10:00:00Z");
const accord = (o: { debut?: string; fin?: string; accords?: string[]; intervenant?: string; perimetre?: string } | null) => async () =>
  o === null ? undefined : { perimetre: o.perimetre ?? "lecture des relances", intervenant: o.intervenant ?? "equipe-1", debut: new Date(o.debut ?? "2027-03-01T08:00:00Z"), fin: new Date(o.fin ?? "2027-03-02T08:00:00Z"), accords: o.accords ?? ["2027-02-01"] };

function monter(intervention: PortsAccesHumain["intervention"], ttl = 3600, o: { echecProgrammation?: boolean } = {}) {
  const journal: Record<string, unknown>[] = [];
  const demandes: string[] = [];
  const programmees: { bail: string; delaiMs: number }[] = [];
  const revoques: string[] = [];
  const p: PortsAccesHumain = {
    intervention,
    creds: { emettre: async (tenantId) => { demandes.push(tenantId); return { utilisateur: "v-essai-1", motDePasse: "secret-dynamique-d-essai", dureeSecondes: ttl, bail: BAIL }; } },
    bail: {
      programmerRevocation: async (_t, bail, delaiMs) => { if (o.echecProgrammation) throw new Error("file en panne"); programmees.push({ bail, delaiMs }); },
      revoquer: async (_t, bail) => { revoques.push(bail); },
    },
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => MAINTENANT,
  };
  return { p, journal, demandes, programmees, revoques };
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
