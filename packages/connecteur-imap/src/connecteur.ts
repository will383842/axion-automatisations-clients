import {
  activer, avecJeton, declarer, ErreurConnecteur, verifierMessageId,
  type Champ, type ConnecteurMessagerie, type JetonCourt, type MessageLu, type MessageSortant, type Page,
} from "@axion-auto/connecteurs-commun";
import type { Garantie } from "@axion-auto/sdk-module";
import { trouverDossiers, type DossiersSpeciaux } from "./dossiers.ts";
import { classerServeur } from "./erreurs.ts";
import { ouvrirSessionImap, type SessionImap } from "./imap.ts";
import { composerMessage, envoyerSmtp } from "./smtp.ts";
import { optionsImap, optionsSmtp, verifierConfiguration, type ConfigurationImap, type OptionsImap, type OptionsSmtp, type ReglageTls } from "./verification.ts";

export interface Dependances {
  ouvrirImap?: (options: OptionsImap) => Promise<SessionImap>;
  envoyerSmtp?: (options: OptionsSmtp, message: MessageSortant, expediteur: string) => Promise<Buffer>;
  alerter?: (code: string) => void;
  maintenant?: () => number;
  // Attente d'un quota sans date : la valeur par défaut de la politique, injectée par l'appelant.
  attenteQuotaMs?: number;
  taillePage?: number;
  // Réglage de certificat réservé aux essais (voir reglerTls).
  tls?: ReglageTls;
}
export type ConnecteurImap = ConnecteurMessagerie & { verifierApresCoup(jeton: JetonCourt, messageId: string): Promise<boolean> };

const ID = /^m-(\d+)$/;
const MOT_CLE = /^[A-Za-z0-9$._-]{1,50}$/;
const ADRESSE = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
const CURSEUR = /^(\d+):(\d+)$/;
const definitive = (code: string) => new ErreurConnecteur("definitive", code);
const uidDe = (id: string): number => {
  const m = ID.exec(id);
  if (!m) throw definitive("message_inconnu");
  return Number(m[1]);
};

