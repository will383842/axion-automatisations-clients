import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// T5-13b-3 : fragment compose du collecteur de journaux (VictoriaLogs). Lecture de fichiers seulement (aucun Docker).
const lire = (chemin: string) => readFileSync(fileURLToPath(new URL(`../../../${chemin}`, import.meta.url)), "utf8");
const FRAGMENT = "ops/socle/compose.journaux.yml";

// Noms de services : lignes « deux espaces + nom + deux-points » sous « services: ».
function services(texte: string): string[] {
  const noms: string[] = [];
  let dedans = false;
  for (const l of texte.split("\n")) {
    if (/^\S/.test(l)) dedans = l.startsWith("services:");
    else if (dedans) {
      const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(l);
      if (m?.[1]) noms.push(m[1]);
    }
  }
  return noms;
}
const sansCommentaires = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("collecteur de journaux : fragment compose", () => {
  it("[A-080] compose.journaux.yml : un seul service victoria-logs, réseau interne, aucun port publié, image épinglée et inscrite dans ops/briques sous Apache-2.0", () => {
    const t = lire(FRAGMENT);
    expect(services(t)).toEqual(["victoria-logs"]);
    expect(t).toMatch(/networks: \[interne\]/);
    expect(t).not.toMatch(/^\s+ports:/m);
    expect(t).not.toMatch(/entree/);
    // L'image est sans shell ni client HTTP : aucune sonde interne possible. La santé est suivie par le moniteur d'Uptime Kuma.
    expect(t).not.toMatch(/^\s+healthcheck:/m);
    const moniteur = (JSON.parse(lire("ops/socle/uptime-kuma/moniteurs.json")) as { moniteurs: Array<{ service: string; chemin?: string }> }).moniteurs.find((m) => m.service === "victoria-logs");
    expect(moniteur?.chemin).toBe("/health");
    expect(t).toMatch(/restart: "no"/);
    expect(t).not.toMatch(/:latest/);
    const m = /image: (victoriametrics\/victoria-logs):(v\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})/.exec(t);
    expect(m).not.toBeNull();
    const brique = JSON.parse(lire("ops/briques/victoria-logs.json")) as Record<string, unknown>;
    expect(brique).toMatchObject({ nom: "victoria-logs", image: m?.[1], version: m?.[2], empreinte: m?.[3], licence: "Apache-2.0", livree: false, lieu: "local" });
  });

  it("[C-022] le collecteur ne monte ni /var/lib/docker, ni docker.sock, ni /proc, ni aucun volume de l'exécuteur ou du bac à sable", () => {
    const t = sansCommentaires(lire(FRAGMENT));
    expect(t).not.toMatch(/docker\.sock|\/var\/lib\/docker|\/var\/run|\/proc|\/sys|\/var\/log/);
    const montages = t.split("\n").filter((l) => /^\s+- \S+:\/\S+/.test(l));
    expect(montages.length).toBeGreaterThan(0);
    for (const l of montages) {
      // Seul un volume nommé du collecteur lui-même : jamais un chemin de l'hôte, jamais un volume d'une autre brique.
      expect(l, l).toMatch(/^\s+- victoria-logs-donnees:\/[a-z-]+$/);
    }
    expect(t).not.toMatch(/volumes_from|privileged|pid: *host|network_mode/);
  });

  it("[A-080] le collecteur a un plafond de rétention et de taille disque donnés par variables", () => {
    const t = sansCommentaires(lire(FRAGMENT));
    expect(t).toMatch(/-retentionPeriod=\$\{JOURNAUX_RETENTION:-[0-9]+[dwy]\}/);
    expect(t).toMatch(/-retention\.maxDiskSpaceUsageBytes=\$\{JOURNAUX_PLAFOND_OCTETS:-[0-9]+\}/);
    const inventaire = lire("ops/secrets-inventaire.md");
    expect(inventaire).toMatch(/`JOURNAUX_RETENTION` \| aucun/);
    expect(inventaire).toMatch(/`JOURNAUX_PLAFOND_OCTETS` \| aucun/);
  });
});
