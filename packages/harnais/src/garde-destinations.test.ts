import { describe, expect, it } from "vitest";
import { verifierDestinations } from "./garde-destinations.js";

describe("garde des destinations", () => {
  it("[C-533] @envoi garde-destinations refuse graph.microsoft.com et n'affiche que le nom de la variable", () => {
    const secret = "jeton-ne-pas-afficher";
    const erreurs = verifierDestinations({ GRAPH_URL: ["https://" + secret, "graph.microsoft.com/v1.0"].join("@") });
    expect(erreurs).toEqual(["GRAPH_URL"]);
    expect(JSON.stringify(erreurs)).not.toContain("microsoft");
    expect(JSON.stringify(erreurs)).not.toContain(secret);
  });

  it("[C-533] @envoi refuse Gmail, Telegram, MailWizz distant, webhook distant et SMTP réel", () => {
    const erreurs = verifierDestinations({
      GMAIL_URL: "https://gmail.googleapis.com",
      TELEGRAM_URL: "https://api.telegram.org",
      MAILWIZZ_URL: "https://mailwizz.autre.com/api",
      WEBHOOK_ALERTES: "https://hooks.autre.com/x",
      SMTP_HOTE: "smtp.autre.com",
    });
    expect(erreurs.sort()).toEqual(["GMAIL_URL", "MAILWIZZ_URL", "SMTP_HOTE", "TELEGRAM_URL", "WEBHOOK_ALERTES"]);
  });

  it("[C-533] @envoi accepte localhost, 127.0.0.1 et les noms du réseau interne", () => {
    expect(
      verifierDestinations({ SMTP_HOTE: "mailpit", GRAPH_URL: "http://127.0.0.1:4010", GMAIL_URL: "http://localhost:4011", TELEGRAM_URL: "http://recepteurs:4012", WEBHOOK_X: "http://faux-hub.test/webhook/a" }),
    ).toEqual([]);
  });

  it("[C-533] @envoi contournements : userinfo trompeur, sous-domaine piégé, hôte vide, URL illisible, majuscules", () => {
    const erreurs = verifierDestinations({
      GRAPH_URL: ["http://localhost", "graph.microsoft.com/"].join("@"),
      GMAIL_URL: "http://localhost.autre.com/",
      TELEGRAM_URL: "http://",
      MAILWIZZ_URL: "pas une url",
      WEBHOOK_A: "HTTPS://API.TELEGRAM.ORG/bot1",
      SMTP_HOTE: "localhost.autre.com",
    });
    expect(erreurs.sort()).toEqual(["GMAIL_URL", "GRAPH_URL", "MAILWIZZ_URL", "SMTP_HOTE", "TELEGRAM_URL", "WEBHOOK_A"]);
  });

  it("[C-533] @envoi ignore les variables absentes ou sans rapport", () => {
    expect(verifierDestinations({ AUTRE: "https://graph.microsoft.com", GRAPH_URL: "" })).toEqual([]);
  });

  it("[C-533] @envoi contournement : hôte purement numérique (adresse IP en décimal ou en hexadécimal) refusé", () => {
    expect(verifierDestinations({ SMTP_HOTE: "134744072", WEBHOOK_B: "0x08080808", GMAIL_URL: "http://8.8.8.8/" }).sort()).toEqual(["GMAIL_URL", "SMTP_HOTE", "WEBHOOK_B"]);
  });
});
