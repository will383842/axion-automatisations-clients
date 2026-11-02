import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { credsHumainOpenBao, ouvrirAccesHumain, type PortsAccesHumain } from "./acces-humain.js";

const T = randomUUID();
const MAINTENANT = new Date("2027-03-01T10:00:00Z");
const accord = (o: { debut?: string; fin?: string; accords?: string[] } | null) => async () =>
  o === null ? undefined : { perimetre: "lecture des relances", debut: new Date(o.debut ?? "2027-03-01T08:00:00Z"), fin: new Date(o.fin ?? "2027-03-02T08:00:00Z"), accords: o.accords ?? ["2027-02-01"] };

function monter(intervention: PortsAccesHumain["intervention"], ttl = 3600) {
  const journal: Record<string, unknown>[] = [];
  const demandes: string[] = [];
  const p: PortsAccesHumain = {
    intervention,
    creds: { emettre: async () => { demandes.push("creds"); return { utilisateur: "v-essai-1", motDePasse: "secret-dynamique-d-essai", dureeSecondes: ttl }; } },
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => MAINTENANT,
  };
  return { p, journal, demandes };
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
    const appels: string[] = [];
    const creds = credsHumainOpenBao({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: (async (u: string) => { appels.push(u); return new Response(JSON.stringify({ lease_duration: 3600, data: { username: "v-lecture-1", password: "mdp-dynamique-un" } })); }) as unknown as typeof fetch });
    await expect(creds.emettre()).resolves.toEqual({ utilisateur: "v-lecture-1", motDePasse: "mdp-dynamique-un", dureeSecondes: 3600 });
    expect(appels).toEqual(["http://coffre.test/v1/database/creds/humain-lecture-cli"]);
    const refus = credsHumainOpenBao({ url: "http://coffre.test", jeton: "jeton-d-essai", fetch: (async () => new Response("mdp-dynamique-un", { status: 500 })) as unknown as typeof fetch });
    const e = await refus.emettre().catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "coffre_indisponible" });
    expect(String((e as Error).message)).not.toContain("mdp-dynamique-un");
  });
});
