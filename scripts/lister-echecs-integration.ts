import { readFileSync } from "node:fs";

type Essai = { status: string; fullName: string; failureMessages?: string[] };
type Fichier = { name: string; status: string; message?: string; assertionResults: Essai[] };

const rapport = JSON.parse(readFileSync(process.argv[2] ?? "rapport-integration.json", "utf8")) as { testResults: Fichier[] };
const premiereLigne = (texte: unknown) => String(texte ?? "").split("
")[0]?.slice(0, 300);

for (const fichier of rapport.testResults) {
  const nom = fichier.name.split("/").slice(-3).join("/");
  const rouges = fichier.assertionResults.filter((e) => e.status === "failed");
  for (const e of rouges) console.log("ECHEC", nom, "::", e.fullName, "::", premiereLigne(e.failureMessages?.[0]));
  if (fichier.status === "failed" && rouges.length === 0) console.log("ECHEC fichier", nom, "::", premiereLigne(fichier.message));
}
