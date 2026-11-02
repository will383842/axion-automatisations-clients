// Migrations des bases des clients par vagues (T2-38) : recette, bases internes AXION, canari 5 %, puis lots de 50.
// Ce module décide de l'ORDRE et de l'ARRÊT ; il n'ouvre aucune connexion lui-même : `migrer` (adaptateur de migrerBase, T2-32), le registre et les alertes sont des ports.
// Une base en échec reste sur l'ancienne version (quarantaine) et alerte ; la vague continue ; au-delà du seuil d'échecs, les vagues suivantes ne partent pas.
export interface BaseRegistre {
  id: string;
  // Identifiant console du client : c'est lui, jamais un nom, que porte l'alerte.
  tenantId: string;
  nomBase: string;
  versionStructure: number;
  etat: string;
}
export type NomVague = "recette" | "internes" | "canari" | "lot";
export interface Vague { numero: number; nom: NomVague; versionCible: number; bases: BaseRegistre[] }
export interface Plan { versionCible: number; graine: number; vagues: Vague[] }
export interface ConfigVagues {
  // Listes de configuration (fictives en test) : noms de bases de la recette et des bases internes AXION.
  recette: readonly string[];
  internes: readonly string[];
  partCanari?: number;
  tailleLot?: number;
}
export interface OptionsDeroulement { seuilEchec?: number; parallele?: number }
export interface PortsVagues {
  // Lit bases_client (T2-30) : seule source des noms de bases migrés.
  bases(): Promise<BaseRegistre[]>;
  // Graine du tirage du canari, écrite au journal : une vague se rejoue à l'identique.
  graine(versionCible: number): Promise<number | undefined>;
  enregistrerGraine(versionCible: number, graine: number): Promise<void>;
  tirerGraine(): number;
  // Adaptateur de migrerBase ; la base est celle du registre.
  migrer(nomBase: string, versionCible: number): Promise<void>;
  // Écrit versions_structure (version VISÉE et résultat : ok, echec, quarantaine) et, si ok seulement, la version de bases_client. Ne reçoit aucun message d'erreur.
  noter(baseId: string, version: number, resultat: "ok" | "echec" | "quarantaine", vague: number): Promise<void>;
  alerter(alerte: { type: "migration_echec"; clientId: string }): Promise<void>;
}
export interface ResultatVague { numero: number; reussies: string[]; echecs: string[]; arretee: boolean }

export const PART_CANARI = 0.05;
export const TAILLE_LOT = 50;
export const SEUIL_ECHEC = 0.02;
export const PARALLELE = 5;

