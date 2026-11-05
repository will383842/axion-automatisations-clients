// Exercice mensuel de restauration (A-241, T2-40) : tire 3 bases au hasard (graine notée), prépare leur restauration dans des bases TEMPORAIRES,
// compare des sommes de contrôle, note la date, puis retire les bases temporaires (des copies). Aucune bascule : ce module n'a pas ce port.

export interface BaseTiree {
  tenantId: string;
  nomBase: string;
}
export interface PortsExercice {
  bases(): Promise<BaseTiree[]>;
  tirerGraine(): number;
  noterGraine(graine: number): Promise<void>;
  /** Restaure la dernière sauvegarde du client dans une nouvelle base temporaire et rend son nom. */
  preparer(tenantId: string): Promise<string>;
  sommeDeControle(nomBase: string): Promise<string>;
  /** bases_client.dernier_test_restauration */
  noter(tenantId: string, le: Date, ok: boolean): Promise<void>;
  retirer(nomBase: string): Promise<void>;
}
export interface ResultatBase {
  tenantId: string;
  nomBase: string;
  ok: boolean;
}

const TIRAGE = 3;
const TEMPORAIRE = /^cli_[0-9a-f]{12}_restau_\d+$/;

// Générateur à graine (mulberry32) : même graine, même tirage.
function aleatoire(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function lancerExercice(p: PortsExercice, le: Date): Promise<{ graine: number; resultats: ResultatBase[] }> {
  const graine = p.tirerGraine();
  await p.noterGraine(graine);
  const toutes = [...(await p.bases())].sort((a, b) => a.nomBase.localeCompare(b.nomBase));
  const rand = aleatoire(graine);
  const tirees: BaseTiree[] = [];
  while (tirees.length < TIRAGE && toutes.length) tirees.push(toutes.splice(Math.floor(rand() * toutes.length), 1)[0]!);
  const resultats: ResultatBase[] = [];
  const creees: string[] = [];
  try {
    for (const b of tirees) {
      const temporaire = await p.preparer(b.tenantId);
      // Seule une base créée par l'exercice, au nom temporaire, sera retirée : sinon on s'arrête sans rien retirer d'autre.
      if (!TEMPORAIRE.test(temporaire) || temporaire === b.nomBase) throw new Error("base_non_temporaire");
      creees.push(temporaire);
      const ok = (await p.sommeDeControle(temporaire)) === (await p.sommeDeControle(b.nomBase));
      await p.noter(b.tenantId, le, ok);
      resultats.push({ tenantId: b.tenantId, nomBase: temporaire, ok });
    }
  } finally {
    for (const t of creees) await p.retirer(t);
  }
  return { graine, resultats };
}
