import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ErreurApi } from "../plugins/erreurs.js";
import { envoisServiceEnMemoire } from "../envois/service.js";
import { demanderAccord, tracerFermeture, tracerPage, traceSql, type EntreeTrace } from "./trace.js";

// Trace et avis (T3-08a). Le motif et la page vont au journal d'audit : un code fermé, jamais une adresse ni un titre.
const A = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-11-07T10:00:00Z");
const maintenant = () => T0;
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;

describe("trace des pages", () => {
  it("[C-009] chaque page consultée est tracée avec le membre, le client, le code de page et l'heure du serveur", async () => {
    const traces: EntreeTrace[] = [];
    const d = { trace: { ecrire: async (e: EntreeTrace) => void traces.push(e) }, maintenant };
    for (const page of ["fiche", "personnes", "fichiers-2"]) await tracerPage(d, A, "e1", page);
    expect(traces).toEqual(["fiche", "personnes", "fichiers-2"].map((page) => ({ tenantId: A, acteur: "e1", evenement: "page_consultee", page, le: T0 })));
    // Un code hors format (adresse, titre, majuscules, vide, trop long) est refusé sans trace.
    for (const page of ["https://x.test/a", "Fiche client", "FICHE", "", "a".repeat(41), "../x"]) expect(await code(tracerPage(d, A, "e1", page)), page).toBe("schema_invalide");
    expect(traces).toHaveLength(3);
  });

  it("[C-009] sans trace, pas de page : une trace en panne fait échouer la page", async () => {
    const d = { trace: { ecrire: async () => { throw new Error("base"); } }, maintenant };
    expect(await code(tracerPage(d, A, "e1", "fiche"))).toBe("erreur_interne");
  });

  it("[B-420] la demande d'accord écrit part au client une fois par jour et se trace, sans écrire d'accord", async () => {
    const envois = envoisServiceEnMemoire();
    const traces: EntreeTrace[] = [];
    const d = { envois, trace: { ecrire: async (e: EntreeTrace) => void traces.push(e) }, maintenant };
    await demanderAccord(d, A, "e1");
    await demanderAccord(d, A, "e1");
    expect(envois.deposes).toHaveLength(1);
    expect(envois.deposes[0]).toMatchObject({ type: "demande_accord_vue_client", clientId: A });
    expect(envois.deposes[0]?.cle).toContain(A);
    expect(traces.map((t) => t.evenement)).toEqual(["demande_accord_envoyee", "demande_accord_envoyee"]);
    await demanderAccord({ ...d, maintenant: () => new Date(T0.getTime() + 86_400_000) }, A, "e1");
    expect(envois.deposes).toHaveLength(2);
    // L'avis en panne : pas de trace.
    const panne = { envois: { deposerService: async () => { throw new Error("boîte"); } }, trace: d.trace, maintenant };
    expect(await code(demanderAccord(panne, A, "e1"))).toBe("erreur_interne");
    expect(traces).toHaveLength(3);
  });

  it("[C-009] la fermeture de la vue est tracée", async () => {
    const traces: EntreeTrace[] = [];
    await tracerFermeture({ trace: { ecrire: async (e: EntreeTrace) => void traces.push(e) }, maintenant }, A, "e1");
    expect(traces).toEqual([{ tenantId: A, acteur: "e1", evenement: "vue_client_fermee", le: T0 }]);
  });

  it("[C-009] l'adaptateur SQL écrit par audit_ajouter, dans le client actif, avec une entité fixe", async () => {
    const requetes: { texte: string; valeurs: unknown[] }[] = [];
    const client = { query: async (texte: string, valeurs: unknown[] = []) => { requetes.push({ texte, valeurs }); return { rows: [], rowCount: 0 }; }, release: () => {} };
    const pool = { connect: async () => client } as unknown as Pool;
    await traceSql(pool).ecrire({ tenantId: A, acteur: "e1", evenement: "page_consultee", page: "fiche", le: T0 });
    const audit = requetes.find((r) => r.texte.includes("audit_ajouter"));
    expect(audit?.texte).toContain("'vue_client'");
    expect(audit?.valeurs[0]).toBe(A);
    expect(audit?.valeurs[1]).toBe("e1");
    expect(JSON.parse(String(audit?.valeurs[2]))).toMatchObject({ evenement: "page_consultee", page: "fiche" });
    expect(requetes.some((r) => r.texte.includes("app.tenant_id") && r.valeurs[0] === A)).toBe(true);
  });
});