// Générateur déterministe (mulberry32) : même graine, même mélange.
function hasard(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const parNom = (a: BaseRegistre, b: BaseRegistre) => (a.nomBase < b.nomBase ? -1 : a.nomBase > b.nomBase ? 1 : 0);

export async function planifierVagues(versionCible: number, config: ConfigVagues, ports: PortsVagues, options: { graine?: number } = {}): Promise<Plan> {
  if (!Number.isInteger(versionCible) || versionCible < 1) throw new Error("planifierVagues : version cible invalide");
  // Une graine déjà au journal fait foi : en demander une autre pour changer le canari est refusé.
  const connue = await ports.graine(versionCible);
  if (connue !== undefined && options.graine !== undefined && options.graine !== connue) throw new Error("planifierVagues : la graine de cette version est déjà au journal, une autre est refusée");
  const graine = connue ?? options.graine ?? ports.tirerGraine();
  if (connue === undefined) await ports.enregistrerGraine(versionCible, graine);

  // Le plan se calcule sur TOUTES les bases actives, puis ne garde que celles encore en retard : la reprise après correction retrouve les mêmes vagues.
  const actives = (await ports.bases()).filter((b) => b.etat === "active").sort(parNom);
  const recette = actives.filter((b) => config.recette.includes(b.nomBase));
  const internes = actives.filter((b) => config.internes.includes(b.nomBase) && !config.recette.includes(b.nomBase));
  const reste = actives.filter((b) => !config.recette.includes(b.nomBase) && !config.internes.includes(b.nomBase));
  const alea = hasard(graine);
  const melange = [...reste];
  for (let i = melange.length - 1; i > 0; i--) {
    const j = Math.floor(alea() * (i + 1));
    [melange[i], melange[j]] = [melange[j]!, melange[i]!];
  }
  const nCanari = reste.length ? Math.min(reste.length, Math.max(1, Math.ceil(reste.length * (config.partCanari ?? PART_CANARI)))) : 0;
  const canari = melange.slice(0, nCanari);
  const dansCanari = new Set(canari.map((b) => b.nomBase));
  const suite = reste.filter((b) => !dansCanari.has(b.nomBase));
  const taille = config.tailleLot ?? TAILLE_LOT;
  const groupes: [NomVague, BaseRegistre[]][] = [["recette", recette], ["internes", internes], ["canari", canari]];
  for (let i = 0; i < suite.length; i += taille) groupes.push(["lot", suite.slice(i, i + taille)]);

  const vagues: Vague[] = [];
  for (const [nom, bases] of groupes) {
    const enRetard = bases.filter((b) => b.versionStructure < versionCible);
    if (enRetard.length) vagues.push({ numero: vagues.length + 1, nom, versionCible, bases: enRetard });
  }
  return { versionCible, graine, vagues };
}

export async function deroulerVague(vague: Vague, ports: PortsVagues, options: OptionsDeroulement = {}): Promise<ResultatVague> {
  // Les noms viennent du registre, jamais de la vague reçue : une base absente du registre, ou dont l'identifiant ne correspond pas, arrête tout avant la première migration.
  const registre = new Map((await ports.bases()).filter((b) => b.etat === "active").map((b) => [b.nomBase, b]));
  const cibles = vague.bases.map((b) => {
    const r = registre.get(b.nomBase);
    if (!r || r.id !== b.id || r.tenantId !== b.tenantId) throw new Error("deroulerVague : base absente du registre, vague refusée");
    return r;
  });
  const reussies: string[] = [];
  const echecs: string[] = [];
  let suivante = 0;
  const travailleur = async () => {
    for (let i = suivante++; i < cibles.length; i = suivante++) {
      const b = cibles[i]!;
      try {
        await ports.migrer(b.nomBase, vague.versionCible);
        await ports.noter(b.id, vague.versionCible, "ok", vague.numero);
        reussies.push(b.nomBase);
      } catch {
        // La base reste en N-1 : quarantaine et alerte. Aucun détail de l'erreur ne sort (il peut citer une adresse).
        echecs.push(b.nomBase);
        await ports.noter(b.id, vague.versionCible, "quarantaine", vague.numero).catch(() => undefined);
        await ports.alerter({ type: "migration_echec", clientId: b.tenantId }).catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallele ?? PARALLELE, cibles.length) }, travailleur));
  const seuil = options.seuilEchec ?? SEUIL_ECHEC;
  return { numero: vague.numero, reussies: reussies.sort(), echecs: echecs.sort(), arretee: cibles.length > 0 && echecs.length / cibles.length > seuil };
}

// Déroule les vagues dans l'ordre ; une vague arrêtée (trop d'échecs) n'en lance aucune autre. Reprise : replanifier avec la même graine après correction.
export async function deroulerPlan(plan: Plan, ports: PortsVagues, options: OptionsDeroulement = {}): Promise<{ vagues: ResultatVague[]; arretee: boolean }> {
  const vagues: ResultatVague[] = [];
  for (const vague of plan.vagues) {
    const r = await deroulerVague(vague, ports, options);
    vagues.push(r);
    if (r.arretee) return { vagues, arretee: true };
  }
  return { vagues, arretee: false };
}
