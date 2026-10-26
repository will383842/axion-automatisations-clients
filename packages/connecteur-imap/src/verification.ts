import { ErreurConnecteur } from "@axion-auto/connecteurs-commun";
import { z } from "zod";

const HOTE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
// TLS direct (993, 465) ou STARTTLS exigé (143, 587) : aucun autre mode, aucun port en clair.
const PORTS = { imap: { tls: 993, starttls: 143 }, smtp: { tls: 465, starttls: 587 } } as const;
const Chiffrement = z.enum(["tls", "starttls"]);

// Aucun champ de mot de passe : le mot de passe est le jeton court reçu à chaque appel (A-335).
const Configuration = z
  .object({
    hoteImap: z.string().regex(HOTE),
    hoteSmtp: z.string().regex(HOTE),
    chiffrementImap: Chiffrement.default("tls"),
    chiffrementSmtp: Chiffrement.default("tls"),
    portImap: z.number().int().optional(),
    portSmtp: z.number().int().optional(),
    utilisateur: z.string().min(1),
    expediteur: z.string().regex(/^[^\s@<>]+@[^\s@<>]+$/),
  })
  .strict()
  .refine((c) => c.portImap === undefined || c.portImap === PORTS.imap[c.chiffrementImap], { message: "port IMAP incompatible avec le chiffrement" })
  .refine((c) => c.portSmtp === undefined || c.portSmtp === PORTS.smtp[c.chiffrementSmtp], { message: "port SMTP incompatible avec le chiffrement" });
export type ConfigurationImap = z.infer<typeof Configuration>;

export const verifierConfiguration = (brut: unknown): ConfigurationImap => Configuration.parse(brut);

type Tls = { minVersion: "TLSv1.2"; ca?: string; rejectUnauthorized?: false };
// Réglage réservé aux essais : une autorité de test (ca), ou, en environnement de test seulement, la vérification coupée.
export type ReglageTls = { ca?: string; rejectUnauthorized?: false };

// Seuls ca et rejectUnauthorized passent (le reste est ignoré) ; minVersion vient en dernier et ne se remplace pas.
export function reglerTls(tls: ReglageTls = {}, env: Record<string, string | undefined> = process.env): Tls {
  if (tls.rejectUnauthorized === false && env.NODE_ENV !== "test") throw new ErreurConnecteur("definitive", "reglage_tls_interdit");
  return { ...(tls.ca !== undefined ? { ca: tls.ca } : {}), ...(tls.rejectUnauthorized === false ? { rejectUnauthorized: false as const } : {}), minVersion: "TLSv1.2" };
}
export type OptionsImap = { host: string; port: number; secure: boolean; doSTARTTLS?: true; auth: { user: string; pass: string }; tls: Tls; logger: false };
export type OptionsSmtp = { host: string; port: number; secure: boolean; requireTLS: boolean; ignoreTLS: false; auth: { user: string; pass: string }; tls: Tls };

// Le réglage TLS supplémentaire ne sert qu'aux essais : la configuration ne le porte jamais.
export function optionsImap(c: ConfigurationImap, motDePasse: string, tls: ReglageTls = {}): OptionsImap {
  const starttls = c.chiffrementImap === "starttls";
  return {
    host: c.hoteImap, port: c.portImap ?? PORTS.imap[c.chiffrementImap], secure: !starttls, ...(starttls ? { doSTARTTLS: true as const } : {}),
    auth: { user: c.utilisateur, pass: motDePasse }, tls: reglerTls(tls), logger: false,
  };
}

export function optionsSmtp(c: ConfigurationImap, motDePasse: string, tls: ReglageTls = {}): OptionsSmtp {
  const starttls = c.chiffrementSmtp === "starttls";
  return {
    host: c.hoteSmtp, port: c.portSmtp ?? PORTS.smtp[c.chiffrementSmtp], secure: !starttls, requireTLS: starttls, ignoreTLS: false,
    auth: { user: c.utilisateur, pass: motDePasse }, tls: reglerTls(tls),
  };
}
