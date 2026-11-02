import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminRotationPg, creerRotation, DELAI_GRACE_MS, deposerRotation, idTacheRotation, periodeDe, PERIODE_DEFAUT_JOURS, type PortsRotation } from "./rotation.js";
import type { SessionEquipe } from "../gel/gel.js";

const T = randomUUID();
const ID = T.replaceAll("-", "").slice(0, 12);
const BASE = `cli_${ID}`;
const MDP = ["premier-mot-de-passe", "second-mot-de-passe", "troisieme-mot-de-passe"];
const session = (o: Partial<SessionEquipe> = {}): SessionEquipe => ({ acteur: "equipe-1", role: "administrateur", clientActifId: T, reauthentifie: true, ...o });

function monter(o: { etat?: string; rolePresent?: boolean; echecRole?: boolean } = {}) {
  let maintenant = Date.parse("2027-01-10T10:00:00Z");
  let n = 0;
  const coffre = new Map<string, string>();
  const versions = new Map<string, number>();
  const role = { empreinte: "", version: 0, validJusqua: undefined as Date | undefined };
  const evenements: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const taches: { nom: string; donnees: unknown; options: Record<string, unknown> }[] = [];
  let pris = false;
  const p: PortsRotation = {
    base: async () => ({ etat: (o.etat ?? "active") as "active", grappe: "donnees-1", nomBase: `cli_${T.replaceAll("-", "")}` }),
    admin: () => ({
      async changerMotDePasse(r, empreinte, version, validJusqua) {
        if (o.echecRole) throw new Error(`échec avec ${empreinte}`);
        evenements.push(`role:${r}`);
        Object.assign(role, { empreinte, version, validJusqua });
      },
    }),
    coffre: {
      ranger: async (c, v) => { evenements.push("coffre"); coffre.set(c, v); const k = (versions.get(c) ?? 0) + 1; versions.set(c, k); return k; },
    },
    bouncer: () => ({ reconnecter: async (b) => { evenements.push(`reconnecter:${b}`); } }),
    verrou: { prendre: async () => { if (pris) return undefined; pris = true; return async () => { pris = false; }; } },
    motDePasse: () => MDP[n++ % 3]!,
    empreinte: (m) => `SCRAM-SHA-256$4096:sel$${m}:cle`,
    journal: { tracer: (e) => { journal.push(e); } },
    maintenant: () => new Date(maintenant),
    periodeJours: PERIODE_DEFAUT_JOURS,
  };
  const file = { async add(nom: string, donnees: unknown, options: Record<string, unknown>) { taches.push({ nom, donnees, options }); } };
  return { p, file, coffre, role, evenements, journal, taches, avancer: (ms: number) => { maintenant += ms; }, bloquer: () => { pris = true; } };
}

