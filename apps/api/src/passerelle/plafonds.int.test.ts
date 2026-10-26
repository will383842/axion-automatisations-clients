import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { journalEnMemoire } from "../journal-audit/port.js";
import { MICRO_CENTIMES_PAR_UNITE } from "./consommation.js";
import { creerPlafonds } from "./plafonds.js";

// Tests contre la VRAIE passerelle du socle (job socle-integration), jamais contre une imitation.
// SOCLE_PASSERELLE_URL (adresse de la passerelle sur le réseau interne) et SOCLE_LITELLM_CLE_MAITRE sont posées par le job ;
// sans elles le test ÉCHOUE (un test sauté ne prouverait rien). Le fournisseur est le faux fournisseur du socle.
const URL_P = process.env["SOCLE_PASSERELLE_URL"] ?? "";
const MAITRE = process.env["SOCLE_LITELLM_CLE_MAITRE"] ?? "";
const ADMIN = "admin-test";
const PLAFOND = 0.002; // unité de la passerelle, fictif
const PLAFOND_MICRO = Math.round(PLAFOND * MICRO_CENTIMES_PAR_UNITE);

async function passerelle(chemin: string, cle: string, corps?: unknown): Promise<{ statut: number; json: Record<string, unknown> }> {
  const r = await fetch(`${URL_P}${chemin}`, {
    method: corps === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return { statut: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const appelIA = (cle: string) => passerelle("/v1/chat/completions", cle, { model: "claude-standard", messages: [{ role: "user", content: "essai" }], max_tokens: 5 });

async function nouvelleCle(tenant: string): Promise<{ cle: string; token: string }> {
  const r = await passerelle("/key/generate", MAITRE, { key_alias: `cli-${tenant}`, metadata: { tenant_id: tenant }, models: ["claude-standard"] });
  const cle = String(r.json["key"] ?? "");
  const info = await passerelle(`/key/info?key=${encodeURIComponent(cle)}`, MAITRE);
  return { cle, token: String((info.json["info"] as { token?: string } | undefined)?.token ?? "") };
}
const depense = async (cle: string) => Number(((await passerelle(`/key/info?key=${encodeURIComponent(cle)}`, MAITRE)).json["info"] as { spend: number }).spend);

function montee() {
  const journal = journalEnMemoire();
  const p = creerPlafonds({ url: URL_P, lireCleMaitre: async () => MAITRE, journal, estAdministrateur: async (id) => id === ADMIN, plafondCleMax: PLAFOND_MICRO * 10 });
  return { journal, p };
}

describe("plafonds contre la vraie passerelle", () => {
  it("[C-437] @argent la passerelle est joignable avec la clé maîtresse (sinon le job échoue, il ne saute pas)", async () => {
    expect(URL_P, "SOCLE_PASSERELLE_URL absente").not.toBe("");
    expect(MAITRE, "SOCLE_LITELLM_CLE_MAITRE absente").not.toBe("");
    expect((await passerelle("/key/list", MAITRE)).statut).toBe(200);
  });

  it("[C-437] @argent MARGE mesurée : une clé au plafond est refusée par la passerelle, le dépassement ne dépasse pas un appel", async () => {
    const tenant = randomUUID();
    const { cle } = await nouvelleCle(tenant);
    const { p } = montee();
    await p.poserPlafondCle(tenant, PLAFOND_MICRO);
    const avant = await depense(cle);
    expect((await appelIA(cle)).statut).toBe(200);
    const coutUnAppel = (await depense(cle)) - avant;
    expect(coutUnAppel).toBeGreaterThan(0);
    let refuse = 0;
    for (let i = 0; i < 500 && refuse === 0; i++) {
      const r = await appelIA(cle);
      if (r.statut !== 200) refuse = r.statut;
    }
    expect(refuse, "aucun appel refusé en 500 essais : le plafond n'est pas tenu").not.toBe(0);
    const marge = (await depense(cle)) - PLAFOND;
    // Ligne reprise dans la description de la PR : la MARGE mesurée.
    console.info(`MARGE mesurée : ${Math.round(marge * MICRO_CENTIMES_PAR_UNITE)} micro-centimes pour un appel de ${Math.round(coutUnAppel * MICRO_CENTIMES_PAR_UNITE)}`);
    expect(marge).toBeLessThanOrEqual(coutUnAppel);
    expect((await appelIA(cle)).statut).not.toBe(200);
  }, 120_000);

  it("[C-437] @argent rafale en parallèle sur une clé plafonnée : la passerelle finit par refuser et la marge est mesurée", async () => {
    const tenant = randomUUID();
    const { cle } = await nouvelleCle(tenant);
    await montee().p.poserPlafondCle(tenant, PLAFOND_MICRO);
    const reponses = await Promise.all(Array.from({ length: 100 }, () => appelIA(cle)));
    const acceptes = reponses.filter((r) => r.statut === 200).length;
    const marge = (await depense(cle)) - PLAFOND;
    console.info(`MARGE mesurée en rafale de 100 : ${Math.round(marge * MICRO_CENTIMES_PAR_UNITE)} micro-centimes, ${acceptes} appels acceptés`);
    expect(acceptes).toBeLessThan(100);
    expect((await appelIA(cle)).statut).not.toBe(200);
  }, 120_000);

  it("[C-437] bloquerCle refuse vraiment les appels, leverBlocage les rouvre, et le journal garde les deux traces", async () => {
    const tenant = randomUUID();
    const { cle } = await nouvelleCle(tenant);
    const { p, journal } = montee();
    await p.poserPlafondCle(tenant, PLAFOND_MICRO * 10);
    expect((await appelIA(cle)).statut).toBe(200);
    await p.bloquerCle(tenant, "essai de blocage");
    expect((await appelIA(cle)).statut).not.toBe(200);
    await p.leverBlocage(tenant, { parQui: ADMIN, motif: "essai de levée" });
    expect((await appelIA(cle)).statut).toBe(200);
    expect(journal.entrees.map((e) => e.action)).toEqual(["blocage_cle", "levee_blocage_cle"]);
  }, 60_000);
});
