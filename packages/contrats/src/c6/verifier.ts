import { timingSafeEqual } from "node:crypto";
import { DUREE_SECONDES, VERSION_JETON, cleValide, signerCharge } from "./jeton.ts";

// RÈGLE (C-541, C-573) : le jeton n'est PAS un facteur d'authentification.
// verifierJeton ne renvoie que l'e-mail, à utiliser comme login_hint ; il n'ouvre jamais de session.
// La console demande toujours sa propre connexion avec double facteur (clé d'accès d'abord).
// Le lien porte le jeton dans le fragment (#j=), jamais dans la requête.
// Le refus ne dit pas pourquoi : la page de connexion normale s'affiche, sans message qui aide un attaquant.

export type Cle = { kid: string; secret: string };
export type ResultatJeton = { ok: true; email: string } | { ok: false };

export const AVANCE_MAX_SECONDES = 5;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const refus = { ok: false } as const;

// `cles` : les clés actives (2 pendant une rotation). `maintenant` : secondes Unix.
// `dejaVu(jti)` : vrai si le jti est déjà consommé ; sinon il le consomme (gardé 2 min par l'appelant).
// Il n'est appelé qu'une fois tout le reste vérifié : un jeton falsifié ne consomme aucun jti.
export function verifierJeton(cles: readonly Cle[], jeton: string, maintenant: number, dejaVu: (jti: string) => boolean): ResultatJeton {
  if (!Number.isSafeInteger(maintenant)) return refus;
  const morceaux = jeton.split(".");
  const [charge, signature] = morceaux;
  if (morceaux.length !== 2 || !charge || !signature || !BASE64URL.test(charge) || !BASE64URL.test(signature)) return refus;

  let contenu: unknown;
  try {
    contenu = JSON.parse(Buffer.from(charge, "base64url").toString("utf8"));
  } catch {
    return refus;
  }
  if (typeof contenu !== "object" || contenu === null || Array.isArray(contenu)) return refus;
  const c = contenu as Record<string, unknown>;

  // La clé est choisie par kid, puis la signature canonique recalculée est comparée en temps constant,
  // sur les chaînes : une variante qui décode aux mêmes octets (bits de bourrage) est refusée.
  const cle = typeof c.kid === "string" ? cles.find((k) => k.kid === c.kid) : undefined;
  if (!cle || !cleValide(cle.secret)) return refus;
  const attendu = Buffer.from(signerCharge(cle.secret, charge));
  const recu = Buffer.from(signature);
  if (recu.length !== attendu.length || !timingSafeEqual(recu, attendu)) return refus;

  const { v, jti, email, iat, exp } = c;
  if (v !== VERSION_JETON) return refus;
  if (typeof jti !== "string" || !UUID.test(jti)) return refus;
  if (typeof email !== "string" || !EMAIL.test(email)) return refus;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return refus;
  if ((exp as number) !== (iat as number) + DUREE_SECONDES) return refus;
  if (maintenant > (exp as number) || (iat as number) > maintenant + AVANCE_MAX_SECONDES) return refus;

  if (dejaVu(jti)) return refus;
  return { ok: true, email };
}
