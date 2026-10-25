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
}

// Les clés des fournisseurs d'IA et de la passerelle vivent dans OpenBao seulement (C-391, C-598 d).
const FOURNISSEURS_IA = ["ANTHROPIC", "OPENAI", "AZURE_OPENAI", "GEMINI", "GOOGLE_AI", "GOOGLE_GENERATIVE_AI", "MISTRAL", "COHERE", "GROQ", "DEEPSEEK", "XAI", "PERPLEXITY", "TOGETHER", "OPENROUTER", "FIREWORKS", "REPLICATE", "HUGGINGFACE"];
const PASSERELLE = ["LITELLM_MASTER_KEY", "LITELLM_SALT_KEY"];
const estCleIa = (nom: string) => {
  const n = nom.toUpperCase();
  return PASSERELLE.includes(n) || (FOURNISSEURS_IA.some((f) => n.startsWith(`${f}_`)) && (n.endsWith("_KEY") || n.endsWith("_TOKEN")));
};

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

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_DATABASE_URL: urlBase.optional(),
  HUB_URL: urlHttp,
  CRM_URL: urlHttp,
});

export function chargerConfig(env: NodeJS.ProcessEnv, dossierApi = fileURLToPath(new URL("..", import.meta.url))): Config {
  // Les messages citent les noms des variables, jamais leurs valeurs.
  const lu = Schema.safeParse({ ...env, PORT: env["PORT"] || undefined });
  if (!lu.success) throw new ConfigInvalide(`configuration invalide : ${lu.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const v = lu.data;
  if (v.NODE_ENV === "production") {
    const cles = Object.keys(env).filter(estCleIa);
    if (cles.length) throw new ConfigInvalide(`clé d'IA interdite dans l'environnement de production (elles vivent dans OpenBao) : ${cles.join(", ")}`);
    if (readdirSync(dossierApi).some((n) => n.toLowerCase() === ".env" || n.toLowerCase().startsWith(".env."))) {
      throw new ConfigInvalide("fichier .env interdit en production : les secrets viennent d'OpenBao");
    }
    if (!v.APP_DATABASE_URL) throw new ConfigInvalide("configuration invalide : APP_DATABASE_URL");
  }
  const { APP_DATABASE_URL: base, HUB_URL: hub, CRM_URL: crm } = v;
  return { env: v.NODE_ENV, port: v.PORT, ...(base ? { appDatabaseUrl: base } : {}), ...(hub ? { hubUrl: hub } : {}), ...(crm ? { crmUrl: crm } : {}) };
}
