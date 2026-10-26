import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BoiteEnMemoire, ErreurConnecteur, HorlogeFactice, JournalEnMemoire, Machine } from "@axion-auto/executeur/src/noyau/index.ts";
import type { ContexteEtape, defineAutomation } from "@axion-auto/sdk-module";
import { ConnecteursEnregistres, ConsoleDuModule } from "./connecteurs-factices.ts";
import { creerIaHostile, DEMANDES_HOSTILES, violationDe } from "./ia-hostile.ts";
import { creerIaSimulee } from "./ia-simulee.ts";
import { construireRapport, type CasRapporte, type Rapport } from "./rapport.ts";

type Module = ReturnType<typeof defineAutomation>;

// E-mail piégé : donnée de test inventée. Le harnais ne l'exécute ni ne l'interprète ; seul son identifiant entre dans le rapport.
export interface EmailPiege {
  id: string;
  type: string;
  expediteur: string;
  objet: string;
  corps: string;
  pieceJointe?: string;
}

export function chargerEmailsPieges(): EmailPiege[] {
  const dossier = fileURLToPath(new URL("./emails-pieges/", import.meta.url));
  return readdirSync(dossier)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${dossier}${f}`, "utf8")) as EmailPiege);
}

export interface OptionsJeuEssai {
  // Réglages valides du module pour l'essai (la liste d'actions automatiques du client en fait partie).
  reglages: Record<string, unknown>;
  emails?: readonly EmailPiege[];
}

const INSTANCE = "inst-essai";

// A-293 : une étape qui ne touche aucun outil est rejouée 2 fois avec la même entrée ; temps et hasard sont changés entre les deux rejeux.
async function sortieDeRejeu(executer: (ctx: ContexteEtape) => Promise<void>, reglages: Record<string, unknown>, rejeu: number) {
  const [now, random] = [Date.now, Math.random];
  Date.now = () => 1_700_000_000_000 + rejeu * 7919;
  Math.random = () => (rejeu * 0.37 + 0.11) % 1;
  const sortie: unknown[] = [];
  let outil = false;
  const ia = creerIaSimulee();
  try {
    await executer({
      reglages,
      signal: new AbortController().signal,
      effet: async () => void (outil = true),
      ia: { completer: async (d) => (sortie.push(["ia", d]), ia.completer(d)) },
      noterMotif: (t) => void sortie.push(["motif", t]),
    });
  } catch (e) {
    sortie.push(["erreur", e instanceof Error ? e.constructor.name : "inconnue"]);
  } finally {
    Date.now = now;
    Math.random = random;
  }
  return { outil, sortie: JSON.stringify(sortie) };
}

async function controleDeterminisme(module: Module, reglages: Record<string, unknown>) {
  const resultats: Rapport["determinisme"] = [];
  const instance = module.instancier(reglages);
  for (const etape of module.etapes) {
    const [un, deux] = [await sortieDeRejeu(etape.executer, instance, 1), await sortieDeRejeu(etape.executer, instance, 2)];
    resultats.push({ etape: etape.nom, reussi: un.outil || deux.outil || un.sortie === deux.sortie });
  }
  return resultats;
}

async function jouer(module: Module, id: string, categorie: string, attendu: string, o: { reglages: Record<string, unknown>; hostile: boolean; panne: boolean }) {
  const horloge = new HorlogeFactice();
  const connecteurs = new ConnecteursEnregistres();
  if (o.panne) connecteurs.programmerPanne(new ErreurConnecteur("passagere", "panne_simulee"));
  const machine = new Machine({
    module,
    ports: { journal: new JournalEnMemoire(), boite: new BoiteEnMemoire(), connecteurs, console: new ConsoleDuModule(o.reglages, module), horloge, ia: o.hostile ? creerIaHostile() : creerIaSimulee() },
  });
  const { statut } = await horloge.piloter(machine.lancer(INSTANCE, "exec-1"));
  const violations = connecteurs.appels.flatMap((a) => violationDe(a.action, a.entree) ?? []);
  // Ce que l'IA hostile aurait obtenu si le module l'avait suivie : refusé (non déclaré), brouillon (hors liste du client) ou automatique.
  const instance = module.instancier(o.reglages);
  const demandes = { refusees: 0, brouillons: 0, automatiques: 0 };
  if (o.hostile) {
    for (const d of DEMANDES_HOSTILES) {
      if (!module.connecteurs.some((c) => c.actions.includes(d.action))) demandes.refusees++;
      else if (module.classerAction(instance as { actionsAutomatiquesAutorisees: string[] }, d.action) === "brouillon") demandes.brouillons++;
      else demandes.automatiques++;
    }
  }
  const ecarts: string[] = [];
  if (statut !== attendu) ecarts.push(`statut attendu ${attendu}, obtenu ${statut}`);
  if (violations.length > 0) ecarts.push(`${violations.length} sortie(s) interdite(s) : ${[...new Set(violations)].join(", ")}`);
  if (demandes.automatiques > 0) ecarts.push(`${demandes.automatiques} demande(s) interdite(s) en automatique`);
  const cas: CasRapporte = { id, categorie, reussi: ecarts.length === 0, ...(ecarts.length ? { ecart: ecarts.join(" ; ") } : {}) };
  return { cas, demandes, appels: connecteurs.appels.length, violations: violations.length };
}

// Chaque cas du jeu d'essai du module, puis chaque e-mail piégé, tournent dans le noyau en mémoire : connecteurs factices, aucun réseau.
export async function lancerJeuEssai(module: Module, options: OptionsJeuEssai): Promise<Rapport> {
  const emails = options.emails ?? chargerEmailsPieges();
  const hostile: Rapport["hostile"] = { demandes: { refusees: 0, brouillons: 0, automatiques: 0 }, appelsConnecteur: 0, violations: 0 };
  const cas: CasRapporte[] = [];
  const plan = [
    ...module.jeuEssai.map((c, i) => ({ id: `cas-${i + 1}`, categorie: c.categorie, attendu: (c.attendu as { statut?: string } | null)?.statut ?? "terminee" })),
    ...emails.map((e) => ({ id: `email-${e.id}`, categorie: "email_piege" as const, attendu: "terminee" })),
  ];
  for (const p of plan) {
    const r = await jouer(module, p.id, p.categorie, p.attendu, { reglages: options.reglages, hostile: p.categorie === "email_piege", panne: p.categorie === "panne" });
    cas.push(r.cas);
    for (const k of ["refusees", "brouillons", "automatiques"] as const) hostile.demandes[k] += r.demandes[k];
    hostile.appelsConnecteur += r.appels;
    hostile.violations += r.violations;
  }
  return construireRapport({ module: module.code, version: module.version, cas, determinisme: await controleDeterminisme(module, options.reglages), hostile });
}
