import { describe, expect, it } from "vitest";
import { verifierDestinations } from "./garde-destinations.js";

// Adresses de documentation (RFC 5737) et domaines réservés (RFC 2606) : jamais un vrai service.
const IP_DOC = "192.0.2.1";
const IP_DOC_DECIMALE = "3221225985";
const IP_DOC_HEXA = "0xc0000201";
const SOCLE = new Set(["mailpit", "recepteurs"]);

describe("garde des destinations", () => {
  it("[C-533] @envoi garde-destinations refuse graph.microsoft.com et n'affiche que le nom de la variable", () => {
    expect(verifierDestinations({ GRAPH_URL: "https://graph.microsoft.com/v1.0" }, SOCLE)).toEqual(["GRAPH_URL"]);
    const erreurs = verifierDestinations({ GRAPH_URL: "https://jeton-ne-pas-afficher@exemple.com/v1.0" }, SOCLE);
    expect(erreurs).toEqual(["GRAPH_URL"]);
    expect(JSON.stringify(erreurs)).not.toContain("exemple.com");
    expect(JSON.stringify(erreurs)).not.toContain("jeton-ne-pas-afficher");
  });

  it("[C-533] @envoi refuse Gmail, Telegram, MailWizz distant, webhook distant et SMTP réel", () => {
    const erreurs = verifierDestinations(
      {
        GMAIL_URL: "https://gmail.googleapis.com",
        TELEGRAM_URL: "https://api.telegram.org",
        MAILWIZZ_URL: "https://mailwizz.example.com/api",
        WEBHOOK_ALERTES: "https://hooks.example.com/x",
        SMTP_HOTE: "smtp.example.com",
      },
      SOCLE,
    );
    expect(erreurs.sort()).toEqual(["GMAIL_URL", "MAILWIZZ_URL", "SMTP_HOTE", "TELEGRAM_URL", "WEBHOOK_ALERTES"]);
  });

  it("[C-533] @envoi accepte localhost, 127.0.0.1 et les noms du réseau interne", () => {
    expect(
      verifierDestinations(
        { SMTP_HOTE: "mailpit:1025", GRAPH_URL: "http://127.0.0.1:4010", GMAIL_URL: "http://localhost:4011", TELEGRAM_URL: "http://recepteurs:4012", WEBHOOK_X: "http://faux-hub.test/webhook/a" },
        SOCLE,
      ),
    ).toEqual([]);
  });

  it("[C-533] @envoi contournements : identifiant trompeur, sous-domaine piégé, hôte vide, URL illisible, majuscules", () => {
    const erreurs = verifierDestinations(
      {
        GRAPH_URL: "http://localhost@exemple.com/",
        GMAIL_URL: "http://localhost.example.com/",
        TELEGRAM_URL: "http://",
        MAILWIZZ_URL: "pas une url",
        WEBHOOK_A: "HTTPS://API.TELEGRAM.ORG/bot1",
        SMTP_HOTE: "localhost.example.com",
      },
      SOCLE,
    );
    expect(erreurs.sort()).toEqual(["GMAIL_URL", "GRAPH_URL", "MAILWIZZ_URL", "SMTP_HOTE", "TELEGRAM_URL", "WEBHOOK_A"]);
  });

  it("[C-533] @envoi ignore les variables sans rapport avec un envoi", () => {
    expect(verifierDestinations({ AUTRE: "https://graph.microsoft.com", GRAPH_URL: "", LANGUE: "fr" }, SOCLE)).toEqual([]);
  });

  it("[C-533] @envoi contournement : hôte purement numérique (adresse IP en décimal ou en hexadécimal) refusé", () => {
    expect(verifierDestinations({ SMTP_HOTE: IP_DOC_DECIMALE, WEBHOOK_B: IP_DOC_HEXA, GMAIL_URL: `http://${IP_DOC}/` }, SOCLE).sort()).toEqual(["GMAIL_URL", "SMTP_HOTE", "WEBHOOK_B"]);
  });

  it("[C-533] @envoi contournement : variable absente de la liste d'origine, ou nom en minuscules", () => {
    const erreurs = verifierDestinations(
      { GRAPH_LOGIN_URL: "https://login.microsoftonline.com", SMTP_URL: "smtp://smtp.example.com:25", webhook_x: "https://hooks.example.com", API_HOST: "api.example.com", relais_hote: "smtp.example.com" },
      SOCLE,
    );
    expect(erreurs.sort()).toEqual(["API_HOST", "GRAPH_LOGIN_URL", "SMTP_URL", "relais_hote", "webhook_x"]);
  });

  it("[C-533] @envoi contournement : un nom à une seule étiquette doit être un service du socle", () => {
    expect(verifierDestinations({ GMAIL_URL: "http://gmail/", SMTP_HOTE: "0x", GRAPH_URL: "http://recepteurs:4012" }, SOCLE).sort()).toEqual(["GMAIL_URL", "SMTP_HOTE"]);
    expect(verifierDestinations({ SMTP_HOTE: "mailpit" })).toEqual(["SMTP_HOTE"]);
  });

  it("[C-533] @envoi contournement : SMTP_HOTE avec schéma, identifiant ou espace est refusé", () => {
    const erreurs = verifierDestinations({ SMTP_HOTE: "smtps://smtp.example.com:465", WEBHOOK_C: "mailpit@exemple.com", GRAPH_URL: "mailpit smtp.example.com" }, SOCLE);
    expect(erreurs.sort()).toEqual(["GRAPH_URL", "SMTP_HOTE", "WEBHOOK_C"]);
  });
});