describe("rotation des mots de passe", () => {
  it("[A-169] la rotation planifiée change le mot de passe ; l'ancien est refusé après la période de grâce", async () => {
    const m = monter();
    const rot = creerRotation(m.p);
    await rot.pourBase(T, m.file);
    expect(m.coffre.get(`technique/donnees/${BASE}/app`)).toBe(MDP[0]);
    expect(m.role).toMatchObject({ empreinte: `SCRAM-SHA-256$4096:sel$${MDP[0]}:cle`, version: 1 });
    // Le coffre est mis à jour AVANT le rôle (jamais un rôle dont le mot de passe serait inconnu).
    expect(m.evenements).toEqual(["coffre", `role:cli_${ID}_app`]);
    // La grâce de 10 minutes se règle par une tâche différée de reconnexion PgBouncer.
    expect(DELAI_GRACE_MS).toBe(600_000);
    expect(m.taches).toHaveLength(1);
    expect(m.taches[0]).toMatchObject({ nom: "reconnecter", donnees: { tenantId: T }, options: { delay: DELAI_GRACE_MS } });
    await rot.reconnecter(T);
    expect(m.evenements.at(-1)).toBe(`reconnecter:${BASE}`);
    // Seconde rotation : l'ancien mot de passe n'est plus celui du rôle.
    await rot.pourBase(T, m.file);
    expect(m.role.empreinte).toContain(MDP[1]!);
    expect(m.role.empreinte).not.toContain(MDP[0]!);
  });

  it("[A-169] période de 30 jours par défaut, jobId = base + période, deux rotations simultanées d'une base ne passent pas ensemble", async () => {
    expect(PERIODE_DEFAUT_JOURS).toBe(30);
    const t0 = new Date("2027-01-10T10:00:00Z");
    expect(periodeDe(t0, 30)).toBe(periodeDe(new Date(t0.getTime() + 86_400_000), 30));
    expect(periodeDe(t0, 30)).not.toBe(periodeDe(new Date(t0.getTime() + 31 * 86_400_000), 30));
    expect(idTacheRotation(T, 7)).toBe(`rotation-${BASE}-7`);
    expect(idTacheRotation(T, 7)).not.toContain(":");
    expect(() => periodeDe(t0, 0)).toThrow();
    const m = monter();
    m.bloquer();
    await expect(creerRotation(m.p).pourBase(T, m.file)).resolves.toBe("occupe");
    expect(m.evenements).toEqual([]);
    // Dépôt : charge = tenantId seul, jamais un mot de passe.
    const ajouts: { donnees: unknown; options: Record<string, unknown> }[] = [];
    await deposerRotation({ getJob: async () => undefined, add: async (_n, donnees, options) => { ajouts.push({ donnees, options }); } }, T, t0, 30);
    expect(ajouts[0]).toMatchObject({ donnees: { tenantId: T }, options: { jobId: idTacheRotation(T, periodeDe(t0, 30)) } });
  });

  it("[A-169] la rotation immédiate en cas d'incident exige la réauthentification et est tracée", async () => {
    const m = monter();
    const rot = creerRotation(m.p);
    await expect(rot.immediate(T, "incident", session({ reauthentifie: false }), m.file)).rejects.toMatchObject({ code: "reauthentification_requise" });
    await expect(rot.immediate(T, "incident", session({ clientActifId: randomUUID() }), m.file)).rejects.toMatchObject({ code: "action_interdite" });
    await expect(rot.immediate(T, "incident", session({ acteur: "systeme" }), m.file)).rejects.toMatchObject({ code: "action_interdite" });
    await expect(rot.immediate(T, "  ", session(), m.file)).rejects.toMatchObject({ code: "schema_invalide" });
    for (const role of ["lecteur", "qualifieur"]) await expect(rot.immediate(T, "incident", session({ role }), m.file)).rejects.toMatchObject({ code: "action_interdite" });
    expect(m.evenements).toEqual([]);
    await rot.immediate(T, "poste perdu", session(), m.file);
    expect(m.evenements).toContain("coffre");
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "rotation_immediate", acteur: "equipe-1", motif: "poste perdu", tenantId: T }));
  });

  it("[A-169] une base en création ou effacée n'est pas pivotée ; une base à l'écart ou gelée l'est (incident)", async () => {
    for (const etat of ["en_creation", "effacee"]) {
      const m = monter({ etat });
      await expect(creerRotation(m.p).pourBase(T, m.file)).rejects.toMatchObject({ code: "base_non_pivotable" });
    }
    for (const etat of ["gelee", "a_l_ecart", "active"]) {
      const m = monter({ etat });
      await expect(creerRotation(m.p).pourBase(T, m.file)).resolves.toBe("faite");
    }
  });

  it("[A-417] la rotation ne recrée jamais le rôle : ses ordres sont ALTER ROLE et COMMENT seulement", async () => {
    const ordres: string[] = [];
    const sql = {
      requete: async (texte: string, valeurs?: unknown[]) => {
        ordres.push(texte);
        if (texte.startsWith("SELECT quote_ident")) return [{ q: `"${String(valeurs?.[0])}"` }] as never;
        if (texte.startsWith("SELECT quote_literal")) return [{ lit: `'${String(valeurs?.[0])}'` }] as never;
        if (texte.startsWith("SELECT 1 FROM pg_roles")) return [{ "?column?": 1 }] as never;
        return [] as never;
      },
    };
    const admin = adminRotationPg(sql);
    await admin.changerMotDePasse(`cli_${ID}_app`, "SCRAM-SHA-256$4096:sel$abc=:def=", 2, new Date("2027-03-01T00:00:00Z"));
    const ecrits = ordres.filter((o) => /ROLE/.test(o) && !o.startsWith("SELECT"));
    expect(ecrits).toHaveLength(2);
    expect(ecrits[0]).toMatch(/^ALTER ROLE "cli_[0-9a-f]{12}_app" PASSWORD '.*' VALID UNTIL '2027-03-01T00:00:00.000Z'$/);
    expect(ecrits[1]).toMatch(/^COMMENT ON ROLE .* IS 'secret:v2'$/);
    expect(ordres.join("\n")).not.toMatch(/CREATE ROLE|DROP ROLE|RESET|CONNECTION LIMIT|statement_timeout/i);
    // Rôle absent : refus, jamais de création.
    const vide = adminRotationPg({ requete: async (t: string, v?: unknown[]) => (t.startsWith("SELECT 1 FROM pg_roles") ? ([] as never) : sql.requete(t, v)) });
    await expect(vide.changerMotDePasse(`cli_${ID}_app`, "SCRAM-SHA-256$4096:sel$abc=:def=", 2, new Date())).rejects.toMatchObject({ code: "role_absent" });
    // Seul le rôle _app est touché ; une empreinte mal formée ou un nom piégé est refusé avant tout SQL.
    const avant = ordres.length;
    for (const [r, e] of [[`cli_${ID}_proprietaire`, "SCRAM-SHA-256$4096:sel$abc=:def="], ["provisionneur", "SCRAM-SHA-256$4096:sel$abc=:def="], [`cli_${ID}_app`, "'; DROP ROLE x; --"]] as const) {
      await expect(admin.changerMotDePasse(r, e, 1, new Date())).rejects.toThrow();
    }
    expect(ordres).toHaveLength(avant);
  });

  it("[A-209] aucun mot de passe dans le journal, les données de tâche ni l'erreur de rotation", async () => {
    const m = monter();
    await creerRotation(m.p).pourBase(T, m.file);
    expect(JSON.stringify([m.journal, m.taches])).not.toContain(MDP[0]!);
    const echec = monter({ echecRole: true });
    const e = await creerRotation(echec.p).pourBase(T, echec.file).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "role_echoue" });
    expect(`${(e as Error).message}${JSON.stringify(echec.journal)}`).not.toContain(MDP[0]!);
    expect(`${(e as Error).message}`).not.toContain("SCRAM");
  });
});
