// Sonde extérieure (C-602) : tourne HORS du serveur, lit son adresse de santé, alerte quand il se tait ou quand la sauvegarde manque.
// Usage : SONDE_URL=<adresse de santé> ALERTE_COMMANDE=<exécutable> [SONDE_ETAT=<fichier d'état>] node sonde.ts
// La réponse de santé attendue : {"derniereSauvegarde": <secondes depuis l'époque>}. L'alerte est lancée ainsi : "$ALERTE_COMMANDE" <type> <niveau> "<message>".
// Sortie : 0 tout est dit ; 1 une alerte n'a pas pu partir (l'état n'est pas enregistré : elle sera retentée) ; 2 réglage manquant.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Etat { echecs: number; muetAlerte: boolean; sauvegardeAlerte: boolean }
export interface Mesure { repondu: boolean; derniereSauvegardeS?: number }
export interface Alerte { type: string; niveau: "reveil" | "matin"; message: string }
const ECHECS_AVANT_ALERTE = 2;
const FRAICHEUR_S = 26 * 3600;

export async function mesurer(url: string, chercher: typeof fetch, delaiMs: number): Promise<Mesure> {
  const ctl = new AbortController();
  const minuteur = setTimeout(() => ctl.abort(), delaiMs);
  try {
    const rep = await chercher(url, { signal: ctl.signal });
    if (!rep.ok) return { repondu: false };
    try {
      const d = (JSON.parse(await rep.text()) as { derniereSauvegarde?: unknown }).derniereSauvegarde;
      return typeof d === "number" ? { repondu: true, derniereSauvegardeS: d } : { repondu: true };
    } catch {
      return { repondu: true };
    }
  } catch {
    return { repondu: false };
  } finally {
    clearTimeout(minuteur);
  }
}

export function decider(etat: Etat, mesure: Mesure, maintenantS: number): { etat: Etat; alertes: Alerte[] } {
  const alertes: Alerte[] = [];
  const suivant = { ...etat };
  if (!mesure.repondu) {
    suivant.echecs++;
    if (suivant.echecs >= ECHECS_AVANT_ALERTE && !suivant.muetAlerte) {
      suivant.muetAlerte = true;
      alertes.push({ type: "serveur_muet", niveau: "reveil", message: "Le serveur de la console ne répond plus à la sonde extérieure." });
    }
    return { etat: suivant, alertes };
  }
  if (suivant.muetAlerte) alertes.push({ type: "serveur_revenu", niveau: "matin", message: "Le serveur de la console répond de nouveau." });
  suivant.echecs = 0;
  suivant.muetAlerte = false;
  const d = mesure.derniereSauvegardeS;
  const fraiche = typeof d === "number" && Number.isFinite(d) && d <= maintenantS && maintenantS - d <= FRAICHEUR_S;
  if (fraiche) suivant.sauvegardeAlerte = false;
  else if (!suivant.sauvegardeAlerte) {
    suivant.sauvegardeAlerte = true;
    alertes.push({ type: "sauvegarde_absente", niveau: "reveil", message: "Aucune sauvegarde récente (plus de 26 heures) ou date illisible." });
  }
  return { etat: suivant, alertes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.SONDE_URL;
  const commande = process.env.ALERTE_COMMANDE;
  if (!url || !commande) { console.error("SONDE_URL et ALERTE_COMMANDE sont obligatoires"); process.exit(2); }
  const fichier = process.env.SONDE_ETAT ?? "etat-sonde.json";
  let etat: Etat = { echecs: 0, muetAlerte: false, sauvegardeAlerte: false };
  try { etat = { ...etat, ...(JSON.parse(readFileSync(fichier, "utf8")) as Partial<Etat>) }; } catch { /* premier passage */ }
  const r = decider(etat, await mesurer(url, fetch, 10_000), Math.floor(Date.now() / 1000));
  let code = 0;
  for (const a of r.alertes) {
    try { execFileSync(commande, [a.type, a.niveau, a.message], { stdio: "ignore" }); } catch { code = 1; console.error(`alerte ${a.type} non envoyée`); }
  }
  if (code === 0) writeFileSync(fichier, JSON.stringify(r.etat));
  process.exit(code);
}
