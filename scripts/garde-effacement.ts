// Garde de l'effacement (A-256, A-257, C-560, C-623, C-715) : aucune échéance, aucune tâche planifiée ne mène à une suppression de données d'un client.
// Analyse du texte (commentaires retirés) et de l'arbre d'imports, rien n'est exécuté. Limites écrites (dette de contrôle de contenu) : un appel construit
// dynamiquement, ou écrit hors de apps/api/src, échappe à l'analyse ; les noms de fonctions de suppression sont une liste fermée.
export interface Fichier { chemin: string; contenu: string }
const SRC = /(?:^|[\\/])apps[\\/]api[\\/]src[\\/]/;
const FIN = "apps/api/src/fin-de-contrat/";
const EFFACER = `${FIN}effacer.ts`;
const CLICS = [`${FIN}decision-proposition.ts`, `${FIN}demande-effacement.ts`];
// Fichiers lancés par une date : la machine, la tâche de proposition, la mise à l'écart, et tout fichier d'ordonnanceur.
const PLANIFIES = [`${FIN}machine.ts`, `${FIN}proposition-suppression.ts`, `${FIN}mettre-a-l-ecart.ts`];
const MOTS = /\b(?:DELETE|DROP|TRUNCATE)\b|\b(?:effacerClient|gestionnaireEffacement|supprimerBase|detruireCleClient|retirerCompartiment|purgerCoffre|supprimerRoles)\b|DeleteObjects?/i;
const DESTRUCTIF = /DROP\s+DATABASE|\bdetruireCleClient\b|\bsupprimerBase\b|\bretirerCompartiment\b|\bpurgerCoffre\b/i;
const EXCEPTIONS_DEFINITION = ["apps/api/src/coffre/enveloppe.ts"];
const sansCommentaires = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
const normal = (c: string) => c.replaceAll("\\", "/");
const finDe = (chemin: string) => { const i = normal(chemin).indexOf("apps/api/src/"); return i < 0 ? normal(chemin) : normal(chemin).slice(i); };

export function verifierEffacement(entrees: Fichier[]): string[] {
  const erreurs: string[] = [];
  const fichiers = entrees.filter((f) => SRC.test(f.chemin) && !/\.test\.ts$/.test(f.chemin)).map((f) => ({ chemin: finDe(f.chemin), code: sansCommentaires(f.contenu) }));
  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  const importe = (f: { chemin: string; code: string }): string[] =>
    [...f.code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((m) => {
      const morceaux = f.chemin.split("/").slice(0, -1);
      for (const part of (m[1] as string).split("/")) { if (part === "..") morceaux.pop(); else if (part !== ".") morceaux.push(part); }
      return morceaux.join("/").replace(/\.js$/, ".ts");
    });

  // (a) Un fichier lancé par une date n'atteint jamais effacer.ts (arbre d'imports) et ne contient aucun mot de suppression.
  const racines = fichiers.filter((f) => PLANIFIES.includes(f.chemin) || /(?:^|\/)ordonnanceur\//.test(f.chemin));
  for (const r of racines) {
    const vus = new Set<string>();
    const pile = [r];
    while (pile.length) {
      const f = pile.pop() as { chemin: string; code: string };
      if (vus.has(f.chemin)) continue;
      vus.add(f.chemin);
      if (f.chemin === EFFACER || CLICS.includes(f.chemin)) erreurs.push(`${r.chemin}: atteint ${f.chemin} (une tâche planifiée par date ne mène jamais à un effacement, A-256)`);
      if ((f === r || f.chemin.startsWith(FIN)) && MOTS.test(f.code)) erreurs.push(`${f.chemin}: mot de suppression dans un fichier planifié par date (DELETE, DROP, TRUNCATE ou fonction d'effacement)`);
      for (const c of importe(f)) { const suivant = parChemin.get(c); if (suivant) pile.push(suivant); }
    }
  }
  // (b) Le gestionnaire relit l'état accepté en base ; il n'a pas d'autre appelant que lui-même (le branchement à la file est une exception nommée et justifiée).
  const effacer = parChemin.get(EFFACER);
  if (effacer && !(/\bsource\s*\(/.test(effacer.code) && /["']acceptee["']/.test(effacer.code))) erreurs.push(`${EFFACER}: le gestionnaire doit relire en base l'état acceptee avant d'agir`);
  for (const f of fichiers) if (f.chemin !== EFFACER && /\b(?:gestionnaireEffacement|effacerClient)\b/.test(f.code)) erreurs.push(`${f.chemin}: seul le gestionnaire de l'événement d'acceptation (effacer.ts) peut mener à l'effacement`);
  // (c) Un job d'effacement n'est mis en file que par un clic de Will tracé, jamais par le gestionnaire du gel levé.
  for (const f of fichiers) if (/\bidTacheEffacement\b/.test(f.code) && !CLICS.includes(f.chemin)) erreurs.push(`${f.chemin}: un job d'effacement ne se met en file que depuis un clic de Will (decision-proposition.ts, demande-effacement.ts)`);
  const decision = parChemin.get(`${FIN}decision-proposition.ts`);
  const levee = decision ? decision.code.slice(Math.max(0, decision.code.indexOf("reexaminerApresLevee"))) : "";
  if (/\b(?:idTacheEffacement|mettreEnFile)\b/.test(levee.replace(/export\s+const\s+idTacheEffacement[^\n]*/g, ""))) erreurs.push(`${decision?.chemin ?? ""}: le gestionnaire du gel levé ne met aucun effacement en file`);
  // Ailleurs, aucun DROP DATABASE, detruireCleClient, retrait de compartiment ni purge de chemin client hors de effacer.ts (et la définition nommée).
  for (const f of fichiers) if (f.chemin !== EFFACER && !EXCEPTIONS_DEFINITION.includes(f.chemin) && DESTRUCTIF.test(f.code)) erreurs.push(`${f.chemin}: suppression de données d'un client hors de effacer.ts`);
  return erreurs;
}
