import { existsSync, readFileSync, writeSync } from "node:fs";

// Diagnostic temporaire (T2-05) : à la fin du run, relit le rapport JSON et écrit tout fichier ou essai non réussi dans le journal du job. À retirer.
export default function setup() {
  process.on("exit", () => {
    const f = "rapport-integration.json";
    if (!existsSync(f)) return writeSync(2, "DIAG2 rapport absent\n");
    const r = JSON.parse(readFileSync(f, "utf8")) as { numFailedTests?: number; numFailedTestSuites?: number; numTotalTestSuites?: number; testResults?: { name: string; status: string; message?: string; assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[] }[] };
    writeSync(2, `DIAG2 échecs essais=${r.numFailedTests} fichiers=${r.numFailedTestSuites}/${r.numTotalTestSuites}\n`);
    for (const t of r.testResults ?? []) {
      if (t.status !== "passed") writeSync(2, `DIAG2 fichier ${t.name} : ${t.status} ${(t.message ?? "").slice(0, 400).replace(/\n/g, " ")}\n`);
      for (const a of t.assertionResults ?? []) if (a.status === "failed") writeSync(2, `DIAG2 essai ${a.fullName.slice(0, 120)} : ${(a.failureMessages?.[0] ?? "").slice(0, 300).replace(/\n/g, " ")}\n`);
    }
  });
}
