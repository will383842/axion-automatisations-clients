import type { defineAutomation } from "@axion-auto/sdk-module";
import { lierEtapes, type EtapeExecutable } from "./etape.ts";
import { ATrancher, effet, IntentionEnCours } from "./intention.ts";
import { classer, decider, ErreurConnecteur } from "./politique-erreurs.ts";
import { CoupureProcessus, type Ports } from "./ports.ts";

type Module = ReturnType<typeof defineAutomation>;
const DELAI_MAX_SECONDES = 3600;
export type Statut = "terminee" | "a_trancher" | "echec" | "pause" | "ignoree" | "en_cours";

// Machine rejouable : une étape inscrite « faite » est sautée ; tout effet passe par une intention écrite avant.
export class Machine {
  constructor(private o: { module: Module; etapes: Record<string, EtapeExecutable>; ports: Ports }) {
    lierEtapes(o.module, o.etapes);
  }

  async lancer(instanceId: string, executionId: string): Promise<{ statut: Statut; etape?: string }> {
    const { module, ports } = this.o;
    const { console, journal, horloge } = ports;
    const voulu = await console.lireEtatVoulu(instanceId);
    if (voulu.instanceId !== instanceId) return this.incoherente(instanceId, executionId);
    if (voulu.etat !== "actif") return { statut: "ignoree" };
    const config = await console.lireConfiguration(instanceId);
    if (config.instanceId !== instanceId || config.moduleCode !== module.code) return this.incoherente(instanceId, executionId);
    const reglages = module.instancier(config.reglages);
    const deja = await journal.lire(instanceId, executionId);
    const perdue = deja.find((e) => e.statut === "echec");
    if (perdue) return { statut: "echec", etape: perdue.etape }; // échec final déjà dit à la console : ni rejeu ni nouvel événement
    const debut = horloge.maintenant();
    await console.envoyer({ type: "debut", instanceId, executionId, a: new Date(debut).toISOString() });
    let elements = 0;
    for (const decl of module.etapes) {
      const trace = deja.filter((e) => e.etape === decl.nom);
      if (trace.some((e) => e.statut === "faite")) continue;
      if (trace.some((e) => e.statut === "a_trancher")) return { statut: "a_trancher", etape: decl.nom };
      const encore = await console.lireEtatVoulu(instanceId);
      if (encore.instanceId !== instanceId) return this.incoherente(instanceId, executionId);
      if (encore.etat !== "actif") return { statut: "ignoree", etape: decl.nom };
      const base = { instanceId, executionId, etape: decl.nom, connecteurs: module.connecteurs };
      for (let essai = 1; ; essai++) {
        const issue = await this.tenter(decl.nom, decl.delaiMaxSecondes ?? 120, { ...base, reglages }, () => elements++);
        const inscrire = (statut: "faite" | "echec" | "a_trancher") =>
          journal.inscrire({ instanceId, executionId, etape: decl.nom, statut, essai, a: new Date(horloge.maintenant()).toISOString() });
        if (issue === undefined) {
          await inscrire("faite");
          break;
        }
        if (issue instanceof IntentionEnCours) return { statut: "en_cours", etape: decl.nom }; // un autre lancement tient l'appel : ni journal, ni événement
        if (issue instanceof ATrancher) {
          await inscrire("a_trancher");
          return { statut: "a_trancher", etape: decl.nom };
        }
        const d = decider(issue, essai, horloge);
        if (d.action === "reessayer") {
          await horloge.attendre(d.attenteMs);
          continue;
        }
        const e = classer(issue);
        const classe = d.action === "echec" ? d.classe : "identification";
        await console.envoyer({ type: "erreur", instanceId, executionId, classe, code: d.action === "echec" ? d.code : e.code });
        if (d.action !== "pause") await inscrire("echec");
        if (d.action === "pause") await console.mettreEnPause(instanceId);
        return { statut: d.action === "pause" ? "pause" : "echec", etape: decl.nom };
      }
    }
    const dureeMs = Math.max(0, horloge.maintenant() - debut);
    await console.envoyer({ type: "fin", instanceId, executionId, dureeMs, elements, minutesGagnees: elements * module.minutesGagneesParElement, jetons: 0, coutIaMicroCentimes: 0 });
    return { statut: "terminee" };
  }

  private async incoherente(instanceId: string, executionId: string): Promise<{ statut: Statut }> {
    await this.o.ports.console.envoyer({ type: "erreur", instanceId, executionId, classe: "definitive", code: "configuration_incoherente" });
    return { statut: "echec" };
  }

  // Rend undefined si l'étape a réussi, sinon l'erreur ; seule une coupure de processus traverse.
  private async tenter(nom: string, delaiSecondes: number, base: Parameters<Machine["contexte"]>[0], compter: () => void): Promise<unknown> {
    const ac = new AbortController();
    const { horloge } = this.o.ports;
    const delaiMs = Math.min(delaiSecondes, DELAI_MAX_SECONDES) * 1000;
    const finEtape = horloge.maintenant() + delaiMs;
    try {
      const travail = this.o.etapes[nom]!.executer(this.contexte(base, nom, ac.signal, finEtape, compter));
      travail.catch(() => undefined);
      const delai = horloge.attendre(delaiMs, ac.signal).then(() => {
        throw new ErreurConnecteur("passagere", "delai_depasse");
      });
      await Promise.race([travail, delai]);
      return undefined;
    } catch (e) {
      if (e instanceof CoupureProcessus) throw e;
      return e;
    } finally {
      ac.abort();
    }
  }

  private contexte(
    base: { instanceId: string; executionId: string; etape: string; connecteurs: Module["connecteurs"]; reglages: Readonly<Record<string, unknown>> },
    nom: string,
    signal: AbortSignal,
    finEtape: number,
    compter: () => void,
  ) {
    const effetBase = { ...base, signal, finEtape, classer: (a: string) => this.o.module.classerAction(base.reglages as { actionsAutomatiquesAutorisees: string[] }, a) };
    return {
      instanceId: base.instanceId,
      executionId: base.executionId,
      etape: nom,
      reglages: base.reglages,
      signal,
      effet: async (action: string, element: string, entree?: unknown) => {
        if (await effet(this.o.ports, effetBase, action, element, entree)) compter();
      },
    };
  }
}
