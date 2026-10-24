import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { creerClientMailpit, hotesSmtpDeclares } from "./mailpit.js";
import { prendreVerrouMailpit } from "./verrou-mailpit.js";

const mailpit = creerClientMailpit();
// Voir faux-graph.test.ts : le service Mailpit n'existe que dans le job « harnais ».
const itMailpit = process.env["MAILPIT_API"] ? it : it.skip; // fiche: T0-20
const racine = fileURLToPath(new URL("../../..", import.meta.url));

let liberer: (() => void) | undefined;
beforeAll(async () => {
  if (process.env["MAILPIT_API"]) liberer = await prendreVerrouMailpit();
});
afterAll(() => liberer?.());

beforeEach(async () => {
  if (!process.env["MAILPIT_API"]) return;
  await mailpit.attendrePret();
  await mailpit.vider();
});

describe("piège Mailpit", () => {
  itMailpit("[C-533] Mailpit est vidé entre deux tests", async () => {
    await nodemailer
      .createTransport({ host: "127.0.0.1", port: 1025, secure: false })
      .sendMail({ from: "a@exemple.fr", to: "b@exemple.fr", subject: "essai", text: "x" });
    expect(await mailpit.attendreMessages(1)).toHaveLength(1);
    await mailpit.vider();
    expect(await mailpit.lister()).toHaveLength(0);
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
