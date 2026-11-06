import { describe, expect, it } from "vitest";
import { absenceEnCours, creerServiceAbsence, type AbsenceEnregistree, type DepsAbsence } from "./absence.js";
import type { MembreDroits } from "./exiger-droit.js";

const will: MembreDroits = { sujet: "will", role: "dirigeant", actif: true, portee: { clients: [], automatisations: [] } };
const second: MembreDroits = { sujet: "second", role: "second_administrateur", actif: true, portee: { clients: [], automatisations: [] } };
const NOW = new Date("2026-11-06T10:00:00Z");

function service() {
  const evenements: string[] = [];
  const absences: AbsenceEnregistree[] = [];
  const d: DepsAbsence = {
    maintenant: () => NOW,
    ouverte: async () => absences.find((a) => a.fin === null),
    creer: async (a) => { evenements.push("creer"); absences.push({ id: `a${absences.length}`, ...a }); return absences.at(-1)!; },
    fermer: async (id, par) => { evenements.push("fermer"); const a = absences.find((x) => x.id === id)!; a.fin = NOW; a.fermeePar = par; },
    alerterDirigeant: async (m) => { evenements.push(`alerte:${m.type}`); },
    tracer: async (e) => { evenements.push(`trace:${e.evenement}`); },
  };
  return { s: creerServiceAbsence(d), evenements, absences };
}

describe("absence de Will", () => {
  it("[C-617] ouvrir une absence constatée alerte Will et se trace", async () => {
    const { s, evenements, absences } = service();
    const a = await s.constater(second, "injoignable depuis ce matin");
    expect(a.nature).toBe("constatee");
    expect(absences).toHaveLength(1);
    expect(evenements).toEqual(["alerte:absence_constatee", "creer", "trace:absence_constatee"]);
  });

  it("[C-617] une absence constatée exige un motif et vient du second administrateur", async () => {
    const { s, absences } = service();
    await expect(s.constater(second, "   ")).rejects.toThrow();
    await expect(s.constater(will, "motif")).rejects.toThrow();
    expect(absences).toHaveLength(0);
  });

  it("[C-617] une absence annoncée est le fait de Will seul", async () => {
    const { s } = service();
    await expect(s.annoncer(second, new Date("2026-11-07T08:00:00Z"), new Date("2026-11-10T08:00:00Z"))).rejects.toThrow();
    await expect(s.annoncer(will, new Date("2026-11-10T08:00:00Z"), new Date("2026-11-07T08:00:00Z"))).rejects.toThrow();
    expect((await s.annoncer(will, new Date("2026-11-07T08:00:00Z"), new Date("2026-11-10T08:00:00Z"))).nature).toBe("annoncee");
  });

  it("[C-617] seul Will ferme une absence", async () => {
    const { s, absences } = service();
    const a = await s.constater(second, "injoignable");
    await expect(s.fermer(second, a.id)).rejects.toThrow();
    expect(absences[0]!.fin).toBeNull();
    await s.fermer(will, a.id);
    expect(absences[0]!.fermeePar).toBe("will");
    await expect(s.fermer(will, a.id)).rejects.toThrow();
  });

  it("[C-617] une seule absence ouverte à la fois, et une absence fermée ou future ne donne aucun droit", async () => {
    const { s } = service();
    await s.constater(second, "un");
    await expect(s.constater(second, "deux")).rejects.toThrow();
    const base = { id: "x", nature: "annoncee" as const, ouvertePar: "will", fermeePar: null };
    expect(absenceEnCours({ ...base, debut: new Date("2026-11-07T00:00:00Z"), fin: null }, NOW)).toBe(false);
    expect(absenceEnCours({ ...base, debut: new Date("2026-11-05T00:00:00Z"), fin: new Date("2026-11-06T09:00:00Z") }, NOW)).toBe(false);
    expect(absenceEnCours({ ...base, debut: new Date("2026-11-05T00:00:00Z"), fin: new Date("2026-11-07T00:00:00Z") }, NOW)).toBe(true);
    expect(absenceEnCours(undefined, NOW)).toBe(false);
  });
});
