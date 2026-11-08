import { describe, expect, it } from "vitest";
import { TABLE_ENVOIS, type Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { creerExpediteur, type Trace } from "../courriel/expediteur.js";
import { expedierResumes, preparerResumes, type PortsResume } from "./resume-hebdo.js";

const A = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LUNDI = new Date("2026-11-09T06:00:00Z");
const LIGNE: Envoi = { evenement: "resumeHebdomadaire", destinataire: "administrateur_client", canal: "email", mode: "automatique", interrupteur: "envoi.resumeHebdomadaire", cleTexte: null, version: "V2", exigence: "B-186" };

function ports(o: Partial<PortsResume> & { lignes?: { tenantId: string; utilisateur: string; resumeHebdomadaire: boolean }[] } = {}): PortsResume {
  return {
    preferences: async () => o.lignes ?? [{ tenantId: A, utilisateur: U1, resumeHebdomadaire: true }, { tenantId: A, utilisateur: U2, resumeHebdomadaire: false }],
    heuresGagnees: o.heuresGagnees ?? (async () => 12),
    enAttente: o.enAttente ?? (async () => 3),
    incidents: o.incidents ?? (async () => 0),
  };
}

describe("résumé hebdomadaire (inerte)", () => {
  it("[B-186] un utilisateur coupe le résumé hebdomadaire : plus de résumé", async () => {
    const avant = await preparerResumes(LUNDI, ports());
    expect(avant.map((r) => r.utilisateur)).toEqual([U1]);
    const apres = await preparerResumes(LUNDI, ports({ lignes: [{ tenantId: A, utilisateur: U1, resumeHebdomadaire: false }] }));
    expect(apres).toEqual([]);
  });

  it("[B-186] source absente : rubrique omise, jamais 0", async () => {
    const [r] = await preparerResumes(LUNDI, ports({ heuresGagnees: async () => undefined, incidents: async () => { throw new Error("source indisponible"); } }));
    expect(r!.rubriques).toEqual({ enAttente: 3 });
    expect("heuresGagnees" in r!.rubriques).toBe(false);
    expect("incidents" in r!.rubriques).toBe(false);
  });

  it("[B-186] le lundi, un seul résumé par utilisateur volontaire (jobId par semaine)", async () => {
    const [a] = await preparerResumes(LUNDI, ports());
    const [b] = await preparerResumes(new Date("2026-11-09T18:30:00Z"), ports());
    const [suivante] = await preparerResumes(new Date("2026-11-16T06:00:00Z"), ports());
    expect(a!.jobId).toBe(b!.jobId);
    expect(a!.jobId).not.toBe(suivante!.jobId);
    expect(a!.semaine).toBe("2026-S46");
  });

  it("[B-186] sans la ligne resumeHebdomadaire dans la vraie table, aucun résumé ne part (refus tracé)", async () => {
    const envoyes: unknown[] = [];
    const traces: Trace[] = [];
    const construire = (table: readonly Envoi[]) => creerExpediteur({ table, transport: { async envoyer(m) { envoyes.push(m); } }, interrupteurs: { ouvert: () => true }, trace: { ecrire: (t) => void traces.push(t) }, adresses: {}, cleTrace: "TEST-NE-PAS-UTILISER-cle-trace" });
    const resumes = await preparerResumes(LUNDI, ports());
    expect(await expedierResumes(resumes, construire(TABLE_ENVOIS))).toEqual({ envoyes: 0, refuses: 1 });
    expect(envoyes).toEqual([]);
    expect(traces.map((t) => t.resultat)).toEqual(["refuse"]);
    // Même avec une copie de la table qui porte la ligne, le texte n'existe pas au catalogue : rien ne part.
    expect(await expedierResumes(resumes, construire([...TABLE_ENVOIS, LIGNE]))).toEqual({ envoyes: 0, refuses: 1 });
    expect(envoyes).toEqual([]);
  });
});
