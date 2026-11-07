import { createHmac, timingSafeEqual } from "node:crypto";
import type { CodeConnexion } from "./transactions.js";

// Lien de connexion (B-092) : v1.<kid>.<charge base64url>.<hmac base64url>. Il vit dans le fragment de l'adresse du portail.
export const OUTILS = ["microsoft-365", "gmail", "imap"] as const;
export type Outil = (typeof OUTILS)[number];
export const DUREE_MAX_S = 7 * 86_400;
const LONGUEUR_MAX = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KID = /^[A-Za-z0-9_-]{1,16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const DOMAINE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface ChargeLien { v: 1; jti: string; t: string; c: string; o: Outil; l?: string; d?: string; iat: number; exp: number }
export interface CleLien { kid: string; secret: Uint8Array | string }
export interface SessionPortail { sujet: string; tenantId: string }

// Ordre fixe : la vérification recompose le texte et refuse toute autre forme (clé en double, en trop, __proto__).
const texteCanonique = (c: ChargeLien): string =>
  JSON.stringify({ v: c.v, jti: c.jti, t: c.t, c: c.c, o: c.o, ...(c.l !== undefined ? { l: c.l } : {}), ...(c.d !== undefined ? { d: c.d } : {}), iat: c.iat, exp: c.exp });
const mac = (cle: CleLien, entete: string): Buffer => createHmac("sha256", cle.secret).update(entete).digest();

export function signerLien(charge: ChargeLien, cle: CleLien): string {
  const entete = `v1.${cle.kid}.${Buffer.from(texteCanonique(charge)).toString("base64url")}`;
  return `${entete}.${mac(cle, entete).toString("base64url")}`;
}

export function verifierLien(jeton: string, cles: readonly CleLien[], maintenantMs: number): ChargeLien | null {
  try {
    if (typeof jeton !== "string" || jeton.length > LONGUEUR_MAX) return null;
    const morceaux = jeton.split(".");
    if (morceaux.length !== 4) return null;
    const [version, kid, charge64, signature64] = morceaux as [string, string, string, string];
    if (version !== "v1" || !KID.test(kid) || !B64URL.test(charge64) || !B64URL.test(signature64)) return null;
    const cle = cles.find((k) => k.kid === kid);
    if (!cle) return null;
    // La signature se vérifie sur les octets reçus, AVANT tout décodage JSON.
    const attendue = mac(cle, `v1.${kid}.${charge64}`);
    const recue = Buffer.from(signature64, "base64url");
    if (recue.length !== attendue.length || !timingSafeEqual(recue, attendue) || recue.toString("base64url") !== signature64) return null;
    const octets = Buffer.from(charge64, "base64url");
    if (octets.toString("base64url") !== charge64) return null;
    const texte = octets.toString("utf8");
    const c = JSON.parse(texte) as ChargeLien;
    if (typeof c !== "object" || c === null || Array.isArray(c)) return null;
    if (!UUID.test(c.t) || !UUID.test(c.c) || !UUID.test(c.jti) || !(OUTILS as readonly string[]).includes(c.o) || c.v !== 1) return null;
    if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
    if (c.l !== undefined && !UUID.test(c.l)) return null;
    if (c.d !== undefined && !DOMAINE.test(c.d)) return null;
    if (c.o === "microsoft-365" && c.l === undefined) return null;
    if (texteCanonique(c) !== texte) return null;
    if (c.exp - c.iat > DUREE_MAX_S || c.exp * 1000 <= maintenantMs || c.iat * 1000 > maintenantMs) return null;
    return c;
  } catch {
    return null;
  }
}

export interface PortsLien {
  cles(): readonly CleLien[] | Promise<readonly CleLien[]>;
  maintenant(): number;
  // Interrupteur ouvert ET fiche de conformité signée pour cet outil.
  porte(outil: Outil): boolean | Promise<boolean>;
  // Connexion encore en « a_tester » et jamais réclamée.
  connexionATester(tenantId: string, connexionId: string): Promise<boolean>;
}
export type OuvertureLien = { ok: true; charge: ChargeLien } | { ok: false; code: Extract<CodeConnexion, "lien_invalide" | "porte_fermee"> };

export async function ouvrirLien(p: PortsLien, jeton: string, session: SessionPortail | null): Promise<OuvertureLien> {
  const refus = { ok: false, code: "lien_invalide" } as const;
  const charge = verifierLien(jeton, await p.cles(), p.maintenant());
  // Même refus neutre : personne n'apprend si le lien existe.
  if (!charge || !session || session.tenantId !== charge.t) return refus;
  if (!(await p.porte(charge.o))) return { ok: false, code: "porte_fermee" };
  if (!(await p.connexionATester(charge.t, charge.c).catch(() => false))) return refus;
  return { ok: true, charge };
}
