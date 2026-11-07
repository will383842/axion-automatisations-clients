import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.ts";
import { activerAvecGardes } from "./creer.ts";
import { gardeTestABlanc, lancerTestABlanc, type ExecuteurABlanc, type RapportExecution } from "./test-a-blanc.ts";

// Faux pool : avecClient ouvre une transaction (BEGIN, réglages, COMMIT) sur la connexion rendue ; chaque requête est notée.
const A = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "66666666-6666-4666-8666-666666666666";
const V1 = "44444444-4444-4444-8444-444444444444";
const V2 = "88888888-8888-4888-8888-888888888888";
const CFG = "77777777-7777-4777-8777-777777777777";
type Rep = { rows: Record<string, unknown>[]; rowCount?: number };
function fauxPool(repondre: (texte: string, valeurs: unknown[]) => Rep | undefined) {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const client = {
    async query(texte: string, valeurs: unknown[] = []) {
      appels.push({ texte, valeurs });
      const r = repondre(texte, valeurs) ?? { rows: [] };
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, appels };
}
// L'instance est sur la version `versions[n]` à la n-ième lecture (la dernière est reprise ensuite).
const instanceSur = (...versions: string[]) => {
  let n = 0;
  return (texte: string): Rep | undefined => (texte.includes("FROM instances") ? { rows: [{ version_courante_id: versions[Math.min(n++, versions.length - 1)], configuration_id: CFG }] } : texte.startsWith("INSERT INTO tests_a_blanc") ? { rows: [{ id: "99999999-9999-4999-8999-999999999999" }] } : undefined);
};
const cible = { instanceId: INSTANCE, versionId: V1, configurationId: CFG };
const executeur = (rapport: Partial<RapportExecution> | Error, appelsPort: unknown[] = []): ExecuteurABlanc => ({
  async executer(c) {
    appelsPort.push(c);
    if (rapport instanceof Error) throw rapport;
    return { lectures: 5, brouillons: 2, envois: 0, dureeMs: 120, ...rapport };
  },
});
const insertions = (appels: { texte: string; valeurs: unknown[] }[]) => appels.filter((a) => a.texte.startsWith("INSERT INTO tests_a_blanc"));

describe("test à blanc", () => {
  it("[B-093] @envoi le test à blanc ne produit aucun message dans Mailpit et rend un rapport", async () => {
    // Partie API : le faux exécuteur lit, prépare des brouillons et passe par un faux relais qui compte les envois. Le vrai Mailpit est l'essai de T4-28c (exécution réelle).
    const relais = { envois: 0, envoyer() { this.envois++; } };
    const faussaire: ExecuteurABlanc = { async executer() { void relais; return { lectures: 5, brouillons: 2, envois: relais.envois, dureeMs: 120 }; } };
    const { pool, appels } = fauxPool(instanceSur(V1));
    const rapport = await lancerTestABlanc(pool, A, cible, "equipe-essai", faussaire);
    expect(relais.envois).toBe(0);
    expect(rapport).toMatchObject({ resultat: "reussi", lectures: 5, brouillons: 2, envois: 0, dureeMs: 120, codeErreur: null });
    const [ligne] = insertions(appels);
    expect(ligne?.valeurs).toEqual([A, INSTANCE, V1, CFG, "reussi", 5, 2, 0, 120, null, "equipe-essai"]);
  });

  it("[B-093] activation sans test à blanc réussi : refusée", async () => {
    const appels: string[] = [];
    const client = { query: async (texte: string) => (appels.push(texte), texte.includes("tests_a_blanc") ? { rows: [], rowCount: 0 } : { rows: [{ id: INSTANCE }], rowCount: 1 }) } as never;
    expect(await gardeTestABlanc({ client, tenantId: A, instanceId: INSTANCE })).toEqual({ ok: false, motif: "test_a_blanc_absent" });
    await expect(activerAvecGardes(client, A, INSTANCE, [gardeTestABlanc])).rejects.toMatchObject({ code: "regle_metier", motif: "test_a_blanc_absent" });
    expect(appels.some((t) => t.startsWith("UPDATE"))).toBe(false);
  });

  it("[B-093] un test à blanc réussi d'une ancienne configuration ou d'une autre version ne permet pas l'activation", async () => {
    let requete = "";
    let valeurs: unknown[] = [];
    const client = { query: async (texte: string, v: unknown[] = []) => ((requete = texte), (valeurs = v), { rows: [{ resultat: "reussi" }], rowCount: 1 }) } as never;
    expect(await gardeTestABlanc({ client, tenantId: A, instanceId: INSTANCE })).toEqual({ ok: true });
    // Le test compte seulement s'il porte la version courante ET la configuration active de CETTE instance de CE client.
    expect(requete).toMatch(/t\.tenant_id = \$1 AND t\.instance_id = \$2/);
    expect(requete).toMatch(/t\.version_id = i\.version_courante_id/);
    expect(requete).toMatch(/c\.active/);
    expect(requete).toMatch(/t\.configuration_id = c\.id/);
    expect(requete).toMatch(/ORDER BY t\.cree_le DESC, t\.id DESC LIMIT 1/);
    expect(valeurs).toEqual([A, INSTANCE]);
  });

  it("[B-093] un test à blanc échoué après un test réussi bloque de nouveau l'activation", async () => {
    // La requête ne rend que la DERNIÈRE ligne : ici un échec, rangé après un succès.
    const client = { query: async () => ({ rows: [{ resultat: "echoue" }], rowCount: 1 }) } as never;
    expect(await gardeTestABlanc({ client, tenantId: A, instanceId: INSTANCE })).toEqual({ ok: false, motif: "test_a_blanc_echoue" });
  });

  it("[B-093] un rapport qui annonce un envoi est enregistré échoué (code envoi_pendant_test), jamais réussi", async () => {
    const { pool, appels } = fauxPool(instanceSur(V1));
    const rapport = await lancerTestABlanc(pool, A, cible, "equipe-essai", executeur({ envois: 1 }));
    expect(rapport).toMatchObject({ resultat: "echoue", envois: 1, codeErreur: "envoi_pendant_test" });
    expect(insertions(appels)[0]?.valeurs.slice(4, 10)).toEqual(["echoue", 5, 2, 1, 120, "envoi_pendant_test"]);
  });

  it("[B-093] un exécuteur en panne, un code qui n'est pas un code ou un compteur absurde sont enregistrés échoués avec un code fermé", async () => {
    for (const [executeurEssai, code] of [
      [executeur(new Error("Erreur: adresse a@exemple.fr")), "executeur_indisponible"],
      [executeur({ codeErreur: "Erreur: adresse a@exemple.fr" }), "code_invalide"],
      [executeur({ lectures: -1 }), "rapport_invalide"],
      [executeur({ brouillons: 2_000_000 }), "rapport_invalide"],
      [executeur({ dureeMs: 1.5 }), "rapport_invalide"],
      [executeur({ codeErreur: "connexion_refusee" }), "connexion_refusee"],
    ] as const) {
      const { pool, appels } = fauxPool(instanceSur(V1));
      const rapport = await lancerTestABlanc(pool, A, cible, "equipe-essai", executeurEssai);
      expect(rapport, code).toMatchObject({ resultat: "echoue", codeErreur: code });
      const ligne = insertions(appels)[0]?.valeurs;
      expect(ligne?.[9], code).toBe(code);
      expect(JSON.stringify(ligne), code).not.toContain("exemple.fr");
    }
  });

  it("[B-093] le rapport rangé ne contient que des compteurs et un code (liste fermée de clés)", async () => {
    const { pool, appels } = fauxPool(instanceSur(V1));
    const rapport = await lancerTestABlanc(pool, A, cible, "equipe-essai", executeur({ ...{ contenu: "Bonjour", destinataire: "a@exemple.fr" } } as never));
    expect(Object.keys(rapport).sort()).toEqual(["brouillons", "codeErreur", "dureeMs", "envois", "id", "lectures", "resultat"]);
    expect(insertions(appels)[0]?.texte).toMatch(/\(tenant_id, instance_id, version_id, configuration_id, resultat, lectures, brouillons, envois, duree_ms, code_erreur, auteur\)/);
    expect(JSON.stringify(appels)).not.toContain("exemple.fr");
  });

  it("[B-093] lancerTestABlanc refuse une version qui n'est pas la version courante de l'instance, aucune ligne n'est écrite", async () => {
    const port: unknown[] = [];
    const { pool, appels } = fauxPool(instanceSur(V2));
    await expect(lancerTestABlanc(pool, A, cible, "equipe-essai", executeur({}, port))).rejects.toMatchObject({ code: "regle_metier" });
    expect(insertions(appels)).toEqual([]);
    expect(port).toEqual([]);
    // La configuration doit être la configuration active : une autre est refusée de la même façon.
    const autre = fauxPool(instanceSur(V1));
    await expect(lancerTestABlanc(autre.pool, A, { ...cible, configurationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "equipe-essai", executeur({}))).rejects.toBeInstanceOf(ErreurApi);
    expect(insertions(autre.appels)).toEqual([]);
  });

  it("[B-093] la version courante est relue dans la transaction d'écriture : une version changée pendant le test fait refuser la ligne", async () => {
    // Première lecture : V1 ; pendant l'exécution la version courante passe à V2 ; la relecture sous verrou, dans la transaction d'écriture, le voit.
    const { pool, appels } = fauxPool(instanceSur(V1, V2));
    await expect(lancerTestABlanc(pool, A, cible, "equipe-essai", executeur({}))).rejects.toMatchObject({ code: "regle_metier" });
    expect(insertions(appels)).toEqual([]);
    // Succès : relecture sous verrou et insertion dans la MÊME transaction (aucun BEGIN ni COMMIT entre les deux).
    const ok = fauxPool(instanceSur(V1));
    await lancerTestABlanc(ok.pool, A, cible, "equipe-essai", executeur({}));
    const textes = ok.appels.map((a) => a.texte);
    const dernierBegin = textes.lastIndexOf("BEGIN");
    const apres = textes.slice(dernierBegin);
    expect(apres.findIndex((t) => t.includes("FOR UPDATE"))).toBeGreaterThan(-1);
    expect(apres.findIndex((t) => t.includes("FOR UPDATE"))).toBeLessThan(apres.findIndex((t) => t.startsWith("INSERT INTO tests_a_blanc")));
    expect(apres.filter((t) => t === "BEGIN" || t === "COMMIT")).toEqual(["BEGIN", "COMMIT"]);
  });
});

// Socle des gardes d'activation (E1 de l'audit de #235) : faux client dont la ligne verrouillée porte l'état et le statut de la version courante.
function fauxSocle(o: { etat?: string; statut?: string; dernierTest?: string | null }) {
  const appels: string[] = [];
  const client = {
    async query(texte: string) {
      appels.push(texte);
      if (texte.includes("FOR UPDATE")) return { rows: [{ id: INSTANCE, etat: o.etat ?? "pause", statut: o.statut ?? "publiee" }], rowCount: 1 };
      if (texte.includes("tests_a_blanc")) return o.dernierTest ? { rows: [{ resultat: o.dernierTest }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (texte.includes("FROM contrats")) return { rows: [{ un: 1 }], rowCount: 1 };
      if (texte.startsWith("UPDATE instances")) return { rows: [{ jour: "2026-11-07" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { client: client as never, appels };
}

describe("gardes de socle de l'activation", () => {
  it("[B-093] activerAvecGardes avec une liste vide refuse sans test à blanc réussi (gardes de socle toujours appliquées)", async () => {
    const { client, appels } = fauxSocle({ dernierTest: null });
    await expect(activerAvecGardes(client, A, INSTANCE, [])).rejects.toMatchObject({ code: "regle_metier", motif: "test_a_blanc_absent" });
    expect(appels.some((t) => t.startsWith("UPDATE"))).toBe(false);
  });

  it("[B-093] une version retirée ou dépréciée depuis le test à blanc n'est pas activée, motif version_non_publiee", async () => {
    for (const statut of ["retiree", "depreciee"]) {
      const { client, appels } = fauxSocle({ statut, dernierTest: "reussi" });
      await expect(activerAvecGardes(client, A, INSTANCE, [])).rejects.toMatchObject({ code: "regle_metier", motif: "version_non_publiee" });
      expect(appels.some((t) => t.startsWith("UPDATE"))).toBe(false);
    }
  });
});

