import { describe, expect, it } from "vitest";
import { ErreurApi } from "../../plugins/erreurs.js";
import { lireJournaux, validerFiltre, type FetchLecture } from "./lecture.js";

const MAINTENANT = Date.parse("2026-11-08T10:00:00Z");
const iso = (jours: number) => new Date(MAINTENANT - jours * 86_400_000).toISOString();

function faux(corps: string) {
  const appels: { url: string; corps: string }[] = [];
  const fetch: FetchLecture = async (url, init) => {
    appels.push({ url, corps: String(init.body) });
    return { status: 200, text: async () => corps };
  };
  return { fetch, appels };
}
const refus = (f: () => unknown) => { try { f(); } catch (e) { return e; } return undefined; };

describe("lecture des journaux regroupés", () => {
  it("[A-080] brique hors liste, depuis illisible, antérieur à la rétention ou dans le futur : 400 ; aucune chaîne de l'appelant n'entre dans la requête LogsQL", async () => {
    const mauvais = [
      { brique: "postgres", depuis: iso(1) },
      { brique: 'api"} | delete', depuis: iso(1) },
      { brique: "api", depuis: "hier" },
      { brique: "api", depuis: iso(31) },
      { brique: "api", depuis: new Date(MAINTENANT + 3_600_000).toISOString() },
      { brique: "api" },
      { brique: "api", depuis: iso(1), jusqua: iso(2) },
      { brique: "api", depuis: iso(1), extra: "x" },
    ];
    for (const q of mauvais) {
      const e = refus(() => validerFiltre(q, MAINTENANT));
      expect(e, JSON.stringify(q)).toBeInstanceOf(ErreurApi);
      expect((e as ErreurApi).code).toBe("schema_invalide");
    }
    const f = validerFiltre({ brique: "executeur", depuis: iso(1) }, MAINTENANT);
    const { fetch, appels } = faux("");
    await lireJournaux({ url: "http://collecteur.test:9428", fetch }, f);
    const requete = new URLSearchParams(appels[0]!.corps).get("query")!;
    expect(requete).toBe('{application="executeur"} | sort by (_time) desc | limit 500');
    expect(appels[0]!.url).toBe("http://collecteur.test:9428/select/logsql/query");
  });

  it("[A-080] la réponse est bornée à 500 lignes et chaque ligne est masquée de nouveau à la lecture", async () => {
    const jeton = `ghp_${"a1B2c3D4".repeat(3)}`;
    const lignes = Array.from({ length: 700 }, (_, i) => JSON.stringify({ _time: "2026-11-08T09:00:00Z", _msg: `échec pour marc@exemple.fr avec ${jeton} n°${i}`, niveau: "error", application: "api", code: "ERR_X", reqId: "r1", cache: "interdit", _stream: "{application=\"api\"}" }));
    const { fetch } = faux(lignes.join("\n"));
    const sortie = await lireJournaux({ url: "http://collecteur.test:9428", fetch, masquerSecrets: (t) => t.replaceAll("n°", "[n]") }, validerFiltre({ brique: "api", depuis: iso(1) }, MAINTENANT));
    expect(sortie).toHaveLength(500);
    const texte = JSON.stringify(sortie);
    expect(texte).not.toContain("marc@exemple.fr");
    expect(texte).not.toContain(jeton);
    expect(texte).not.toContain("interdit");
    expect(texte).not.toContain("_stream");
    expect(sortie[0]).toMatchObject({ heure: "2026-11-08T09:00:00.000Z", niveau: "error", application: "api", code: "ERR_X", reqId: "r1" });
    expect(sortie[0]!.message).toContain("[n]");
    expect(sortie[0]!.message.length).toBeLessThanOrEqual(500);
  });

  it("[A-080] collecteur muet ou en erreur : 503 sans détail, ligne illisible écartée", async () => {
    const f = validerFiltre({ brique: "console", depuis: iso(1) }, MAINTENANT);
    const ko: FetchLecture = async () => ({ status: 500, text: async () => "secret interne" });
    await expect(lireJournaux({ url: "http://collecteur.test:9428", fetch: ko }, f)).rejects.toMatchObject({ code: "porte_fermee" });
    const coupe: FetchLecture = async () => { throw new Error("ECONNREFUSED 10.0.0.9"); };
    await expect(lireJournaux({ url: "http://collecteur.test:9428", fetch: coupe }, f)).rejects.toMatchObject({ code: "porte_fermee" });
    const { fetch } = faux('pas du json\n{"_time":"2026-11-08T09:00:00Z","_msg":"ok","application":"console"}');
    expect(await lireJournaux({ url: "http://collecteur.test:9428", fetch }, f)).toHaveLength(1);
  });
});
