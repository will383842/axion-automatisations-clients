import { type Application, masquer } from "./nettoyage.ts";

// Envoi des journaux des applications vers le collecteur (VictoriaLogs), par POST JSON-lines (A-080, C-022, C-025).
// Le collecteur est alimenté PAR ENVOI : aucun montage de l'hôte, jamais de lecture du bac à sable de l'exécuteur.
// Reçoit des OBJETS, pas des lignes libres : liste fermée de champs (heure, niveau, application, code, message masqué, reqId, tenant).
// Jamais bloquant : écrire() rend la main tout de suite ; au plus `maxLignes` lignes en attente, le surplus est compté comme perdu.
// Aucune file sur disque, aucune relance : une ligne non reçue est perdue et comptée, jamais rejouée.
// Fermé par défaut : sans adresse de collecteur, rien n'est gardé ni envoyé.
// Limite connue (garde non exhaustive par nature) : les motifs de masquage ne couvrent pas toute forme de secret ;
// le vrai rempart est la liste fermée de champs, la borne de 500 caractères et le masqueur des secrets réellement lus.

export const BORNE_MESSAGE = 500;
export const DELAI_ENVOI_MS = 2000;
const NIVEAUX = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const IDENTIFIANT = /^[A-Za-z0-9-]{1,64}$/;

export type FetchJournal = (url: string, init: RequestInit) => Promise<{ status: number }>;

export interface OptionsEnvoiJournal {
  // Adresse de base du collecteur (réseau interne). Absente ou vide : envoi fermé.
  url?: string;
  application: Application;
  fetch?: FetchJournal;
  // Masque les valeurs de secrets réellement lues (OpenBao) ; appliqué après les motifs.
  masquerSecrets?: (texte: string) => string;
  maxLignes?: number;
  delaiMs?: number;
}

export interface EntreeJournal {
  heure?: unknown;
  niveau?: unknown;
  code?: unknown;
  message?: unknown;
  reqId?: unknown;
  tenant?: unknown;
}

export interface EnvoiJournal {
  ecrire(entree: EntreeJournal): void;
  vider(): Promise<void>;
  enAttente(): number;
  perdues(): number;
}

type Ligne = Record<string, string>;

function ligneFermee(entree: EntreeJournal, application: Application, masquerSecrets: (t: string) => string): Ligne {
  const heure = typeof entree.heure === "string" && !Number.isNaN(Date.parse(entree.heure)) ? new Date(entree.heure).toISOString() : new Date().toISOString();
  const niveau = typeof entree.niveau === "string" && NIVEAUX.has(entree.niveau) ? entree.niveau : "info";
  const brut = typeof entree.message === "string" ? entree.message : "";
  // Le masque passe sur le texte entier AVANT la coupure : une coupure ne peut pas laisser le début d'un secret.
  const message = masquerSecrets(masquer(brut)).slice(0, BORNE_MESSAGE);
  const ligne: Ligne = { heure, niveau, application, message };
  // Un code ou un identifiant de forme inattendue est écarté, jamais recopié ni masqué.
  if (typeof entree.code === "string" && CODE.test(entree.code) && masquerSecrets(entree.code) === entree.code) ligne.code = entree.code;
  if (typeof entree.reqId === "string" && IDENTIFIANT.test(entree.reqId)) ligne.reqId = entree.reqId;
  if (typeof entree.tenant === "string" && IDENTIFIANT.test(entree.tenant)) ligne.tenant = entree.tenant;
  return ligne;
}

export function creerEnvoiJournal(options: OptionsEnvoiJournal): EnvoiJournal {
  const { url, application } = options;
  const envoyer = options.fetch ?? (globalThis.fetch as FetchJournal);
  const masquerSecrets = options.masquerSecrets ?? ((t: string) => t);
  const maxLignes = options.maxLignes ?? 200;
  const delaiMs = options.delaiMs ?? DELAI_ENVOI_MS;
  const ouvert = typeof url === "string" && url !== "";
  let attente: Ligne[] = [];
  let perdues = 0;
  let enVol = 0; // lignes du lot en cours d'envoi : comptées dans la borne
  let enCours: Promise<void> | undefined;

  const adresse = ouvert ? `${url.replace(/\/+$/, "")}/insert/jsonline?_stream_fields=application&_msg_field=message&_time_field=heure` : "";

  async function envoyerLot(): Promise<void> {
    const lot = attente;
    attente = [];
    if (lot.length === 0) return;
    enVol = lot.length;
    try {
      const reponse = await envoyer(adresse, {
        method: "POST",
        headers: { "content-type": "application/stream+json" },
        body: lot.map((l) => JSON.stringify(l)).join("\n"),
        signal: AbortSignal.timeout(delaiMs),
      });
      if (reponse.status < 200 || reponse.status >= 300) perdues += lot.length;
    } catch {
      perdues += lot.length;
    } finally {
      enVol = 0;
    }
  }

  const lancer = () => {
    enCours ??= envoyerLot().finally(() => { enCours = undefined; });
    return enCours;
  };

  return {
    ecrire(entree) {
      if (!ouvert) return;
      if (attente.length + enVol >= maxLignes) {
        perdues += 1;
        return;
      }
      try {
        attente.push(ligneFermee(entree, application, masquerSecrets));
      } catch {
        perdues += 1;
        return;
      }
      void lancer();
    },
    async vider() {
      while (enCours || attente.length > 0) await lancer();
    },
    enAttente: () => attente.length + enVol,
    perdues: () => perdues,
  };
}
