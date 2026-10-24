import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formaterTrouvailles, scannerDossier, scannerTexte } from "./scanner-journaux.js";

// Les valeurs à refuser sont fabriquées à l'exécution, à partir de morceaux, et jamais affichées.
const arobase = "@";
const courrielHorsListe = ["jean", "dupont"].join(".") + arobase + ["societe", "fr"].join(".");
const ipv4 = (...o: number[]) => o.join(".");
const ipPrivee = ipv4(10, 12, 7, 33);
const ipDoc = ipv4(192, 0, 2, 17);
const telReel = ["06", "12", "34", "56", "78"].join(" ");
const telFiction = ["06", "39", "98", "12", "34"].join(" ");

describe("scanner-journaux", () => {
  it("[C-531] scanner-journaux trouve un e-mail hors liste et n'affiche pas sa valeur", () => {
    const t = scannerTexte("etape.txt", `ligne 1\nenvoi à ${courrielHorsListe} terminé\n`);
    expect(t).toEqual([{ type: "e-mail", fichier: "etape.txt", ligne: 2 }]);
    expect(formaterTrouvailles(t).join("\n")).not.toContain(courrielHorsListe);
    expect(formaterTrouvailles(t).join("\n")).not.toContain("societe");
  });
  it("[C-531] scanner-journaux ne signale rien pour prenom@exemple.fr", () => {
    const ok = ["prenom" + arobase + "exemple.fr", "a" + arobase + "exemple.com", "b" + arobase + "client.test"];
    expect(scannerTexte("e.txt", ok.join("\n"))).toEqual([]);
  });
  it("[C-531] scanner-journaux trouve un IBAN valide sans l'afficher", () => {
    const iban = "GB82" + "WEST" + "1234" + "5698" + "7654" + "32";
    const t = scannerTexte("e.txt", `compte ${iban}`);
    expect(t.map((x) => x.type)).toEqual(["IBAN"]);
    expect(formaterTrouvailles(t).join("\n")).not.toContain("WEST");
  });
  it("[C-531] scanner-journaux trouve un téléphone français hors plages de fiction", () => {
    expect(scannerTexte("e.txt", `appel ${telReel}`).map((x) => x.type)).toEqual(["téléphone"]);
    expect(scannerTexte("e.txt", `appel ${telFiction}`)).toEqual([]);
  });
  it("[C-531] scanner-journaux trouve une IPv4 hors liste et laisse passer la documentation", () => {
    expect(scannerTexte("e.txt", `hôte ${ipPrivee}`).map((x) => x.type)).toEqual(["IPv4"]);
    expect(scannerTexte("e.txt", `hôtes ${ipDoc} ${ipv4(127, 0, 0, 1)} ${ipv4(0, 0, 0, 0)}`)).toEqual([]);
    expect(formaterTrouvailles(scannerTexte("e.txt", ipPrivee)).join("\n")).not.toContain(ipPrivee);
  });
  it("[C-531] scanner-journaux ne signale pas un numéro de version", () => {
    expect(scannerTexte("e.txt", "vitest v3.2.7 node 22.22.0")).toEqual([]);
  });
  it("[C-531] scanner-journaux laisse passer l'adresse noreply de GitHub", () => {
    expect(scannerTexte("e.txt", "auteur 12345+prenom" + arobase + "users.noreply.github.com")).toEqual([]);
  });
  it("[C-531] scanner-journaux ne suit pas les liens symboliques : trouvaille « lien symbolique »", () => {
    const d = mkdtempSync(join(tmpdir(), "journaux-"));
    mkdirSync(join(d, "piece"));
    writeFileSync(join(d, "piece", "ok.txt"), "rien\n");
    symlinkSync("..", join(d, "piece", "boucle"));
    symlinkSync("/etc/hostname", join(d, "piece", "autre.txt"));
    const t = scannerDossier(d);
    expect(t.map((x) => x.type)).toEqual(["lien symbolique", "lien symbolique"]);
    expect(formaterTrouvailles(t).join("\n")).not.toContain("/etc");
  });
  it("[C-531] scanner-journaux ne prend pas un numéro de version à quatre morceaux pour une IP", () => {
    const v = ipv4(1, 2, 3, 4);
    expect(scannerTexte("e.txt", `outil v${v} paquet@${v} version ${v}`)).toEqual([]);
  });
});
