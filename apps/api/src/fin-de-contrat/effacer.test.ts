import { describe, expect, it } from "vitest";
import type { Validation } from "./mettre-a-l-ecart.js";
import { gestionnaireEffacement, type Source } from "./effacer.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P1 = "55555555-5555-4555-8555-555555555555";
const D1 = "99999999-9999-4999-8999-999999999999";
const T0 = new Date("2029-03-01T10:00:00Z");
const val = (o: Partial<Validation> = {}): Validation => ({ tenantId: A, acteur: "will", role: "will", a: T0, reauthLe: new Date(T0.getTime() - 60_000), jetonId: `j${Math.random()}`, ...o });
const deux = (): Validation[] => [val(), val({ a: new Date(T0.getTime() + 24 * 3_600_000), reauthLe: new Date(T0.getTime() + 24 * 3_600_000 - 60_000), acteur: "second", role: "second_administrateur" })];
const source = (o: Partial<Source> = {}): Source => ({ genre: "proposition", id: P1, tenantId: A, etat: "acceptee", validations: deux(), exportRemis: true, ...o });

function monter(o: { source?: Source | undefined; actif?: boolean; base?: string; gel?: boolean; gelEntreTemps?: boolean; echec?: string } = {}) {
  const appels: string[] = [];
  const traces: string[] = [];
  const marques: string[] = [];
  let gel = o.gel ?? false;
  const pas = (n: string) => async (t: string) => { if (o.echec === n) throw new Error("panne"); appels.push(`${n}:${t}`); };
  const p = {
    actif: () => o.actif ?? true,
    gel: { gelActif: async () => gel },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      source: async () => { const s = "source" in o ? o.source : source(); if (o.gelEntreTemps) gel = true; return s; },
      etatBase: async () => o.base ?? "a_l_ecart",
      gelActif: async () => gel,
    }),
    supprimerBase: pas("supprimerBase"), retirerCompartiment: pas("retirerCompartiment"), detruireCleClient: pas("detruireCleClient"), purgerCoffre: pas("purgerCoffre"), supprimerRoles: pas("supprimerRoles"),
    marquerEffacee: async (t: string) => void marques.push(`effacee:${t}`),
    marquerExecutee: async (s: { id: string }) => void marques.push(`executee:${s.id}`),
    tracer: async (e: Record<string, unknown>) => void traces.push(String(e["type"])),
  };
  return { gerer: gestionnaireEffacement(p as never), appels, traces, marques };
}

describe("effacement exceptionnel", () => {
  it("[A-253] proposition acceptée relue en base, double validation, export remis, interrupteur ouvert : l'effacement a lieu une fois, tracé", async () => {
    const m = monter();
    expect(await m.gerer({ genre: "proposition", id: P1 })).toBe("efface");
    expect(m.appels).toEqual(["supprimerBase", "retirerCompartiment", "detruireCleClient", "purgerCoffre", "supprimerRoles"].map((n) => `${n}:${A}`));
    expect(m.marques).toEqual([`effacee:${A}`, `executee:${P1}`]);
    expect(m.traces).toContain("effacement_execute");
  });
  it("[A-257] interrupteur fermé : rien n'est effacé et la tentative est tracée", async () => {
    const m = monter({ actif: false });
    expect(await m.gerer({ genre: "proposition", id: P1 })).toBe("refuse");
    expect(m.appels).toEqual([]);
    expect(m.traces).toEqual(["effacement_refuse_interrupteur_ferme"]);
  });
  it("[C-715] le gestionnaire relit l'état en base : une proposition repassée à écartée ou encore en attente n'est pas effacée", async () => {
    for (const etat of ["ecartee", "en_attente", "reexamen", "executee"]) {
      const m = monter({ source: source({ etat }) });
      expect(await m.gerer({ genre: "proposition", id: P1 })).toBe("refuse");
      expect(m.appels).toEqual([]);
    }
    expect(await monter({ source: undefined }).gerer({ genre: "proposition", id: P1 })).toBe("refuse");
  });
  it("[C-037] pas d'effacement sans base à l'écart, double validation atteinte et export remis", async () => {
    const un = [val()];
    for (const m of [monter({ base: "gelee" }), monter({ source: source({ validations: un }) }), monter({ source: source({ exportRemis: false }) }), monter({ source: source({ validations: [val({ reauthLe: null }), val({ reauthLe: null })] }) })]) {
      expect(await m.gerer({ genre: "proposition", id: P1 })).toBe("refuse");
      expect(m.appels).toEqual([]);
    }
  });
  it("[C-609] un gel posé entre la décision et l'action bloque l'effacement", async () => {
    const m = monter({ gelEntreTemps: true });
    expect(await m.gerer({ genre: "proposition", id: P1 })).toBe("refuse");
    expect(m.appels).toEqual([]);
    expect(await monter({ gel: true }).gerer({ genre: "demande", id: D1 })).toBe("refuse");
  });
  it("[A-256] @isolation le client effacé est celui de la source relue en base, jamais un identifiant du message ni un autre client", async () => {
    const m = monter({ source: source({ tenantId: B, validations: deux().map((v) => ({ ...v, tenantId: B })) }) });
    await m.gerer({ genre: "proposition", id: P1, tenantId: A } as never);
    expect(m.appels.every((a) => a.endsWith(`:${B}`))).toBe(true);
    const mauvais = monter({ source: source({ tenantId: "pas-un-uuid" }) });
    expect(await mauvais.gerer({ genre: "proposition", id: P1 })).toBe("refuse");
    expect(mauvais.appels).toEqual([]);
  });
  it("[C-715] executee n'est posé qu'après l'effacement réussi", async () => {
    const m = monter({ echec: "purgerCoffre" });
    await expect(m.gerer({ genre: "proposition", id: P1 })).rejects.toThrow();
    expect(m.marques).toEqual([]);
  });
});
