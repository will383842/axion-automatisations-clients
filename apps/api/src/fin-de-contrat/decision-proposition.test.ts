import { describe, expect, it } from "vitest";
import type { AlerteFin } from "./machine.js";
import type { Validation } from "./mettre-a-l-ecart.js";
import { accepterProposition, ecarterProposition, idTacheEffacement, reexaminerApresLevee, transitionPermise, type EtatProposition, type Proposition, type SessionDecision } from "./decision-proposition.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FIN = "33333333-3333-4333-8333-333333333333";
const P1 = "55555555-5555-4555-8555-555555555555";
const P2 = "66666666-6666-4666-8666-666666666666";
const G1 = "77777777-7777-4777-8777-777777777777";
const G2 = "88888888-8888-4888-8888-888888888888";
const HEURE = 3_600_000;
let NOW = new Date("2029-03-01T10:00:00Z");
const prop = (o: Partial<Proposition> = {}): Proposition => ({ id: P1, tenantId: A, finDeContratId: FIN, echeance: "2029-01-10", etat: "en_attente", avisEnvoyeLe: new Date("2029-01-11T10:00:00Z"), gelId: null, ...o });
const session = (o: Partial<SessionDecision> = {}): SessionDecision => ({ acteur: "will", role: "will", reauthLe: new Date(NOW.getTime() - 60_000), jetonId: `j${Math.random()}`, ...o });

function monter(o: { props?: Proposition[]; gelsActifs?: string[]; gel?: boolean } = {}) {
  const props = new Map((o.props ?? [prop()]).map((p) => [p.id, { ...p }]));
  const validations: (Validation & { cible: string })[] = [];
  const jobs: string[] = [];
  const alertes: AlerteFin[] = [];
  const planifiees: string[] = [];
  const nouvelles: string[] = [];
  const p = {
    gel: { gelActif: async () => o.gel ?? false },
    gelActifId: async (_t: string, g: string) => (o.gelsActifs ?? []).includes(g),
    maintenant: () => NOW,
    proposition: async (t: string, id: string) => { const x = props.get(id); return x && x.tenantId === t ? { ...x } : undefined; },
    propositionsParGel: async (t: string, g: string) => [...props.values()].filter((x) => x.tenantId === t && x.gelId === g && x.etat === "ecartee").map((x) => ({ ...x })),
    demandesParGel: async () => [] as { id: string }[],
    alerter: async (a: AlerteFin) => void alertes.push(a),
    transaction: async <T>(id: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const tx = {
        gelActif: async () => o.gel ?? false,
        ajouterValidation: async (v: Validation) => { if (validations.some((x) => x.jetonId === v.jetonId)) return false; validations.push({ ...v, cible: id }); return true; },
        validations: async () => validations.filter((v) => v.cible === id),
        poserAcceptee: async () => { const x = props.get(id); if (x?.etat !== "en_attente") return false; x.etat = "acceptee"; return true; },
        poser: async (vers: EtatProposition, extra?: { gelId?: string }) => { const x = props.get(id); if (!x || !transitionPermise(x.etat, vers)) return false; x.etat = vers; if (extra?.gelId) x.gelId = extra.gelId; return true; },
        mettreEnFile: async (jobId: string) => void jobs.push(jobId),
        planifierProposition: async (_f: string, e: string) => void planifiees.push(e),
        creerProposition: async (_f: string, e: string) => void nouvelles.push(e),
      };
      return fn(tx);
    },
  };
  return { p: p as never, props, validations, jobs, alertes, planifiees, nouvelles, brut: p };
}

