import { describe, expect, it } from "vitest";
import { GelPourLitige } from "../gel/garde.js";
import { echeance, type AlerteFin, type Dossier } from "./machine.js";
import { doubleValidationAtteinte, etapeMiseALEcart, type Validation } from "./mettre-a-l-ecart.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const DATE_FIN = "2027-01-10";
const T0 = new Date("2027-01-05T09:00:00Z");
const HEURE = 3_600_000;
const prouve = { envoyeLe: new Date("2027-01-11T00:00:00Z"), accuse: "recu:2027-01-11T08:00:00.000Z" };
const dossier = (o: Partial<Dossier> = {}): Dossier => ({ dateFin: DATE_FIN, exportReference: "ref", exportTelechargeLe: null, preavis: { 1: prouve, 20: prouve, 27: prouve }, ...o });
const val = (o: Partial<Validation> = {}): Validation => ({ tenantId: A, acteur: "will", role: "will", a: T0, reauthLe: new Date(T0.getTime() - 60_000), jetonId: `j${Math.random()}`, ...o });
const apres = (v: Validation, ms: number, o: Partial<Validation> = {}): Validation => val({ a: new Date(v.a.getTime() + ms), reauthLe: new Date(v.a.getTime() + ms - 60_000), ...o });

function monter(o: { validations?: Validation[]; gelApresLectureValidations?: boolean; gel?: boolean; echecUneFois?: string } = {}) {
  const appels: string[] = [];
  const alertes: AlerteFin[] = [];
  let gel = o.gel ?? false;
  let echec = o.echecUneFois;
  const retrait = (nom: string) => async () => { if (echec === nom) { echec = undefined; throw new Error("panne"); } appels.push(nom); };
  const etape = etapeMiseALEcart({
    gel: { gelActif: async () => gel },
    validations: async () => { if (o.gelApresLectureValidations) gel = true; return o.validations ?? []; },
    etatBase: async () => (appels.includes("marquerALEcart") ? "a_l_ecart" : "gelee"),
    retirerPgBouncer: retrait("retirerPgBouncer"), revoquerConnect: retrait("revoquerConnect"), lectureSeuleCompartiment: retrait("lectureSeuleCompartiment"),
    desactiverIdentifiants: retrait("desactiverIdentifiants"), desactiverCleIa: retrait("desactiverCleIa"), marquerALEcart: retrait("marquerALEcart"),
    alerter: async (a) => void alertes.push(a), tracer: async () => undefined, maintenant: () => new Date("2027-02-09T10:00:00Z"),
  });
  return { etape, appels, alertes };
}
const deuxWill = () => { const v1 = val(); return [v1, apres(v1, 24 * HEURE)]; };

describe("mise à l'écart à J+30", () => {
  it("[C-035] à J+30 les accès sont retirés dans l'ordre, la base passe à l'écart, aucune suppression n'est émise", async () => {
    const { etape, appels } = monter({ validations: deuxWill() });
    expect(etape.echeance(dossier())).toEqual(echeance(DATE_FIN, 30));
    await etape.faire(A, dossier());
    expect(appels).toEqual(["retirerPgBouncer", "revoquerConnect", "lectureSeuleCompartiment", "desactiverIdentifiants", "desactiverCleIa", "marquerALEcart"]);
    expect(appels.join()).not.toMatch(/supprim|detruire|effac|drop/i);
    expect(await etape.dejaFait(A, dossier())).toBe(true);
  });
  it("[A-245] la fin de contrat ne touche pas à la clé de chiffrement du client", async () => {
    const { etape, appels } = monter({ validations: deuxWill() });
    await etape.faire(A, dossier());
    expect(appels.filter((a) => /cle(?!Ia)/i.test(a))).toEqual([]);
  });
  it("[C-567] sans double confirmation, rien n'est retiré et un rappel part chaque jour vers Will", async () => {
    const { etape, appels, alertes } = monter({ validations: [val()] });
    await etape.faire(A, dossier());
    expect(appels).toEqual([]);
    expect(alertes).toEqual([{ type: "fin_de_contrat", clientId: A, code: "confirmation_mise_a_l_ecart_attendue_2027-02-09" }]);
    expect(await etape.dejaFait(A, dossier())).toBe(false);
  });
  it("[C-567] deux confirmations de Will à 24 h d'écart, chacune réauthentifiée, comptent ; à 23 h 59, non", () => {
    expect(doubleValidationAtteinte(A, deuxWill())).toBe(true);
    const v1 = val();
    expect(doubleValidationAtteinte(A, [v1, apres(v1, 24 * HEURE - 60_000)])).toBe(false);
  });
  it("[C-567] une confirmation de Will et une du second administrateur comptent", () => {
    const v1 = val();
    expect(doubleValidationAtteinte(A, [v1, apres(v1, 1000, { acteur: "second", role: "second_administrateur" })])).toBe(true);
    expect(doubleValidationAtteinte(A, [v1, apres(v1, 1000, { acteur: "will", role: "second_administrateur" })])).toBe(false);
  });
  it("[C-567] une confirmation sans réauthentification récente, rejouée ou posée pour un autre client n'est pas comptée", () => {
    const v1 = val();
    const lointain = (m: number) => apres(v1, 25 * HEURE, m === 0 ? { reauthLe: null } : m === 1 ? { reauthLe: new Date(v1.a.getTime() + 25 * HEURE - 6 * 60_000) } : m === 2 ? { jetonId: v1.jetonId } : { tenantId: B });
    for (const m of [0, 1, 2, 3]) expect(doubleValidationAtteinte(A, [v1, lointain(m)])).toBe(false);
  });
  it("[C-609] un gel posé juste avant l'action bloque la mise à l'écart", async () => {
    const posee = monter({ validations: deuxWill(), gelApresLectureValidations: true });
    await expect(posee.etape.faire(A, dossier())).rejects.toBeInstanceOf(GelPourLitige);
    expect(posee.appels).toEqual([]);
    const avant = monter({ validations: deuxWill(), gel: true });
    await expect(avant.etape.faire(A, dossier())).rejects.toBeInstanceOf(GelPourLitige);
  });
  it("[A-255] un préavis envoyé sans accusé n'est pas prouvé : pas de mise à l'écart, alerte sur ce préavis", async () => {
    const { etape, appels, alertes } = monter({ validations: deuxWill() });
    await etape.faire(A, dossier({ preavis: { 1: prouve, 20: { envoyeLe: prouve.envoyeLe, accuse: null }, 27: prouve } }));
    expect(appels).toEqual([]);
    expect(alertes).toContainEqual({ type: "fin_de_contrat", clientId: A, code: "preavis_j20_sans_accuse" });
  });
  it("[C-035] une mise à l'écart à moitié faite est reprise jusqu'à l'état final complet", async () => {
    const { etape, appels } = monter({ validations: deuxWill(), echecUneFois: "revoquerConnect" });
    await expect(etape.faire(A, dossier())).rejects.toThrow();
    expect(await etape.dejaFait(A, dossier())).toBe(false);
    await etape.faire(A, dossier());
    expect(appels.at(-1)).toBe("marquerALEcart");
    expect(await etape.dejaFait(A, dossier())).toBe(true);
  });
});
