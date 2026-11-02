import { createHash, randomBytes } from "node:crypto";

// Jetons courts du courtier (T4-39) : opaques, liés à (client, exécution, portées), à durée bornée, révocables.
// Le registre est en mémoire et ne garde que l'EMPREINTE du jeton : jamais le jeton, jamais une valeur du coffre, rien sur disque.
export const DUREE_MAX_MS = 2 * 3600_000;

export interface PorteeJeton { tenantId: string; executionId: string; portees: readonly string[] }
interface Entree { portee: PorteeJeton; expireA: number }
export interface OptionsRegistre { maintenant?: () => number; aleatoire?: (n: number) => Buffer }

const empreinte = (jeton: string) => createHash("sha256").update(jeton).digest("hex");

export function creerRegistreJetons(o: OptionsRegistre = {}) {
  const maintenant = o.maintenant ?? Date.now;
  const aleatoire = o.aleatoire ?? randomBytes;
  const jetons = new Map<string, Entree>();
  const remises = new Map<string, number>(); // (exécution, connexion) -> fin de la réservation
  const purger = () => {
    const t = maintenant();
    for (const [k, e] of jetons) if (t >= e.expireA) jetons.delete(k);
    for (const [k, fin] of remises) if (t >= fin) remises.delete(k);
  };
  return {
    emettre(portee: PorteeJeton, dureeMs: number): { jeton: string; expire: Date } {
      if (!Number.isFinite(dureeMs) || dureeMs <= 0 || dureeMs > DUREE_MAX_MS) throw new Error("durée de jeton invalide");
      purger();
      const jeton = `cj1_${aleatoire(32).toString("base64url")}`;
      const expireA = maintenant() + dureeMs;
      jetons.set(empreinte(jeton), { portee: { tenantId: portee.tenantId, executionId: portee.executionId, portees: [...portee.portees] }, expireA });
      return { jeton, expire: new Date(expireA) };
    },
    lire(jeton: string): PorteeJeton | null {
      if (typeof jeton !== "string" || jeton.length > 128) return null;
      const e = jetons.get(empreinte(jeton));
      if (!e || maintenant() >= e.expireA) return null;
      return { tenantId: e.portee.tenantId, executionId: e.portee.executionId, portees: [...e.portee.portees] };
    },
    revoquer(jeton: string): void {
      jetons.delete(empreinte(jeton));
    },
    revoquerExecution(executionId: string): number {
      let n = 0;
      for (const [k, e] of jetons) if (e.portee.executionId === executionId) { jetons.delete(k); n++; }
      return n;
    },
    // Anti-rejeu : une remise par (exécution, connexion), même après la fin de l'exécution, jusqu'à l'échéance de la réservation.
    reserver(executionId: string, connexionId: string, dureeMs: number): boolean {
      purger();
      const cle = `${executionId}|${connexionId}`;
      if (remises.has(cle)) return false;
      remises.set(cle, maintenant() + dureeMs);
      return true;
    },
    // Une remise qui a échoué avant toute sortie de valeur peut être redemandée.
    liberer(executionId: string, connexionId: string): void {
      remises.delete(`${executionId}|${connexionId}`);
    },
    empreintesPourEssai: () => jetons.keys(),
    toString: () => "[RegistreJetons]",
  };
}
export type RegistreJetons = ReturnType<typeof creerRegistreJetons>;
