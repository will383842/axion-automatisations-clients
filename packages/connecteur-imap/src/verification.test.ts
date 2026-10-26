import { describe, expect, it } from "vitest";
import { optionsImap, optionsSmtp, reglerTls, verifierConfiguration } from "./verification.ts";

const base = { hoteImap: "imap.exemple.test", hoteSmtp: "smtp.exemple.test", utilisateur: "instance-essai", expediteur: "atelier@exemple.fr" };

describe("configuration du connecteur", () => {
  it("[A-335] le connecteur n'accepte pas de champ « motDePasseApplication » dans sa configuration", () => {
    expect(() => verifierConfiguration({ ...base, motDePasseApplication: "x" })).toThrow();
    expect(() => verifierConfiguration({ ...base, motDePasse: "x" })).toThrow();
    expect(() => verifierConfiguration(base)).not.toThrow();
  });
  it("[A-335] le mot de passe d'une connexion est le jeton court reçu, jamais une valeur de la configuration", () => {
    const c = verifierConfiguration(base);
    expect(optionsImap(c, "jeton-court-fictif").auth).toEqual({ user: "instance-essai", pass: "jeton-court-fictif" });
    expect(optionsSmtp(c, "jeton-court-fictif").auth).toEqual({ user: "instance-essai", pass: "jeton-court-fictif" });
    expect(JSON.stringify(c)).not.toContain("jeton-court-fictif");
  });
  it("[A-389] un chiffrement « aucun » ou un port en clair est refusé", () => {
    expect(() => verifierConfiguration({ ...base, chiffrementImap: "aucun" })).toThrow();
    expect(() => verifierConfiguration({ ...base, chiffrementSmtp: "aucun" })).toThrow();
    expect(() => verifierConfiguration({ ...base, portImap: 143, chiffrementImap: "tls" })).toThrow();
    expect(() => verifierConfiguration({ ...base, portSmtp: 25 })).toThrow();
  });
  it("[A-389] TLS par défaut (993 et 465) ; STARTTLS est exigé, sans repli en clair", () => {
    const c = verifierConfiguration(base);
    expect(optionsImap(c, "j")).toMatchObject({ host: "imap.exemple.test", port: 993, secure: true });
    expect(optionsSmtp(c, "j")).toMatchObject({ port: 465, secure: true, ignoreTLS: false });
    const s = verifierConfiguration({ ...base, portImap: 143, chiffrementImap: "starttls", portSmtp: 587, chiffrementSmtp: "starttls" });
    expect(optionsImap(s, "j")).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(optionsSmtp(s, "j")).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });
  it("[A-389] la vérification du certificat et TLS 1.2 minimum ne se désactivent pas par la configuration", () => {
    expect(() => verifierConfiguration({ ...base, tls: { rejectUnauthorized: false } })).toThrow();
    expect(optionsImap(verifierConfiguration(base), "j").tls).toMatchObject({ minVersion: "TLSv1.2" });
  });
});

describe("réglage TLS des essais", () => {
  const c = verifierConfiguration(base);
  it("[A-389] TLS 1.2 minimum ne peut pas être remplacé par l'objet reçu", () => {
    const tls = { minVersion: "TLSv1", ciphers: "NULL" } as unknown as { ca: string };
    expect(optionsImap(c, "jeton-fictif", tls).tls).toEqual({ minVersion: "TLSv1.2" });
    expect(optionsSmtp(c, "jeton-fictif", tls).tls).toEqual({ minVersion: "TLSv1.2" });
  });
  it("[A-389] couper la vérification du certificat est refusé hors environnement de test", () => {
    const coupe = { rejectUnauthorized: false } as const;
    expect(() => reglerTls(coupe, { NODE_ENV: "production" })).toThrow(expect.objectContaining({ classe: "definitive", code: "reglage_tls_interdit" }));
    expect(() => reglerTls(coupe, {})).toThrow();
    expect(reglerTls(coupe, { NODE_ENV: "test" })).toEqual({ minVersion: "TLSv1.2", rejectUnauthorized: false });
  });
  it("[A-389] une autorité de test (ca) est acceptée partout et ne coupe rien", () => {
    expect(reglerTls({ ca: "-----BEGIN CERTIFICATE-----" }, { NODE_ENV: "production" })).toEqual({ minVersion: "TLSv1.2", ca: "-----BEGIN CERTIFICATE-----" });
  });
});

