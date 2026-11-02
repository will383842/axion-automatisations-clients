import { Queue, Worker } from "bullmq";
import pg from "pg";
import type { Redis } from "ioredis";
import { avecClient, avecEquipe } from "../db/client-actif.js";
import { PREFIXE } from "../files/files.js";
import type { Destination, EchecEnvoi, Magasin, Ref } from "./expediteur.js";

// Relais (A-088, C-402) : lit les lignes « a_envoyer » VALIDÉES (la transaction métier a fini), dépose une tâche par ligne, jobId = clé.
// Valkey n'est qu'un transport : s'il est vidé, le balayage suivant redépose tout depuis la base (rien perdu, rien doublé : même jobId).
export interface FileEnvoi {
  etat(jobId: string): Promise<string | undefined>;
  retirer(jobId: string): Promise<void>;
  ajouter(jobId: string, ref: Ref): Promise<void>;
}
export interface OptionsRelais {
  magasin: Magasin;
  files: Record<Destination, FileEnvoi>;
  // Interrupteur du canal (T2-12) : fermé, les lignes restent « a_envoyer ».
  ouverte: (d: Destination) => boolean;
  maintenant?: () => number;
  delaiAbandonMs?: number;
}
const DESTINATIONS: Destination[] = ["hub", "crm"];
const ABANDON_MS = 120_000;
const PAQUET = 200;

export function creerRelais(o: OptionsRelais) {
  const maintenant = o.maintenant ?? Date.now;
  let minuteur: ReturnType<typeof setInterval> | undefined;
  let enCours: Promise<unknown> = Promise.resolve();
  async function balayer() {
    const now = maintenant();
    // Après un arrêt brutal : les lignes « en_cours » depuis plus de 2 minutes repassent « a_envoyer », même clé.
    const reprises = await o.magasin.reprendre(new Date(now - (o.delaiAbandonMs ?? ABANDON_MS)));
    let ajoutees = 0;
    for (const destination of DESTINATIONS) {
      if (!o.ouverte(destination)) continue;
      const file = o.files[destination];
      for (const ligne of await o.magasin.dues(destination, new Date(now), PAQUET)) {
        const etat = await file.etat(ligne.cle);
        // Une tâche terminée ou en échec garde son jobId (7 jours) : elle est retirée pour qu'un renvoi ou un nouvel essai parte.
        if (etat === "completed" || etat === "failed") await file.retirer(ligne.cle);
        else if (etat !== undefined && etat !== "unknown") continue;
        await file.ajouter(ligne.cle, { tenantId: ligne.tenantId, id: ligne.id });
        ajoutees++;
      }
    }
    return { ajoutees, reprises };
  }
  const serie = () => (enCours = enCours.then(balayer, balayer)) as ReturnType<typeof balayer>;
  return {
    balayer: serie,
    demarrer(intervalleMs = 1000) {
      minuteur ??= setInterval(() => void serie().catch(() => undefined), intervalleMs);
    },
    arreter() {
      if (minuteur) clearInterval(minuteur);
      minuteur = undefined;
    },
  };
}

// Réveil par NOTIFY (envoyé au COMMIT par deposer) : connexion directe, jamais derrière PgBouncer (mode transaction).
export async function ecouter(urlDirecte: string, reveiller: () => void): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: urlDirecte });
  client.on("error", () => undefined);
  await client.connect();
  client.on("notification", reveiller);
  await client.query("LISTEN boite_envoi");
  return () => client.end();
}

export function fileEnMemoire(executer: (r: Ref) => Promise<void>) {
  const taches = new Map<string, { ref: Ref; etat: "waiting" | "completed" }>();
  return {
    async etat(id: string) { return taches.get(id)?.etat; },
    async retirer(id: string) { taches.delete(id); },
    async ajouter(id: string, ref: Ref) { if (!taches.has(id)) taches.set(id, { ref, etat: "waiting" }); },
    jobs: () => [...taches.keys()],
    perdre: () => taches.clear(),
    // Exécute les tâches en attente une par une, dans l'ordre d'arrivée (concurrence 1 par destination).
    async vider() {
      for (const t of [...taches.values()]) if (t.etat === "waiting") { await executer(t.ref); t.etat = "completed"; }
    },
  };
}

// BullMQ : une file par destination, concurrence 1 (ordre de création). removeOnComplete à un âge (7 jours), jamais à true.
const SEPT_JOURS = 7 * 86_400;
export function fileBullmq(file: Queue): FileEnvoi {
  return {
    async etat(id) { return (await file.getJob(id))?.getState(); },
    async retirer(id) { await file.remove(id); },
    async ajouter(id, ref) { await file.add("envoi", ref, { jobId: id, removeOnComplete: { age: SEPT_JOURS }, removeOnFail: { age: SEPT_JOURS } }); },
  };
}
export function creerFilesEnvoi(connexion: Redis, executer: (r: Ref) => Promise<unknown>) {
  const noms: Record<Destination, string> = { hub: "envoi-hub", crm: "envoi-crm" };
  const files = {} as Record<Destination, FileEnvoi>;
  const travailleurs: Worker[] = [];
  const queues: Queue[] = [];
  for (const d of DESTINATIONS) {
    const queue = new Queue(noms[d], { connection: connexion, prefix: PREFIXE });
    queues.push(queue);
    files[d] = fileBullmq(queue);
    travailleurs.push(new Worker(noms[d], async (job) => void (await executer(job.data as Ref)), { connection: connexion, prefix: PREFIXE, concurrency: 1 }));
  }
  return { files, fermer: async () => void (await Promise.all([...travailleurs.map((w) => w.close()), ...queues.map((q) => q.close())])) };
}

