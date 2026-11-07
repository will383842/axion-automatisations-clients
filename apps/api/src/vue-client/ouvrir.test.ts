import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { envoisServiceEnMemoire, type EnvoisService } from "../envois/service.js";
import type { SessionDonnees } from "../donnees/service.js";
import { creerRegistreVues, ouvrirVue } from "./ouvrir.js";
import { consignerOuverture, type EntreeTrace } from "./trace.js";

// Registre des vues et ouverture (T3-08a) : horloge injectée, ports en mémoire, espions qui comptent chaque appel.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-11-07T10:00:00Z");
const session: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [] };
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;

function monde(o: { accord?: (tenantId: string) => Promise<boolean>; fin?: (t: number) => Date; panneAvis?: boolean; panneTrace?: boolean } = {}) {
  let t = T0.getTime();
  const maintenant = () => new Date(t);
  const registre = creerRegistreVues(maintenant);
  const reel = envoisServiceEnMemoire();
  const envois: EnvoisService = o.panneAvis ? { deposerService: async () => { throw new Error("boîte en panne"); } } : reel;
  const traces: EntreeTrace[] = [];
  const trace = { ecrire: async (e: EntreeTrace) => { if (o.panneTrace) throw new Error("base"); traces.push(e); } };
  const compte = { accord: 0, fin: 0 };
  const deps = {
    accordValide: async (tenantId: string) => { compte.accord++; return (o.accord ?? (async () => true))(tenantId); },
    finIntervention: async () => { compte.fin++; return (o.fin ?? ((x) => new Date(x + 7_200_000)))(t); },
    tracer: consignerOuverture({ envois, trace, maintenant }),
    maintenant,
  };
  const ouvrir = (tenantId = A, motif = "assistance") => ouvrirVue(registre, deps, session, tenantId, motif, "administrateur");
  return { registre, ouvrir, traces, avis: reel.deposes, compte, avancer: (ms: number) => { t += ms; } };
}

describe("registre des vues et ouverture", () => {
  it("[C-007] @isolation sans accord valide, la vue est refusée", async () => {
    const refus = [
      monde({ accord: async () => false }),
      monde({ accord: async () => { throw new Error("base"); } }),
      monde({ accord: async (id) => id === B }), // accord d'un AUTRE client
      monde({ fin: (x) => new Date(x) }), // la fin de l'intervention est l'instant exact de l'ouverture
    ];
    for (const m of refus) {
      expect(await code(m.ouvrir())).toBe("action_interdite");
      expect(m.traces).toEqual([]);
      expect(m.avis).toEqual([]);
      expect(m.registre.vueDe("e1")).toBeUndefined();
    }
    // Le refus libère la réservation : une ouverture valable passe ensuite.
    const m = monde({ accord: async (id) => id === B });
    expect(await code(m.ouvrir(A))).toBe("action_interdite");
    expect((await m.ouvrir(B)).vue?.tenantId).toBe(B);
  });

  it("[B-066] la vue dure 60 minutes et n'est jamais renouvelée en silence", async () => {
    const m = monde();
    const s = await m.ouvrir();
    expect(s.vue?.expireLe).toEqual(new Date(T0.getTime() + 3_600_000));
    // Une 2e ouverture pendant la vue (même client, ou un autre) : refusée, sans nouvel avis ni nouvelle trace.
    expect(await code(m.ouvrir(A))).toBe("regle_metier");
    expect(await code(m.ouvrir(B))).toBe("regle_metier");
    expect(m.avis).toHaveLength(1);
    expect(m.traces).toHaveLength(1);
    expect(m.registre.vueDe("e1")?.expireLe).toEqual(new Date(T0.getTime() + 3_600_000));
    // Après l'expiration : nouvelle ouverture = nouvelle trace et nouvel avis.
    m.avancer(3_600_000);
    expect(m.registre.vueDe("e1")).toBeUndefined();
    await m.ouvrir();
    expect(m.avis).toHaveLength(2);
    expect(m.traces).toHaveLength(2);
  });

  it("[B-066] deux ouvertures simultanées : une seule réussit, un seul avis", async () => {
    const m = monde({ accord: async () => { await new Promise((r) => setTimeout(r, 5)); return true; } });
    const r = await Promise.allSettled([m.ouvrir(A), m.ouvrir(B), m.ouvrir(A)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(2);
    expect(m.avis).toHaveLength(1);
    expect(m.traces).toHaveLength(1);
    expect(m.compte.accord).toBe(1);
  });

  it("[B-069] l'ouverture prévient le client dans le même geste : avis ou trace en panne, pas de vue", async () => {
    const avisEnPanne = monde({ panneAvis: true });
    expect(await code(avisEnPanne.ouvrir())).toBe("erreur_interne");
    expect(avisEnPanne.traces).toEqual([]);
    expect(avisEnPanne.registre.vueDe("e1")).toBeUndefined();
    const traceEnPanne = monde({ panneTrace: true });
    expect(await code(traceEnPanne.ouvrir())).toBe("erreur_interne");
    expect(traceEnPanne.registre.vueDe("e1")).toBeUndefined();
    // Cas nominal : l'avis part AVANT la trace, avec une clé qui inclut le client et l'acteur.
    const ok = monde();
    await ok.ouvrir();
    expect(ok.avis[0]).toMatchObject({ type: "avis_vue_client_ouverte", clientId: A });
    expect(ok.avis[0]?.cle).toContain(`${A}:e1:`);
    expect(ok.traces[0]).toMatchObject({ tenantId: A, acteur: "e1", evenement: "vue_client_ouverte", motif: "assistance" });
  });

  it("[B-066] le registre ne rend une vue que pour son acteur et son client, et fermer la retire", async () => {
    const m = monde();
    await m.ouvrir();
    expect(m.registre.vueRangee("e1", A)).toBeDefined();
    expect(m.registre.vueRangee("e1", B)).toBeUndefined();
    expect(m.registre.vueRangee("e2", A)).toBeUndefined();
    expect(m.registre.fermer("e1")?.tenantId).toBe(A);
    expect(m.registre.vueDe("e1")).toBeUndefined();
  });
});
