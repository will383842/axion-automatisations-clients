// Client de l'API de Mailpit (le piège à e-mails des tests) : attendre, lister, lire, vider.
// Seuls les hôtes locaux sont acceptés : aucun test ne peut viser un vrai serveur.

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost"]);

export type AdresseMailpit = { Address: string; Name: string };
export type ResumeMessage = { ID: string; MessageID: string; Subject: string; From: AdresseMailpit; To: AdresseMailpit[] };
export type MessageMailpit = ResumeMessage & { Text: string; HTML: string };

export type OptionsMailpit = { api?: string; smtpHote?: string; smtpPort?: number };

export type ClientMailpit = {
  readonly smtp: { host: string; port: number };
  attendrePret(delaiMs?: number): Promise<void>;
  lister(): Promise<ResumeMessage[]>;
  lire(id: string): Promise<MessageMailpit>;
  vider(): Promise<void>;
  attendreMessages(nombre: number, delaiMs?: number): Promise<ResumeMessage[]>;
};

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

function exigerLocal(hote: string): void {
  if (!HOTES_LOCAUX.has(hote)) throw new Error(`Hôte refusé « ${hote} » : le piège doit être local (127.0.0.1)`);
}

export function creerClientMailpit(options: OptionsMailpit = {}): ClientMailpit {
  const api = new URL(options.api ?? process.env["MAILPIT_API"] ?? "http://127.0.0.1:8025");
  const smtp = {
    host: options.smtpHote ?? process.env["MAILPIT_SMTP_HOTE"] ?? "127.0.0.1",
    port: options.smtpPort ?? Number(process.env["MAILPIT_SMTP_PORT"] ?? 1025),
  };
  exigerLocal(api.hostname);
  exigerLocal(smtp.host);

  const appeler = async (chemin: string, init?: RequestInit) => {
    const r = await fetch(new URL(chemin, api), init);
    if (!r.ok) throw new Error(`Mailpit ${chemin} : ${r.status}`);
    return r;
  };
  const lister = async () => ((await (await appeler("/api/v1/messages")).json()) as { messages: ResumeMessage[] }).messages;

  return {
    smtp,
    // Le service de CI met du temps à démarrer : on attend sa réponse de santé avant tout test.
    async attendrePret(delaiMs = 30_000) {
      const fin = Date.now() + delaiMs;
      for (;;) {
        try {
          if ((await fetch(new URL("/readyz", api))).ok) return;
        } catch {
          // pas encore prêt
        }
        if (Date.now() > fin) throw new Error("Mailpit ne répond pas");
        await pause(250);
      }
    },
    lister,
    async lire(id) {
      return (await (await appeler(`/api/v1/message/${encodeURIComponent(id)}`)).json()) as MessageMailpit;
    },
    async vider() {
      await appeler("/api/v1/messages", { method: "DELETE" });
    },
    async attendreMessages(nombre, delaiMs = 10_000) {
      const fin = Date.now() + delaiMs;
      for (;;) {
        const messages = await lister();
        if (messages.length >= nombre) return messages;
        if (Date.now() > fin) throw new Error(`${messages.length} message(s) dans Mailpit au lieu de ${nombre}`);
        await pause(100);
      }
    },
  };
}

// Hôtes SMTP déclarés dans un texte de configuration (utilisé par le test qui interdit toute autre destination).
export function hotesSmtpDeclares(texte: string): string[] {
  const hotes: string[] = [];
  for (const m of texte.matchAll(/smtps?:\/\/(?:[^@\s/]*@)?([^\s/:'"]+)/g)) hotes.push(m[1] ?? "");
  for (const m of texte.matchAll(/\bSMTP_HOST\w*\s*[:=]\s*["']?([^\s"']+)/g)) hotes.push(m[1] ?? "");
  for (const m of texte.matchAll(/\bsmtpHote\b\s*[:=]\s*["']([^"']+)["']/g)) hotes.push(m[1] ?? "");
  for (const m of texte.matchAll(/\bMAILPIT_SMTP_HOTE\b\s*[:=]\s*["']?([^\s"']+)/g)) hotes.push(m[1] ?? "");
  for (const m of texte.matchAll(/\bhost\s*:\s*["']([^"']+)["']/g)) hotes.push(m[1] ?? "");
  return hotes;
}