describe("décision sur une proposition de suppression", () => {
  it("[C-715] l'acceptation exige la double validation et un avis au client de 30 jours au moins", async () => {
    const m = monter();
    expect(await accepterProposition(m.p, A, P1, session())).toBe("validation_enregistree");
    expect(m.props.get(P1)?.etat).toBe("en_attente");
    expect(m.jobs).toEqual([]);
    NOW = new Date(NOW.getTime() + 25 * HEURE);
    expect(await accepterProposition(m.p, A, P1, session())).toBe("acceptee");
    expect(m.props.get(P1)?.etat).toBe("acceptee");
    expect(m.jobs).toEqual([`effacement-${P1}`]);
    const court = monter({ props: [prop({ avisEnvoyeLe: new Date(NOW.getTime() - 29 * 24 * HEURE) })] });
    await expect(accepterProposition(court.p, A, P1, session())).rejects.toMatchObject({ code: "regle_metier" });
    const sansAvis = monter({ props: [prop({ avisEnvoyeLe: null })] });
    await expect(accepterProposition(sansAvis.p, A, P1, session())).rejects.toMatchObject({ code: "regle_metier" });
    NOW = new Date("2029-03-01T10:00:00Z");
  });
  it("[C-715] Will et le second administrateur suffisent ; sans réauthentification récente ou avec un jeton rejoué, rien n'est compté", async () => {
    const m = monter();
    const j = "jeton-1";
    expect(await accepterProposition(m.p, A, P1, session({ jetonId: j }))).toBe("validation_enregistree");
    await expect(accepterProposition(m.p, A, P1, session({ jetonId: j, acteur: "second", role: "second_administrateur" }))).rejects.toMatchObject({ code: "regle_metier" });
    await expect(accepterProposition(m.p, A, P1, session({ acteur: "second", role: "second_administrateur", reauthLe: new Date(NOW.getTime() - 6 * 60_000) }))).rejects.toMatchObject({ code: "reauthentification_requise" });
    await expect(accepterProposition(m.p, A, P1, session({ reauthLe: null }))).rejects.toMatchObject({ code: "reauthentification_requise" });
    expect(await accepterProposition(m.p, A, P1, session({ acteur: "second", role: "second_administrateur" }))).toBe("acceptee");
    expect(m.jobs).toHaveLength(1);
  });
  it("[C-609] un gel actif bloque l'acceptation", async () => {
    const m = monter({ gel: true });
    await expect(accepterProposition(m.p, A, P1, session())).rejects.toMatchObject({ code: "regle_metier" });
    expect(m.validations).toEqual([]);
  });
  it("[C-715] accepter ou écarter la proposition d'un autre client sous l'URL de A répond 404 et n'écrit rien", async () => {
    const m = monter({ props: [prop({ tenantId: B })] });
    await expect(accepterProposition(m.p, A, P1, session())).rejects.toMatchObject({ code: "introuvable" });
    await expect(ecarterProposition(m.p, A, P1, { cause: "decision_de_will", motif: "x" }, session())).rejects.toMatchObject({ code: "introuvable" });
    expect(m.validations).toEqual([]);
    expect(m.jobs).toEqual([]);
    expect(m.props.get(P1)?.etat).toBe("en_attente");
  });
  it("[C-715] écarter exige une cause de la liste fermée et un motif ; une nouvelle proposition est prévue 12 mois plus tard", async () => {
    const m = monter();
    await expect(ecarterProposition(m.p, A, P1, { cause: "decision_de_will", motif: "  " }, session())).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(ecarterProposition(m.p, A, P1, { cause: "caprice" as never, motif: "x" }, session())).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(ecarterProposition(m.p, A, P1, { cause: "decision_de_will", motif: "client à revoir" }, session({ role: "second_administrateur" }))).rejects.toMatchObject({ code: "action_interdite" });
    await ecarterProposition(m.p, A, P1, { cause: "decision_de_will", motif: "client à revoir" }, session());
    expect(m.props.get(P1)?.etat).toBe("ecartee");
    expect(m.planifiees).toEqual(["2030-01-10"]);
  });
  it("[C-715] écarter pour litige sans gel actif est rejeté ; avec un gel actif, le gel est noté", async () => {
    const sans = monter();
    await expect(ecarterProposition(sans.p, A, P1, { cause: "litige_en_cours", gelId: G1, motif: "litige" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    await expect(ecarterProposition(sans.p, A, P1, { cause: "obligation_legale", motif: "texte" }, session())).rejects.toMatchObject({ code: "regle_metier" });
    const avec = monter({ gelsActifs: [G1] });
    await ecarterProposition(avec.p, A, P1, { cause: "litige_en_cours", gelId: G1, motif: "litige" }, session());
    expect(avec.props.get(P1)).toMatchObject({ etat: "ecartee", gelId: G1 });
  });
  it("[C-715] à la levée du gel, la proposition écartée pour CE gel passe à réexamen et une nouvelle est créée ; l'autre ne bouge pas", async () => {
    const m = monter({ props: [prop({ etat: "ecartee", gelId: G1 }), prop({ id: P2, etat: "ecartee", gelId: G2 })] });
    await reexaminerApresLevee(m.p, A, G1);
    expect(m.props.get(P1)?.etat).toBe("reexamen");
    expect(m.props.get(P2)?.etat).toBe("ecartee");
    expect(m.nouvelles).toHaveLength(1);
    expect(m.alertes.length).toBeGreaterThan(0);
    expect(m.jobs).toEqual([]);
  });
  it("[C-715] états d'une proposition : chaque transition autorisée réussit, chaque autre est refusée", () => {
    const etats: EtatProposition[] = ["en_attente", "acceptee", "ecartee", "reexamen", "executee"];
    const permises = new Set(["en_attente>acceptee", "en_attente>ecartee", "ecartee>reexamen", "acceptee>executee"]);
    for (const de of etats) for (const vers of etats) expect(transitionPermise(de, vers)).toBe(permises.has(`${de}>${vers}`));
  });
  it("[C-715] l'identifiant de tâche d'effacement ne contient pas de deux-points", () => {
    expect(idTacheEffacement("proposition", P1)).toBe(`effacement-${P1}`);
    expect(idTacheEffacement("demande", P1)).toBe(`effacement-demande-${P1}`);
    expect(() => idTacheEffacement("proposition", "a:b")).toThrow();
  });
});
