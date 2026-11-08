import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { creerEnvoiJournal } from "../../../../../packages/observabilite/src/journal.ts";
import { journalEchecs } from "../../provisionnement/journal-echecs.js";
import { construireServeur } from "../../serveur.js";

// Essai contre le socle lancé (job socle-integration) : aucun démon Docker en routine, aucun résultat inventé.
journalEchecs(import.meta.url);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=victoria-logs");
const adresse = (): string =>
  process.env["SOCLE_VICTORIA_LOGS"] ?? `${docker("inspect", "-f", '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}', conteneur)}:9428`;

describe("journaux regroupés avec le socle", () => {
  it("[A-080] un journal écrit par l'exécuteur se lit par la route de la console", async () => {
    const url = `http://${adresse()}`;
    const marque = `essai-${Date.now()}`;
    const envoi = creerEnvoiJournal({ url, application: "executeur" });
    envoi.ecrire({ niveau: "info", code: "ESSAI", message: marque });
    await envoi.vider();
    const garde = async () => undefined;
    const serveur = construireServeur({ journaux: { ouvert: () => true, exigerEquipe: garde, exigerReauthentification: garde, lecture: { url } } });
    const depuis = new Date(Date.now() - 3_600_000).toISOString();
    let trouve = false;
    for (let i = 0; i < 20 && !trouve; i++) {
      const r = await serveur.inject({ method: "GET", url: `/api/console/v1/journaux?brique=executeur&depuis=${encodeURIComponent(depuis)}` });
      expect(r.statusCode).toBe(200);
      trouve = (r.json().lignes as { message: string }[]).some((l) => l.message === marque);
      if (!trouve) await new Promise((ok) => setTimeout(ok, 500));
    }
    expect(trouve).toBe(true);
  });
});
