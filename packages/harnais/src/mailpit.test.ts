import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit, hotesSmtpDeclares } from "./mailpit.js";

const mailpit = creerClientMailpit();
// Voir faux-graph.test.ts : le service Mailpit n'existe que dans le job « harnais ».
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20
const racine = fileURLToPath(new URL("../../..", import.meta.url));

beforeEach(async () => {
  if (!process.env["MAILPIT_API"]) return;
  await mailpit.attendrePret();
});

describe("piège Mailpit", () => {
  // Les fichiers de test partagent un seul Mailpit : ce test ne vide pas tout, il supprime son propre message.
  itMailpit("[C-533] Mailpit capte un message et le supprime par son identifiant", async () => {
    const dest = `${randomUUID()}@exemple.fr`;
    await nodemailer.createTransport({ host: "127.0.0.1", port: 1025, secure: false }).sendMail({ from: "a@exemple.fr", to: dest, subject: "essai", text: "x" });
    const fin = Date.now() + 10_000;
    let ids: string[] = [];
    while (ids.length === 0 && Date.now() < fin) {
      ids = (await mailpit.lister()).filter((m) => m.To.some((a) => a.Address === dest)).map((m) => m.ID);
      if (ids.length === 0) await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(ids).toHaveLength(1);
    const api = process.env["MAILPIT_API"] ?? "http://127.0.0.1:8025";
    await fetch(new URL("/api/v1/messages", api), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
    expect((await mailpit.lister()).some((m) => m.To.some((a) => a.Address === dest))).toBe(false);
  });

  it("[C-533] le client refuse un hôte qui n'est pas local", () => {
    expect(() => creerClientMailpit({ api: "http://mail.exemple.fr:8025" })).toThrow();
  });

  it("[C-533] aucune adresse SMTP autre que celle de Mailpit dans la configuration", () => {
    const fichiers = [
      ...readdirSync(join(racine, "packages/harnais/src"), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(racine, "packages/harnais/src", f)),
      join(racine, "ops/compose.test.yml"),
      join(racine, ".github/workflows/harnais.yml"),
    ];
    const hotes = fichiers.flatMap((f) => hotesSmtpDeclares(readFileSync(f, "utf8")));
    expect(hotes.length).toBeGreaterThan(0);
    for (const h of hotes) expect(["127.0.0.1", "localhost"]).toContain(h);
  });

  it("[C-533] hotesSmtpDeclares repère une adresse SMTP étrangère", () => {
    expect(hotesSmtpDeclares('SMTP_HOST=smtp.autre.test\nurl: "smtp://relais.exemple.fr:25"').sort()).toEqual(["relais.exemple.fr", "smtp.autre.test"]);
  });
});
