import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  it("[A-115] garde-secrets-inventaire refuse Clients/ en majuscules et un secret client sous technique/", () => {
    const eq = lireInventaire(ENTETE + ligne("A", "equipe", "OpenBao Clients/equipe"));
    expect(verifierInventaire(eq, ["A"]).join("\n")).toMatch(/A.*clients\//);
    const cl = lireInventaire(ENTETE + ligne("B", "client", "OpenBao technique/x"));
    expect(verifierInventaire(cl, ["B"]).join("\n")).toMatch(/B.*technique/);
  });
  it("[A-115] les lectures hors config.ts, $VAR sans accolades et ops/compose.test.yml sont vues par la garde", () => {
    const lues = variablesLues(RACINE);
    expect(lues).toContain("MIGRATION_DATABASE_URL");
    expect(lues).toContain("SONDE_PORT_POSTGRES");
    expect(lues).not.toContain("VALKEY_MOT_DE_PASSE");
  });
  it("[A-303] l'instantané et les parts n'ont jamais le même lieu dans l'inventaire", () => {
    const inv = lireInventaire(lire("ops/secrets-inventaire.md"));
    const lieu = (n: string) => inv.find((l) => l.nom === n)?.lieu ?? "";
    expect(lieu("INSTANTANE_RAFT")).not.toBe("");
    expect(lieu("INSTANTANE_RAFT")).not.toMatch(/Bitwarden/i);
    expect(lieu("PART")).not.toContain(lieu("INSTANTANE_RAFT"));
  });
  it("[A-115] l'inventaire ne contient aucune valeur de secret (noms et lieux seulement)", () => {
    const texte = lire("ops/secrets-inventaire.md");
    expect(texte).not.toMatch(/\b(?:hvs|bao|sk|ghp|AKIA)[._-][A-Za-z0-9]{16,}|[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

// Faux « bao » qui suit le contrat réel : « operator unseal - » est refusé (« - » serait une part littérale), les parts
// n'arrivent que par « write sys/unseal - » en JSON sur l'entrée standard. Il garde ses arguments et ses entrées.
const BONNES_PARTS = ["cGFydFVuRmljdGlm", "cGFydERldXhGaWN0", "cGFydFRyb2lzRmlj"];
function lancerDeverrouillage(parts: string[], { injoignable = false } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), "deverrouiller-"));
  const bao = join(dossier, "bao");
  writeFileSync(
    bao,
    `#!/usr/bin/env bash
d="${dossier}"; n=$(cat "$d/etat" 2>/dev/null || echo 0)
echo "$*" >>"$d/arguments"
${injoignable ? 'echo "dial tcp: refused" >&2; exit 1' : ""}
if [ "$1" = "operator" ]; then echo "argument invalide : la part littérale « $3 » est refusée" >&2; exit 2; fi
if [ "$1 $2 $3 $4" = "write -format=json sys/unseal -" ]; then
  entree="$(cat)"; echo "$entree" >>"$d/entrees"
  cle="$(jq -r '.key // empty' <<<"$entree" 2>/dev/null)" || cle=""
  case " ${BONNES_PARTS.join(" ")} " in *" $cle "*) [ -n "$cle" ] || exit 2 ;; *) echo "part refusée" >&2; exit 2 ;; esac
  n=$((n+1)); echo "$n" >"$d/etat"
  if [ "$n" -ge 3 ]; then echo '{"sealed":false,"progress":0,"t":3}'; else echo '{"sealed":true,"progress":'$n',"t":3}'; fi
  exit 0
fi
if [ "$1" = "status" ]; then
  if [ "$n" -ge 3 ]; then echo '{"sealed":false,"progress":0,"t":3}'; else echo '{"sealed":true,"progress":'$n',"t":3}'; exit 2; fi
  exit 0
fi
exit 1
`,
  );
  chmodSync(bao, 0o755);
  const r = spawnSync("bash", [join(RACINE, "ops/openbao/deverrouiller.sh")], {
    input: parts.join("\n") + "\n",
    encoding: "utf8",
    env: { PATH: `${dossier}:${process.env.PATH}`, BAO_COMMANDE: bao, BAO_ADDR: "http://coffre.test:8200" },
  });
  const fichier = (nom: string) => (existsSync(join(dossier, nom)) ? readFileSync(join(dossier, nom), "utf8") : "");
  return { code: r.status, sortie: `${r.stdout}${r.stderr}`, arguments: fichier("arguments"), entrees: fichier("entrees") };
}

describe("deverrouiller.sh", () => {
  it("[C-523] deverrouiller.sh avec 3 parts rouvre le coffre : les parts arrivent en JSON sur l'entrée standard, jamais en argument", () => {
    const r = lancerDeverrouillage(BONNES_PARTS);
    expect(r.code).toBe(0);
    expect(r.sortie).toMatch(/déverrouillé/);
    for (const part of BONNES_PARTS) {
      expect(r.entrees).toContain(`{"key":"${part}"}`);
      expect(r.arguments).not.toContain(part);
      expect(r.sortie).not.toContain(part);
    }
    expect(r.arguments).not.toMatch(/operator unseal/);
  });
  it("[C-523] deverrouiller.sh avec 2 parts reste scellé et dit combien de parts le coffre a reçues", () => {
    const r = lancerDeverrouillage(BONNES_PARTS.slice(0, 2));
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/encore scellé, 2 parts reçues sur 3/);
    for (const part of BONNES_PARTS) expect(r.sortie).not.toContain(part);
  });
  it("[C-523] deverrouiller.sh distingue une part refusée d'une part reçue et ne la compte pas", () => {
    const r = lancerDeverrouillage(["ZmF1c3NlUGFydEZpY3RpZg==", ...BONNES_PARTS.slice(0, 2)]);
    expect(r.code).toBe(1);
    expect(r.sortie).toMatch(/part refusée par le coffre/);
    expect(r.sortie).toMatch(/2 parts reçues sur 3 \(1 refusées\)/);
  });
  it("[C-523] deverrouiller.sh s'arrête sans consommer de part quand le coffre est injoignable", () => {
    const r = lancerDeverrouillage(BONNES_PARTS, { injoignable: true });
    expect(r.code).toBe(2);
    expect(r.sortie).toMatch(/coffre injoignable/);
    expect(r.entrees).toBe("");
  });
  it("[C-523] deverrouiller.sh ne montre aucune part sous « bash -x »", () => {
    const dossier = mkdtempSync(join(tmpdir(), "deverrouiller-x-"));
    const bao = join(dossier, "bao");
    writeFileSync(bao, `#!/usr/bin/env bash\ncat >/dev/null 2>&1\necho '{"sealed":false}'\n`);
    chmodSync(bao, 0o755);
    const r = spawnSync("bash", ["-x", join(RACINE, "ops/openbao/deverrouiller.sh")], {
      input: "cGFydFNlY3JldEZpY3Q=\n",
      encoding: "utf8",
      env: { PATH: process.env.PATH, BAO_COMMANDE: bao },
    });
    expect(`${r.stdout}${r.stderr}`).not.toContain("cGFydFNlY3JldEZpY3Q=");
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
