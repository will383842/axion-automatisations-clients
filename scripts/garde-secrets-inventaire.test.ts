import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lireInventaire, variablesLues, verifierInventaire } from "./garde-secrets-inventaire.js";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), "utf8");
const ENTETE = "| Nom | Catégorie | Lieu | Rotation |\n|---|---|---|---|\n";
const ligne = (nom: string, categorie: string, lieu: string) => `| \`${nom}\` | ${categorie} | ${lieu} | à chaque départ |\n`;

describe("garde-secrets-inventaire", () => {
  it("[A-115] garde-secrets-inventaire refuse une variable non inscrite", () => {
    const inventaire = lireInventaire(ENTETE + ligne("PORT", "aucun", "environnement cloud"));
    const erreurs = verifierInventaire(inventaire, ["PORT", "SOCLE_NOUVEAU_SECRET"]);
    expect(erreurs.join("\n")).toMatch(/SOCLE_NOUVEAU_SECRET.*non inscrite/);
    expect(erreurs).toHaveLength(1);
  });
  it("[A-115] garde-secrets-inventaire refuse un secret d'équipe rangé sous clients/", () => {
    const inventaire = lireInventaire(ENTETE + ligne("JETON_EQUIPE", "equipe", "OpenBao clients/equipe"));
    expect(verifierInventaire(inventaire, ["JETON_EQUIPE"]).join("\n")).toMatch(/JETON_EQUIPE.*clients\//);
  });
  it("[A-115] garde-secrets-inventaire accepte un secret d'équipe sous technique/ et un secret client sous clients/", () => {
    const inventaire = lireInventaire(ENTETE + ligne("A", "equipe", "OpenBao technique/") + ligne("B", "client", "OpenBao clients/"));
    expect(verifierInventaire(inventaire, ["A", "B"])).toEqual([]);
  });
  it("[A-115] garde-secrets-inventaire refuse une catégorie inconnue", () => {
    const inventaire = lireInventaire(ENTETE + ligne("A", "autre", "Bitwarden"));
    expect(verifierInventaire(inventaire, ["A"]).join("\n")).toMatch(/A.*catégorie/);
  });
  it("[A-115] les variables lues par config.ts et les compose sont toutes inscrites à l'inventaire", () => {
    const inventaire = lireInventaire(lire("ops/secrets-inventaire.md"));
    const lues = variablesLues(RACINE);
    expect(lues).toContain("APP_DATABASE_URL");
    expect(lues).toContain("SOCLE_PG_MOT_DE_PASSE");
    expect(verifierInventaire(inventaire, lues)).toEqual([]);
  });
  it("[A-115] l'inventaire ne contient aucune valeur de secret (noms et lieux seulement)", () => {
    const texte = lire("ops/secrets-inventaire.md");
    expect(texte).not.toMatch(/\b(?:hvs|bao|sk|ghp|AKIA)[._-][A-Za-z0-9]{16,}|[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

// Faux « bao » : un compteur de parts dans un fichier ; trois parts rouvrent le coffre.
function lancerDeverrouillage(parts: string[]) {
  const dossier = mkdtempSync(join(tmpdir(), "deverrouiller-"));
  const bao = join(dossier, "bao");
  writeFileSync(
    bao,
    `#!/usr/bin/env bash
etat="${dossier}/etat"; n=$(cat "$etat" 2>/dev/null || echo 0)
case "$2$1" in
  *unseal) cat >/dev/null; n=$((n+1)); echo "$n" >"$etat" ;;
esac
if [ "$1" = status ] || [ "$1" = operator ]; then
  if [ "$n" -ge 3 ]; then echo '{"sealed":false,"progress":0,"t":3}'; else echo "{\\"sealed\\":true,\\"progress\\":$n,\\"t\\":3}"; fi
  [ "$n" -ge 3 ] || exit 2
fi
`,
  );
  chmodSync(bao, 0o755);
  const r = spawnSync("bash", [join(RACINE, "ops/openbao/deverrouiller.sh")], {
    input: parts.join("\n") + "\n",
    encoding: "utf8",
    env: { PATH: `${dossier}:${process.env.PATH}`, BAO_COMMANDE: bao, BAO_ADDR: "http://127.0.0.1:1" },
  });
  return { code: r.status, sortie: `${r.stdout}${r.stderr}` };
}

describe("deverrouiller.sh", () => {
  it("[C-523] deverrouiller.sh avec 3 parts rouvre le coffre et dit « déverrouillé »", () => {
    const r = lancerDeverrouillage(["part-un-fictive", "part-deux-fictive", "part-trois-fictive"]);
    expect(r.code).toBe(0);
    expect(r.sortie).toMatch(/déverrouillé/);
    expect(r.sortie).not.toMatch(/part-(un|deux|trois)-fictive/);
  });
  it("[C-523] deverrouiller.sh avec 2 parts reste scellé et dit combien de parts sont reçues", () => {
    const r = lancerDeverrouillage(["part-un-fictive", "part-deux-fictive"]);
    expect(r.code).not.toBe(0);
    expect(r.sortie).toMatch(/encore scellé, 2 parts reçues sur 3/);
    expect(r.sortie).not.toMatch(/part-(un|deux)-fictive/);
  });
  it("[C-523] deverrouiller.sh refuse une part passée en argument", () => {
    const r = spawnSync("bash", [join(RACINE, "ops/openbao/deverrouiller.sh"), "part-en-clair"], { encoding: "utf8", input: "" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/entrée standard/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/part-en-clair/);
  });
});

describe("procédures OpenBao", () => {
  it("[C-523] la procédure de déverrouillage cite le seuil 3 sur 5, l'essai trimestriel et l'état coffre_scelle", () => {
    const t = lire("ops/openbao/procedure-deverrouillage.md");
    expect(t).toMatch(/3 parts sur 5/);
    expect(t).toMatch(/trimestre/);
    expect(t).toMatch(/coffre_scelle/);
  });
  it("[A-303] la sauvegarde de secours sépare l'instantané des parts de déverrouillage", () => {
    const t = lire("ops/openbao/sauvegarde-de-secours.md");
    expect(t).toMatch(/instantané/);
    expect(t).toMatch(/jamais.*avec les parts|parts.*jamais.*ensemble/is);
  });
});
