import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { revocationsParFile, revoquerTousBauxHumains, type BilanRevocation, type FileRevocations } from "./acces-humain.js";
import { adminRotationPg, creerRotation, DELAI_GRACE_MS, ESSAIS_ROTATION, sessionsPg, deposerRotation, idTacheRotation, periodeDe, PERIODE_DEFAUT_JOURS, type PortsRotation } from "./rotation.js";
import type { SessionEquipe } from "../gel/gel.js";

const T = randomUUID();
const ID = T.replaceAll("-", "").slice(0, 12);
const BASE = `cli_${ID}`;
const MDP = ["premier-mot-de-passe", "second-mot-de-passe", "troisieme-mot-de-passe"];
const session = (o: Partial<SessionEquipe> = {}): SessionEquipe => ({ acteur: "equipe-1", role: "administrateur", clientActifId: T, reauthentifie: true, ...o });

function monter(o: { etat?: string; rolePresent?: boolean; echecRole?: boolean; echecCoupure?: boolean; echecAlerte?: boolean; echecLecture?: boolean; panneHumains?: boolean; bilan?: Partial<BilanRevocation>; restants?: { membres: number; sessions: number } } = {}) {
  let maintenant = Date.parse("2027-01-10T10:00:00Z");
  let n = 0;
  const coffre = new Map<string, string>();
  const versions = new Map<string, number>();
  const role = { empreinte: "", version: 0, validJusqua: undefined as Date | undefined };
  const roles = new Map<string, { version: number; validJusqua: Date }>();
  const evenements: string[] = [];
  const journal: Record<string, unknown>[] = [];
  const taches: { nom: string; donnees: unknown; options: Record<string, unknown> }[] = [];
  const alertes: Record<string, unknown>[] = [];
  const etats: string[] = [];
  let pris = false;
  const p: PortsRotation = {
    sessions: () => ({
      couper: async (b, r) => { etats.push(`couper:${pris ? "verrou" : "libre"}`); if (o.echecCoupure) throw new Error("bouncer injoignable"); evenements.push(`couper:${b}:${r}`); },
      restants: async () => { etats.push(`restants:${pris ? "verrou" : "libre"}`); evenements.push("restants"); return o.restants ?? { membres: 0, sessions: 0 }; },
    }),
    humains: {
      revoquerTous: async () => {
        etats.push(`revoquer-tous:${pris ? "verrou" : "libre"}`);
        evenements.push("revoquer-tous");
        if (o.panneHumains) throw new Error("coffre injoignable");
        return { revoques: 1, etrangers: 0, echecs: 0, complet: true, ...o.bilan };
      },
    },
    alerte: { envoyer: async (e) => { if (o.echecAlerte) throw new Error("récepteur absent"); alertes.push(e); } },
    base: async () => ({ etat: (o.etat ?? "active") as "active", grappe: "donnees-1", nomBase: `cli_${T.replaceAll("-", "")}` }),
    admin: () => ({
      async changerMotDePasse(r, empreinte, version, validJusqua) {
        if (o.echecRole || (o.echecLecture && r.endsWith("_lecture"))) throw new Error(`échec avec ${empreinte}`);
        evenements.push(`role:${r}`);
        roles.set(r, { version, validJusqua });
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
  return { p, file, coffre, role, roles, versions, alertes, evenements, etats, verrouPris: () => pris, journal, taches, avancer: (ms: number) => { maintenant += ms; }, bloquer: () => { pris = true; } };
}

describe("rotation des mots de passe", () => {
  it("[A-169] la rotation planifiée change le mot de passe ; l'ancien est refusé après la période de grâce", async () => {
    const m = monter();
    const rot = creerRotation(m.p);
    await rot.pourBase(T, m.file);
    expect(m.coffre.get(`technique/donnees/${BASE}/app`)).toBe(MDP[0]);
    expect(m.role).toMatchObject({ empreinte: `SCRAM-SHA-256$4096:sel$${MDP[1]}:cle`, version: 1 });
    expect(m.coffre.get(`technique/donnees/${BASE}/lecture`)).toBe(MDP[1]);
    // Le coffre est mis à jour AVANT le rôle (jamais un rôle dont le mot de passe serait inconnu).
    expect(m.evenements).toEqual(["coffre", `role:cli_${ID}_app`, "coffre", `role:cli_${ID}_lecture`]);
    // La grâce de 10 minutes se règle par une tâche différée de reconnexion PgBouncer.
    expect(DELAI_GRACE_MS).toBe(600_000);
    expect(m.taches).toHaveLength(1);
    expect(m.taches[0]).toMatchObject({ nom: "reconnecter", donnees: { tenantId: T }, options: { delay: DELAI_GRACE_MS } });
    await rot.reconnecter(T);
    expect(m.evenements.at(-1)).toBe(`reconnecter:${BASE}`);
    // Seconde rotation : l'ancien mot de passe n'est plus celui du rôle.
    await rot.pourBase(T, m.file);
    expect(m.role.empreinte).toContain(MDP[0]!);
    expect(m.role.empreinte).not.toContain(MDP[1]!);
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

  it("[A-169] la rotation immédiate coupe les sessions ouvertes (PgBouncer puis base) après le changement de mot de passe ; la rotation planifiée ne les coupe pas", async () => {
    const m = monter();
    await creerRotation(m.p).immediate(T, "poste perdu", session(), m.file);
    const i = m.evenements.findLastIndex((e) => e.startsWith("role:"));
    expect(m.evenements[i + 1]).toBe(`couper:cli_${ID}:cli_${ID}_app`);
    // Puis les baux humains, puis le filet : la révocation suit la coupure.
    expect(m.evenements.slice(i + 1)).toEqual([`couper:cli_${ID}:cli_${ID}_app`, "revoquer-tous", "restants"]);
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "sessions_coupees", tenantId: T }));
    const plan = monter();
    await creerRotation(plan.p).pourBase(T, plan.file);
    expect(plan.evenements.some((e) => e.startsWith("couper:"))).toBe(false);
    // Coupure impossible : l'échec est visible (code seul), tracé, jamais passé sous silence.
    const panne = monter({ echecCoupure: true });
    const e = await creerRotation(panne.p).immediate(T, "poste perdu", session(), panne.file).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "coupure_echouee" });
    expect(panne.journal).toContainEqual(expect.objectContaining({ evenement: "sessions_non_coupees", tenantId: T }));
    expect(`${(e as Error).message}${JSON.stringify(panne.journal)}`).not.toContain(MDP[0]!);
  });

  it("[A-169] poste perdu pendant une rotation planifiée : la rotation immédiate échoue de façon visible (alerte, code, trace) et ne laisse aucune session ouverte passer pour coupée", async () => {
    const m = monter();
    // Une rotation planifiée tient le verrou : pivoter renvoie « occupe ».
    m.bloquer();
    const e = await creerRotation(m.p).immediate(T, "poste perdu", session(), m.file).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "rotation_occupee" });
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "rotation_immediate_non_faite", tenantId: T }));
    expect(m.alertes).toEqual([{ evenement: "rotation_immediate_non_faite", tenantId: T, base: BASE, essais: 0, code: "rotation_occupee" }]);
    expect(m.evenements).toEqual([]);
    // Récepteur d'alerte absent : l'échec reste visible (trace) et la demande échoue quand même.
    const sans = monter({ echecAlerte: true });
    sans.bloquer();
    await expect(creerRotation(sans.p).immediate(T, "poste perdu", session(), sans.file)).rejects.toMatchObject({ code: "rotation_occupee" });
    expect(sans.journal).toContainEqual(expect.objectContaining({ evenement: "alerte_non_envoyee", tenantId: T }));
  });

  it("[A-169] une tâche en échec définitif dont le tenantId est mal formé envoie quand même l'alerte, sans lever", async () => {
    const m = monter();
    const rot = creerRotation(m.p);
    const erreur = Object.assign(new Error("x"), { code: "role_echoue" });
    for (const data of [{ tenantId: "pas-un-uuid" }, { tenantId: 12 }, {}, undefined]) {
      m.alertes.length = 0;
      await rot.surEchec({ name: "rotation", data: data as never, attemptsMade: 5, opts: { attempts: ESSAIS_ROTATION } }, erreur);
      expect(m.alertes).toEqual([{ evenement: "rotation_echec_definitif", tenantId: "invalide", base: "inconnue", essais: 5, code: "role_echoue" }]);
    }
  });

  it("[A-169] l'adaptateur coupe KILL puis RESUME sur la seule base, et les sessions du rôle app et des rôles humains rattachés à lecture", async () => {
    const ordres: { cible: string; texte: string; valeurs?: unknown[] | undefined }[] = [];
    const sql = (cible: string, echec = false) => ({ requete: async (texte: string, valeurs?: unknown[]) => { ordres.push({ cible, texte, valeurs }); if (echec && texte.startsWith("SELECT pg_terminate")) throw new Error("grappe injoignable"); return [] as never; } });
    await sessionsPg(sql("grappe"), sql("bouncer")).couper(`cli_${ID}`, `cli_${ID}_app`);
    expect(ordres.filter((o) => o.cible === "bouncer").map((o) => o.texte)).toEqual([`KILL cli_${ID}`, `RESUME cli_${ID}`]);
    const terminer = ordres.find((o) => o.texte.startsWith("SELECT pg_terminate_backend"))!;
    expect(terminer.texte).toMatch(/pg_stat_activity/);
    expect(terminer.texte).toMatch(/usename = \$1/);
    expect(terminer.texte).toMatch(/usename = \$2/);
    expect(terminer.texte).toMatch(/pg_auth_members/);
    expect(terminer.valeurs).toEqual([`cli_${ID}_app`, `cli_${ID}_lecture`]);
    // Même si la base ne répond pas, PgBouncer reprend (RESUME) : la base n'est jamais laissée en pause.
    ordres.length = 0;
    await expect(sessionsPg(sql("grappe", true), sql("bouncer")).couper(`cli_${ID}`, `cli_${ID}_app`)).rejects.toThrow();
    expect(ordres.filter((o) => o.cible === "bouncer").map((o) => o.texte)).toEqual([`KILL cli_${ID}`, `RESUME cli_${ID}`]);
    // Noms piégés : refus avant tout ordre.
    ordres.length = 0;
    for (const [b, r] of [["postgres", "postgres"], [`cli_${ID}; SHUTDOWN`, `cli_${ID}_app`], [`cli_${ID}`, "provisionneur"], [`cli_${ID}`, `cli_${ID}_proprietaire`], [`cli_${ID}`, `cli_000000000000_app`]] as const) {
      await expect(sessionsPg(sql("grappe"), sql("bouncer")).couper(b, r)).rejects.toThrow();
    }
    expect(ordres).toEqual([]);
  });

  it("[A-169] l'échec définitif d'une rotation après 5 essais déclenche une alerte sans valeur secrète ; pas avant", async () => {
    expect(ESSAIS_ROTATION).toBe(5);
    const m = monter();
    const rot = creerRotation(m.p);
    const tache = (n: number) => ({ name: "rotation", data: { tenantId: T }, attemptsMade: n, opts: { attempts: ESSAIS_ROTATION } });
    const erreur = Object.assign(new Error(`échec avec ${MDP[0]}`), { code: "role_echoue" });
    for (const n of [1, 2, 3, 4]) await rot.surEchec(tache(n), erreur);
    expect(m.alertes).toEqual([]);
    await rot.surEchec(tache(5), erreur);
    expect(m.alertes).toEqual([{ evenement: "rotation_echec_definitif", tenantId: T, base: BASE, essais: 5, code: "role_echoue" }]);
    expect(JSON.stringify([m.alertes, m.journal])).not.toContain(MDP[0]!);
    // Une autre tâche (reconnexion) ne déclenche pas l'alerte de rotation ; un récepteur absent est tracé, la panne reste visible.
    await rot.surEchec({ ...tache(5), name: "reconnecter" }, erreur);
    expect(m.alertes).toHaveLength(1);
    const sans = monter({ echecAlerte: true });
    await expect(creerRotation(sans.p).surEchec(tache(5), erreur)).rejects.toMatchObject({ code: "alerte_non_envoyee" });
    expect(sans.journal).toContainEqual(expect.objectContaining({ evenement: "alerte_non_envoyee", tenantId: T }));
  });

  it("[A-169] la rotation de _lecture pose VALID UNTIL ; entre coffre et rôle le courtier refuse secret_incoherent", async () => {
    const m = monter();
    await creerRotation(m.p).pourBase(T, m.file);
    const lecture = m.roles.get(`cli_${ID}_lecture`);
    expect(lecture?.version).toBe(m.versions.get(`technique/donnees/${BASE}/lecture`));
    expect(lecture!.validJusqua.getTime()).toBe(Date.parse("2027-01-10T10:00:00Z") + 2 * PERIODE_DEFAUT_JOURS * 86_400_000);
    // Le coffre reçoit le secret de _lecture avant le rôle ; si le rôle échoue, la version du coffre dépasse celle du rôle (le courtier lit cet écart comme secret_incoherent).
    const panne = monter({ echecLecture: true });
    await expect(creerRotation(panne.p).pourBase(T, panne.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(panne.versions.get(`technique/donnees/${BASE}/lecture`)).toBe(1);
    expect(panne.roles.has(`cli_${ID}_lecture`)).toBe(false);
    expect(panne.roles.get(`cli_${ID}_app`)?.version).toBe(1);
  });

  it("[A-169] rotation immédiate : si _lecture échoue après _app, les sessions sont quand même coupées et l'échec reste visible", async () => {
    const m = monter({ echecLecture: true });
    const e = await creerRotation(m.p).immediate(T, "poste perdu", session(), m.file).catch((x: unknown) => x as Error);
    expect(e).toMatchObject({ code: "role_echoue" });
    expect(m.evenements).toContain(`couper:cli_${ID}:cli_${ID}_app`);
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "sessions_coupees", tenantId: T }));
    expect(m.taches.map((x) => x.nom)).toEqual(["reconnecter"]);
    expect(`${(e as Error).message}${JSON.stringify(m.journal)}${JSON.stringify(m.alertes)}`).not.toContain(MDP[0]!);
    // Rien n'a changé côté rôle (coffre en panne dès _app) : aucune coupure inutile.
    const rien = monter({ echecRole: true });
    await expect(creerRotation(rien.p).immediate(T, "poste perdu", session(), rien.file)).rejects.toMatchObject({ code: "role_echoue" });
    // _app a échoué sur l'ordre lui-même : le doute profite à la sécurité, on coupe.
    expect(rien.evenements.some((x) => x.startsWith("couper:"))).toBe(true);
    // La coupure elle-même échoue : l'échec d'origine remonte, trace + alerte sessions_non_coupees, jamais de pause.
    const double = monter({ echecLecture: true, echecCoupure: true });
    await expect(creerRotation(double.p).immediate(T, "poste perdu", session(), double.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(double.journal).toContainEqual(expect.objectContaining({ evenement: "sessions_non_coupees", tenantId: T }));
    expect(double.journal.some((x) => x.evenement === "sessions_coupees")).toBe(false);
    expect(double.alertes).toContainEqual(expect.objectContaining({ evenement: "sessions_non_coupees", code: "coupure_echouee" }));
    // La rotation planifiée ne coupe jamais, même en échec partiel.
    const plan = monter({ echecLecture: true });
    await expect(creerRotation(plan.p).pourBase(T, plan.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(plan.evenements.some((x) => x.startsWith("couper:"))).toBe(false);
  });

  it("[A-209] aucun nom hors cli_<id>_(app|lecture) n'est modifié par la rotation (_proprietaire refusé)", async () => {
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
    const emp = "SCRAM-SHA-256$4096:sel$abc=:def=";
    await admin.changerMotDePasse(`cli_${ID}_lecture`, emp, 3, new Date("2027-03-01T00:00:00Z"));
    expect(ordres.filter((o) => o.startsWith("ALTER ROLE"))).toEqual([`ALTER ROLE "cli_${ID}_lecture" PASSWORD '${emp}' VALID UNTIL '2027-03-01T00:00:00.000Z'`]);
    const avant = ordres.length;
    for (const r of [`cli_${ID}_proprietaire`, `cli_${ID}_lecture2`, `xcli_${ID}_lecture`, "provisionneur"]) await expect(admin.changerMotDePasse(r, emp, 1, new Date())).rejects.toThrow();
    expect(ordres).toHaveLength(avant);
  });

  it("[A-209] rotation immédiate : coffre indisponible, la rotation reste faite et rend revocation_incomplete avec une alerte", async () => {
    const m = monter({ panneHumains: true });
    await expect(creerRotation(m.p).immediate(T, "poste perdu", session(), m.file)).resolves.toBe("revocation_incomplete");
    // Aucun retour en arrière : les deux secrets sont à leur nouvelle version, la coupure a eu lieu, le verrou est rendu.
    expect(m.versions.get(`technique/donnees/${BASE}/app`)).toBe(1);
    expect(m.roles.get(`cli_${ID}_lecture`)?.version).toBe(1);
    expect(m.evenements).toContain(`couper:cli_${ID}:cli_${ID}_app`);
    expect(m.verrouPris()).toBe(false);
    expect(m.alertes).toEqual([{ evenement: "roles_dynamiques_restants", tenantId: T, base: BASE, essais: 3, code: "revocation_incomplete" }]);
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "roles_dynamiques_restants", tenantId: T }));
    // Récepteur d'alerte absent : la trace le dit, le résultat reste revocation_incomplete.
    const sans = monter({ panneHumains: true, echecAlerte: true });
    await expect(creerRotation(sans.p).immediate(T, "poste perdu", session(), sans.file)).resolves.toBe("revocation_incomplete");
    expect(sans.journal).toContainEqual(expect.objectContaining({ evenement: "alerte_non_envoyee", tenantId: T }));
    // Tout va bien : « faite », aucune alerte.
    const bien = monter();
    await expect(creerRotation(bien.p).immediate(T, "poste perdu", session(), bien.file)).resolves.toBe("faite");
    expect(bien.alertes).toEqual([]);
  });

  it("[A-209] rotation immédiate : un membre de _lecture encore LOGIN après révocation donne revocation_incomplete, sans nom de rôle dans l'alerte", async () => {
    const m = monter({ restants: { membres: 1, sessions: 0 } });
    await expect(creerRotation(m.p).immediate(T, "poste perdu", session(), m.file)).resolves.toBe("revocation_incomplete");
    expect(m.alertes).toEqual([{ evenement: "roles_dynamiques_restants", tenantId: T, base: BASE, essais: 3, code: "revocation_incomplete" }]);
    expect(m.journal).toContainEqual(expect.objectContaining({ evenement: "roles_dynamiques_restants", tenantId: T, nombre: 1 }));
    expect(JSON.stringify([m.alertes, m.journal])).not.toMatch(/humain-lecture|v-essai|rolname/);
    // Une session restante seule suffit aussi ; un bilan de révocation incomplet aussi.
    for (const o of [{ restants: { membres: 0, sessions: 2 } }, { bilan: { complet: false, echecs: 1 } }]) {
      const x = monter(o);
      await expect(creerRotation(x.p).immediate(T, "poste perdu", session(), x.file)).resolves.toBe("revocation_incomplete");
    }
  });

  it("[A-209] les traces et alertes de la révocation ne portent ni nom de rôle, ni identifiant de bail, ni mot de passe", async () => {
    const m = monter();
    const bail = `database/creds/humain-lecture-${BASE}/Zk3JdQ8wLm2Xr5Tn`;
    const etranger = `database/creds/humain-lecture-cli_${"f".repeat(12)}/Zk3JdQ8wLm2Xr5Tn`;
    const pref = `revocation-humain-${BASE}-`;
    const taches = [{ id: `${pref}Zk3JdQ8wLm2Xr5Tn`, data: { tenantId: T, bail } }, { id: `${pref}Ab1Cd2Ef3Gh4Ij5K`, data: { tenantId: T, bail: etranger } }];
    const file: FileRevocations = { add: async () => undefined, getJobs: async () => taches.map((t) => ({ ...t, remove: async () => undefined })) };
    m.p.humains = { revoquerTous: (t) => revoquerTousBauxHumains({ bail: { revoquer: async () => { throw new Error(`refus ${bail} v-essai-1 mdp-dynamique-d-essai`); } }, taches: revocationsParFile(file), journal: m.p.journal }, t) };
    await expect(creerRotation(m.p).immediate(T, "poste perdu", session(), m.file)).resolves.toBe("revocation_incomplete");
    const tout = JSON.stringify([m.journal, m.alertes]);
    expect(tout).toContain("bail_etranger");
    expect(tout).toContain("revocation_incomplete");
    for (const interdit of ["humain-lecture-", "database/creds", "mdp-dynamique-d-essai", "v-essai", "Zk3JdQ8wLm2Xr5Tn", MDP[0]!, MDP[1]!]) expect(tout).not.toContain(interdit);
  });

  it("[A-209] rotation immédiate en échec partiel (_lecture) : les baux humains sont quand même révoqués", async () => {
    const m = monter({ echecLecture: true });
    await expect(creerRotation(m.p).immediate(T, "poste perdu", session(), m.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(m.evenements).toContain("revoquer-tous");
    expect(m.etats).toContain("revoquer-tous:verrou");
    expect(m.verrouPris()).toBe(false);
    // La révocation elle-même en panne : l'échec d'origine remonte quand même, avec l'alerte.
    const double = monter({ echecLecture: true, panneHumains: true });
    await expect(creerRotation(double.p).immediate(T, "poste perdu", session(), double.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(double.alertes).toContainEqual(expect.objectContaining({ code: "revocation_incomplete" }));
  });

  it("[A-169] rotation immédiate : la coupure se fait sous le même verrou que le pivot", async () => {
    const m = monter();
    await creerRotation(m.p).immediate(T, "poste perdu", session(), m.file);
    expect(m.etats).toEqual(["couper:verrou", "revoquer-tous:verrou", "restants:verrou"]);
    expect(m.verrouPris()).toBe(false);
    // Coupure en échec : coupure_echouee remonte après la révocation et le filet, verrou rendu.
    const panne = monter({ echecCoupure: true });
    await expect(creerRotation(panne.p).immediate(T, "poste perdu", session(), panne.file)).rejects.toMatchObject({ code: "coupure_echouee" });
    expect(panne.etats).toEqual(["couper:verrou", "revoquer-tous:verrou", "restants:verrou"]);
    expect(panne.verrouPris()).toBe(false);
  });

  it("[A-169] couper : KILL en échec, la coupure côté base est quand même tentée et l'erreur remonte", async () => {
    const ordres: string[] = [];
    const sql = (cible: string, echecSur?: string) => ({ requete: async (texte: string) => { ordres.push(`${cible}:${texte.split(" ")[0]}`); if (echecSur && texte.startsWith(echecSur)) throw new Error(`${echecSur} refusé`); return [] as never; } });
    await expect(sessionsPg(sql("grappe"), sql("bouncer", "KILL")).couper(`cli_${ID}`, `cli_${ID}_app`)).rejects.toThrow("KILL refusé");
    expect(ordres).toEqual(["bouncer:KILL", "grappe:SELECT", "bouncer:RESUME"]);
    // La première erreur remonte, même si la suite échoue aussi ; RESUME est toujours tenté.
    ordres.length = 0;
    await expect(sessionsPg(sql("grappe", "SELECT"), sql("bouncer", "KILL")).couper(`cli_${ID}`, `cli_${ID}_app`)).rejects.toThrow("KILL refusé");
    expect(ordres).toEqual(["bouncer:KILL", "grappe:SELECT", "bouncer:RESUME"]);
  });

  it("[A-169] rotation planifiée : les baux humains ne sont pas révoqués (expiration seule)", async () => {
    const m = monter();
    await expect(creerRotation(m.p).pourBase(T, m.file)).resolves.toBe("faite");
    expect(m.evenements.some((e) => e === "revoquer-tous" || e === "restants" || e.startsWith("couper:"))).toBe(false);
    expect(m.etats).toEqual([]);
    const partielle = monter({ echecLecture: true });
    await expect(creerRotation(partielle.p).pourBase(T, partielle.file)).rejects.toMatchObject({ code: "role_echoue" });
    expect(partielle.etats).toEqual([]);
  });

  it("[A-169] restants : nom de base piégé refusé avant tout ordre, requête paramétrée en lecture seule", async () => {
    const ordres: { texte: string; valeurs?: unknown[] | undefined }[] = [];
    const sql = { requete: async (texte: string, valeurs?: unknown[]) => { ordres.push({ texte, valeurs }); return [{ membres: "2", sessions: 1 }] as never; } };
    await expect(sessionsPg(sql, sql).restants(`cli_${ID}`)).resolves.toEqual({ membres: 2, sessions: 1 });
    expect(ordres).toHaveLength(1);
    expect(ordres[0]!.valeurs).toEqual([`cli_${ID}_lecture`]);
    expect(ordres[0]!.texte).toMatch(/^\s*SELECT/i);
    expect(ordres[0]!.texte).toMatch(/rolcanlogin/);
    expect(ordres[0]!.texte).toMatch(/inherit_option/);
    expect(ordres[0]!.texte).toMatch(/set_option/);
    expect(ordres[0]!.texte).not.toMatch(/\b(ALTER|REVOKE|DROP|GRANT|DELETE|UPDATE|INSERT|pg_terminate_backend)\b/i);
    expect(ordres[0]!.texte).not.toContain(ID);
    ordres.length = 0;
    for (const b of ["postgres", `cli_${ID}; SHUTDOWN`, `cli_${ID}_lecture`, "CLI_ABC", ""]) await expect(sessionsPg(sql, sql).restants(b)).rejects.toThrow();
    expect(ordres).toEqual([]);
  });
});
