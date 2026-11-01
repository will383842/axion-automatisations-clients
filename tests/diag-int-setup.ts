import { writeSync } from "node:fs";
import { afterEach } from "vitest";

// Diagnostic temporaire (T2-05) : écrit chaque essai d'intégration en échec dans le journal du job. À retirer.
afterEach((contexte) => {
  if (contexte.task.result?.state === "fail") writeSync(2, `DIAG ${contexte.task.file?.name ?? "?"} > ${contexte.task.name} : ${String(contexte.task.result.errors?.[0]?.message ?? "").slice(0, 300)}\n`);
});
