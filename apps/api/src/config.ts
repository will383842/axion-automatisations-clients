import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Configuration de l'API : noms de variables seulement, jamais de valeur écrite ici.
// Fermé par défaut : NODE_ENV absent ou mal écrit refuse le démarrage, pour qu'aucune faute de frappe ne désactive les contrôles de production.

export class ConfigInvalide extends Error {}

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  appDatabaseUrl?: string;
  hubUrl?: string;
  crmUrl?: string;
  // Interrupteurs des canaux (C-510) : fermés par défaut.
  hubActif?: boolean;
  crmActif?: boolean;
}

// Les clés des fournisseurs d'IA et de la passerelle vivent dans OpenBao seulement (C-391, C-598 d).
// Le nom du fournisseur de Microsoft est aussi un nom de couleur CSS : écrit en deux morceaux pour la garde des couleurs.
const AZ = "AZUR" + "E";
const FOURNISSEURS_IA = ["ANTHROPIC", "CLAUDE", "OPENAI", AZ, `${AZ}_OPENAI`, "AWS_BEARER_TOKEN", "GEMINI", "GOOGLE", "GOOGLE_AI", "GOOGLE_GENERATIVE_AI", "MISTRAL", "COHERE", "CO", "GROQ", "DEEPSEEK", "XAI", "PERPLEXITY", "TOGETHER", "OPENROUTER", "FIREWORKS", "REPLICATE", "HUGGINGFACE", "HF", "VOYAGE", "LITELLM"];
// Nom : fournisseur connu (ou clé de passerelle) puis un suffixe _KEY, _TOKEN ou _APIKEY, éventuellement suivi de chiffres ; AWS_BEARER_TOKEN_BEDROCK compris.
const estCleIaParNom = (nom: string) => {
  const n = nom.toUpperCase();
  return FOURNISSEURS_IA.some((f) => n === f || n.startsWith(`${f}_`)) && /(_KEY|_TOKEN|_APIKEY)(_?\d+)?$|^AWS_BEARER_TOKEN_/.test(n);
};
// Valeur : préfixes connus des clés (jamais affichés ; seul le nom de la variable sort dans le message).
const estCleIaParValeur = (valeur: string) => /^(sk-|AIza)/.test(valeur.trim());
const estCleIa = (nom: string, valeur: string | undefined) => estCleIaParNom(nom) || estCleIaParValeur(valeur ?? "");

const urlHttp = z.url({ protocol: /^https?$/ }).optional();
const urlBase = z.string().refine((valeur) => {
  try {
    const u = new URL(valeur);
    // Aucun paramètre ne doit pouvoir changer le rôle : seul sslmode est permis.
    return (
      (u.protocol === "postgres:" || u.protocol === "postgresql:") &&
      decodeURIComponent(u.username) === "console_app" &&
      [...u.searchParams.keys()].every((k) => k === "sslmode")
    );
  } catch {
    return false;
  }
}, "doit viser le rôle console_app, sans paramètre autre que sslmode");

// Seules les valeurs 1 et true ouvrent ; absent ou vide = fermé ; toute autre valeur est refusée.
const interrupteur = z.preprocess((v) => (v === "" ? undefined : v), z.enum(["0", "1", "true", "false"]).default("0")).transform((v) => v === "1" || v === "true");

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_DATABASE_URL: urlBase.optional(),
  HUB_URL: urlHttp,
  CRM_URL: urlHttp,
  CONSOLE_HUB_ACTIF: interrupteur,
  CONSOLE_CRM_ACTIF: interrupteur,
});

export function chargerConfig(env: NodeJS.ProcessEnv, dossierApi = fileURLToPath(new URL("..", import.meta.url))): Config {
  // Les messages citent les noms des variables, jamais leurs valeurs.
  const lu = Schema.safeParse({ ...env, PORT: env["PORT"] || undefined });
  if (!lu.success) throw new ConfigInvalide(`configuration invalide : ${lu.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const v = lu.data;
  if (v.NODE_ENV === "production") {
    const cles = Object.entries(env).filter(([nom, valeur]) => estCleIa(nom, valeur)).map(([nom]) => nom);
    if (cles.length) throw new ConfigInvalide(`clé d'IA interdite dans l'environnement de production (elles vivent dans OpenBao) : ${cles.join(", ")}`);
    if (readdirSync(dossierApi).some((n) => n.toLowerCase() === ".env" || n.toLowerCase().startsWith(".env."))) {
      throw new ConfigInvalide("fichier .env interdit en production : les secrets viennent d'OpenBao");
    }
    if (!v.APP_DATABASE_URL) throw new ConfigInvalide("configuration invalide : APP_DATABASE_URL");
  }
  const { APP_DATABASE_URL: base, HUB_URL: hub, CRM_URL: crm } = v;
  const actifs = { hubActif: v.CONSOLE_HUB_ACTIF, crmActif: v.CONSOLE_CRM_ACTIF };
  return { env: v.NODE_ENV, port: v.PORT, ...actifs, ...(base ? { appDatabaseUrl: base } : {}), ...(hub ? { hubUrl: hub } : {}), ...(crm ? { crmUrl: crm } : {}) };
}
