import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./rejouer-socle.sh", import.meta.url));

// À blanc : le script contrôle sa cible et ses destinations d'e-mails, puis s'arrête avant tout lancement.
function lancer(env: Record<string, string>) {
  const r = spawnSync("bash", [script], {
    env: { PATH: process.env["PATH"] ?? "", RECETTE_A_BLANC: "1", ...env },
    encoding: "utf8",
  });
  return { code: r.status, sortie: `${r.stdout}${r.stderr}` };
}

describe("recette intégrée du socle", () => {
  it("[A-079] le script de recette refuse de s'exécuter contre la production", () => {
    for (const env of [
      { RECETTE_CIBLE: "production" },
      { RECETTE_CIBLE: "prod" },
      { AXION_ENV: "production" },
      { NODE_ENV: "production" },
      { RECETTE_CIBLE: "inconnue" },
    ]) {
      const r = lancer(env);
      expect(r.code, JSON.stringify(env)).toBe(2);
      expect(r.sortie).toContain("refus");
    }
    // La cible par défaut est la recette locale (conteneurs de test).
    const ok = lancer({});
    expect(ok.code).toBe(0);
    expect(ok.sortie).toContain("cible : recette");
  });

  it("[C-533] pendant la recette intégrée, aucun e-mail ne quitte le serveur de test", () => {
    // Un hôte d'envoi qui n'est pas le piège à e-mails local est refusé, sans afficher sa valeur.
    const hote = "smtp.exemple.fr";
    const r = lancer({ SMTP_HOTE: hote });
    expect(r.code).toBe(2);
    expect(r.sortie).toContain("SMTP_HOTE");
    expect(r.sortie).not.toContain(hote);
    // Le piège local (Mailpit) est le seul destinataire accepté.
    const ok = lancer({ SMTP_HOTE: "127.0.0.1", MAILPIT_API: "http://127.0.0.1:8025" });
    expect(ok.code).toBe(0);
    expect(ok.sortie).toContain("piège à e-mails");
    expect(lancer({ MAILPIT_API: "http://mail.exemple.fr:8025" }).code).toBe(2);
  });
});