export async function ouvrirConnecteur(configBrute: ConfigurationImap, jeton: JetonCourt, deps: Dependances = {}): Promise<ConnecteurImap> {
  const config = verifierConfiguration(configBrute);
  const ouvrir = deps.ouvrirImap ?? ouvrirSessionImap;
  const envoyer = deps.envoyerSmtp ?? envoyerSmtp;
  const alerter = deps.alerter ?? (() => undefined);
  const maintenant = deps.maintenant ?? Date.now;
  const taille = deps.taillePage ?? 50;
  const ctx = () => ({ maintenant: maintenant(), attenteQuotaMs: deps.attenteQuotaMs ?? 3_600_000 });

  // Le mot de passe est le jeton court : un jeton expiré est refusé avant toute connexion. La connexion est fermée à la fin, toujours.
  const session = async <T>(j: JetonCourt, f: (s: SessionImap) => Promise<T>): Promise<T> => {
    const motDePasse = avecJeton(j, maintenant(), (v) => v);
    let s: SessionImap | undefined;
    try {
      s = await ouvrir(optionsImap(config, motDePasse, deps.tls));
      return await f(s);
    } catch (e) {
      throw classerServeur(e, ctx());
    } finally {
      await s?.fermer().catch(() => undefined);
    }
  };

  const dossiers: DossiersSpeciaux = await session(jeton, async (s) => trouverDossiers(await s.dossiers()));
  if (!dossiers.envoyes) alerter("dossier_envoyes_introuvable");

  const garantie = (action: string): Garantie =>
    action === "envoyer" ? (dossiers.envoyes ? "verifiable_apres_coup" : "au_plus_une_fois") : action === "creer_brouillon" ? "au_plus_une_fois" : "idempotent_par_cle";
  const declaration = declarer({
    famille: "messagerie", outil: "imap-smtp", version: "0.1.0", portees: ["messagerie.lecture", "messagerie.envoi"],
    capacites: ["lister_nouveaux", "lire", "etiqueter", "creer_brouillon", "envoyer"].map((action) => ({ action, garantie: garantie(action) })),
  });
  const identifiant = (m: MessageSortant) => {
    try {
      verifierMessageId(m.messageId);
    } catch {
      throw definitive("message_id_invalide");
    }
  };
  // Une seule adresse : l'en-tête To et l'enveloppe doivent dire la même chose.
  const valider = (m: MessageSortant) => {
    identifiant(m);
    if (!ADRESSE.test(m.destinataire)) throw definitive("destinataire_invalide");
  };
  const chercher = (j: JetonCourt, dossier: string, messageId: string) =>
    session(j, async (s) => (await s.selectionner(dossier), (await s.chercherMessageId(messageId)).length > 0));

  return {
    declaration,
    listerNouveaux: (j, curseur): Promise<Page> =>
      session(j, async (s) => {
        const { uidValidity } = await s.selectionner("INBOX");
        let dernier = 0;
        if (curseur !== null) {
          const c = CURSEUR.exec(curseur);
          if (!c) throw definitive("curseur_invalide");
          if (c[1] !== uidValidity) throw definitive("uidvalidity_change");
          dernier = Number(c[2]);
        }
        const trouves = await s.uidsApres(dernier, taille + 1);
        const page = trouves.slice(0, taille);
        const dernierVu = page.at(-1);
        return { ids: page.map((u) => `m-${u}`), suivant: trouves.length > taille && dernierVu ? `${uidValidity}:${dernierVu}` : null };
      }),
    lire: (j, id, champs: Champ[]): Promise<MessageLu> =>
      session(j, async (s) => {
        const uid = uidDe(id);
        await s.selectionner("INBOX");
        const m = await s.lire(uid);
        if (!m) throw definitive("message_inconnu");
        const sortie: MessageLu = { id };
        for (const c of champs) {
          const v = c === "etiquettes" ? m.etiquettes : m[c];
          if (v === undefined) throw definitive("champ_absent");
          sortie[c] = v;
        }
        return sortie;
      }),
    etiqueter: async (j, id, etiquettes) => {
      if (!etiquettes.every((e) => MOT_CLE.test(e))) throw definitive("etiquette_invalide");
      const uid = uidDe(id);
      if (etiquettes.length === 0) return;
      await session(j, async (s) => {
        await s.selectionner("INBOX");
        await s.ajouterMotsCles(uid, etiquettes);
      });
    },
    creerBrouillon: async (j, m) => {
      valider(m);
      const dossier = dossiers.brouillons;
      if (!dossier) throw definitive("dossier_brouillons_introuvable");
      const source = await composerMessage(m, config.expediteur);
      await session(j, (s) => s.ajouter(dossier, source, ["\\Draft", "\\Seen"]));
      return { id: m.messageId };
    },
    envoyer: async (j, m) => {
      valider(m);
      const motDePasse = avecJeton(j, maintenant(), (v) => v);
      let source: Buffer;
      try {
        source = await envoyer(optionsSmtp(config, motDePasse, deps.tls), m, config.expediteur);
      } catch (e) {
        throw classerServeur(e, ctx());
      }
      // Le message est parti : rien ne doit plus faire échouer l'appel (le moteur le renverrait). Certains serveurs copient déjà dans « Envoyés ».
      const envoyes = dossiers.envoyes;
      if (envoyes) {
        try {
          await session(j, async (s) => {
            await s.selectionner(envoyes);
            if ((await s.chercherMessageId(m.messageId)).length === 0) await s.ajouter(envoyes, source, ["\\Seen"]);
          });
        } catch {
          alerter("copie_envoyes_echouee");
        }
      }
      return { id: m.messageId };
    },
    verifierApresCoup: async (j, messageId) => {
      identifiant({ messageId } as MessageSortant);
      if (!dossiers.envoyes) throw definitive("dossier_envoyes_introuvable");
      return chercher(j, dossiers.envoyes, messageId);
    },
  };
}

// Fermé par défaut : seule CONNECTEURS_MESSAGERIE_OUVERT=1 l'ouvre.
export async function ouvrirSiOuvert(env: Record<string, string | undefined>, config: ConfigurationImap, jeton: JetonCourt, deps: Dependances = {}): Promise<ConnecteurImap> {
  const c = await ouvrirConnecteur(config, jeton, deps);
  activer(c.declaration, env);
  return c;
}