// Magasin PostgreSQL. `prochain_essai` sert aussi d'heure de prise tant que la ligne est « en_cours » (aucune colonne de plus : pas de migration).
// console_app est cloisonné par client (RLS) : on parcourt les clients à traiter, listés par console_equipe (lecture seule).
export function magasinPg(app: pg.Pool, equipe: pg.Pool): Magasin {
  const clients = async (etat: string) => (await avecEquipe(equipe, (c) => c.query("SELECT DISTINCT tenant_id FROM boite_envoi WHERE etat = $1::etat_envoi", [etat]))).rows.map((r) => r["tenant_id"] as string);
  const unique = async (r: Ref, sql: string, params: unknown[]) => (await avecClient(app, r.tenantId, (c) => c.query(sql, [r.tenantId, r.id, ...params]))).rows;
  return {
    async prendre(r, maintenant) {
      const l = (await unique(r, `UPDATE boite_envoi SET etat = 'en_cours', nombre_essais = nombre_essais + 1, prochain_essai = $3 WHERE tenant_id = $1 AND id = $2 AND (etat = 'a_envoyer' OR (etat = 'en_cours' AND prochain_essai < $3::timestamptz - interval '2 minutes'))
        RETURNING destination, route, methode, corps, cle_anti_doublon, nombre_essais, cree_le`, [maintenant]))[0];
      return l ? { ...r, destination: l["destination"], route: l["route"], methode: l["methode"], corps: l["corps"], cle: l["cle_anti_doublon"], etat: "en_cours", nombreEssais: l["nombre_essais"], creeLe: l["cree_le"] } : null;
    },
    async conclure(r, c) { await unique(r, "UPDATE boite_envoi SET etat = $3::etat_envoi, derniere_erreur = $4, reponse_recue = $5::jsonb, prochain_essai = NULL WHERE tenant_id = $1 AND id = $2 AND etat = 'en_cours'", [c.etat, c.erreur ?? null, c.reponse === undefined ? null : JSON.stringify(c.reponse)]); },
    async reporter(r, c) { await unique(r, "UPDATE boite_envoi SET etat = 'a_envoyer', prochain_essai = $3, derniere_erreur = $4, nombre_essais = nombre_essais - $5::int WHERE tenant_id = $1 AND id = $2 AND etat = 'en_cours'", [c.prochainEssai, c.erreur, c.compter ? 0 : 1]); },
    async dues(destination, maintenant, limite) {
      const lignes: { tenantId: string; id: string; cle: string; creeLe: Date }[] = [];
      for (const tenantId of await clients("a_envoyer")) {
        const rows = (await avecClient(app, tenantId, (c) => c.query("SELECT id, cle_anti_doublon, cree_le FROM boite_envoi WHERE destination = $1::destination_envoi AND etat = 'a_envoyer' AND (prochain_essai IS NULL OR prochain_essai <= $2) ORDER BY cree_le, id LIMIT $3", [destination, maintenant, limite]))).rows;
        for (const x of rows) lignes.push({ tenantId, id: x["id"], cle: x["cle_anti_doublon"], creeLe: x["cree_le"] });
      }
      return lignes.sort((a, b) => a.creeLe.getTime() - b.creeLe.getTime()).slice(0, limite).map(({ tenantId, id, cle }) => ({ tenantId, id, cle }));
    },
    async reprendre(avant) {
      let n = 0;
      for (const tenantId of await clients("en_cours")) n += (await avecClient(app, tenantId, (c) => c.query("UPDATE boite_envoi SET etat = 'a_envoyer' WHERE tenant_id = $1 AND etat = 'en_cours' AND prochain_essai < $2", [tenantId, avant]))).rowCount ?? 0;
      return n;
    },
    async echecs(): Promise<EchecEnvoi[]> {
      const rows = (await avecEquipe(equipe, (c) => c.query("SELECT tenant_id, id, destination, route, nombre_essais, derniere_erreur, cree_le FROM boite_envoi WHERE etat = 'echec' ORDER BY cree_le, id LIMIT 200"))).rows;
      return rows.map((x) => ({ tenantId: x["tenant_id"], id: x["id"], destination: x["destination"], route: x["route"], nombreEssais: x["nombre_essais"], derniereErreur: x["derniere_erreur"], creeLe: x["cree_le"] }));
    },
    async renvoyer(r) { return (await unique(r, "UPDATE boite_envoi SET etat = 'a_envoyer', nombre_essais = 0, prochain_essai = NULL WHERE tenant_id = $1 AND id = $2 AND etat = 'echec' RETURNING id", [])).length > 0; },
  };
}
