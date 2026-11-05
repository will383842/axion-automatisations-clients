import { createHash, randomBytes } from "node:crypto";

// Jetons courts du courtier (T4-39) : opaques, liés à (client, exécution, portées), à durée bornée, révocables.
// Le registre est en mémoire et ne garde que l'EMPREINTE du jeton : jamais le jeton, jamais une valeur du coffre, rien sur disque.
export const DUREE_MAX_MS = 2 * 3600_000;

export interface PorteeJeton { tenantId: string; instanceId: string; connexionId: string; executionId: string; portees: readonly string[] }
export type Attendu = Pick<PorteeJeton, "tenantId" | "instanceId" | "connexionId" | "executionId">;

// Registre DURABLE de l'anti-rejeu (port) : une remise par (exécution, connexion), pour toujours (ni échéance, ni redémarrage).
// En production : table du courtier ou OpenBao, câblée à l'étape 2 (dette T4-39-dette-branchements). La version mémoire sert aux essais.
export interface StockageRemises {
  reserver(executionId: string, connexionId: string): Promise<boolean>;
  liberer(executionId: string, connexionId: string): Promise<void>;
}
export function creerStockageRemisesMemoire(): StockageRemises {
  const vues = new Set<string>();
  return {
    reserver: async (e, c) => (vues.has(`${e}|${c}`) ? false : (vues.add(`${e}|${c}`), true)),
    liberer: async (e, c) => { vues.delete(`${e}|${c}`); },
  };
}
interface Entree { portee: PorteeJeton; expireA: number }
export interface OptionsRegistre { maintenant?: () => number; aleatoire?: (n: number) => Buffer; remises?: StockageRemises }

const copie = (p: PorteeJeton): PorteeJeton => ({ tenantId: p.tenantId, instanceId: p.instanceId, connexionId: p.connexionId, executionId: p.executionId, portees: [...p.portees] });
const empreinte = (jeton: string) => createHash("sha256").update(jeton).digest("hex");

export function creerRegistreJetons(o: OptionsRegistre = {}) {
  const maintenant = o.maintenant ?? Date.now;
  const aleatoire = o.aleatoire ?? randomBytes;
  const jetons = new Map<string, Entree>();
  const remises = o.remises ?? creerStockageRemisesMemoire();
  const purger = () => {
    const t = maintenant();
    for (const [k, e] of jetons) if (t >= e.expireA) jetons.delete(k);
  };
  return {
    emettre(portee: PorteeJeton, dureeMs: number): { jeton: string; expire: Date } {
      if (!Number.isFinite(dureeMs) || dureeMs <= 0 || dureeMs > DUREE_MAX_MS) throw new Error("durée de jeton invalide");
      purger();
      const jeton = `cj1_${aleatoire(32).toString("base64url")}`;
      const expireA = maintenant() + dureeMs;
      jetons.set(empreinte(jeton), { portee: copie(portee), expireA });
      return { jeton, expire: new Date(expireA) };
    },
    lire(jeton: string): PorteeJeton | null {
      if (typeof jeton !== "string" || jeton.length > 128) return null;
      const e = jetons.get(empreinte(jeton));
      if (!e || maintenant() >= e.expireA) return null;
      return copie(e.portee);
    },
    // Le jeton ne vaut que pour exactement ce client, cette instance, cette connexion et cette exécution.
    verifier(jeton: string, a: Attendu): PorteeJeton | null {
      const p = this.lire(jeton);
      return p && p.tenantId === a.tenantId && p.instanceId === a.instanceId && p.connexionId === a.connexionId && p.executionId === a.executionId ? p : null;
    },
    revoquer(jeton: string): void {
      jetons.delete(empreinte(jeton));
    },
    revoquerExecution(executionId: string): number {
      let n = 0;
      for (const [k, e] of jetons) if (e.portee.executionId === executionId) { jetons.delete(k); n++; }
      return n;
    },
    // Anti-rejeu durable : une remise par (exécution, connexion), même après la fin de l'exécution ou un redémarrage.
    reserver: (executionId: string, connexionId: string): Promise<boolean> => remises.reserver(executionId, connexionId),
    // Une remise qui a échoué avant toute sortie de valeur peut être redemandée.
    liberer: (executionId: string, connexionId: string): Promise<void> => remises.liberer(executionId, connexionId),
    empreintesPourEssai: () => jetons.keys(),
    toString: () => "[RegistreJetons]",
  };
}
export type RegistreJetons = ReturnType<typeof creerRegistreJetons>;
