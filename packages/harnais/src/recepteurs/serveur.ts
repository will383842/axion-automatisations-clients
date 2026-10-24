import Fastify from "fastify";

// Un seul serveur pour Telegram, MailWizz et les webhooks : chacun range ce qu'il reçoit, le liste et se vide.
// Écoute sur 127.0.0.1 seulement.
const ADRESSE = "127.0.0.1";

export type Recu = { canal: "telegram" | "mailwizz" | "webhook"; chemin: string; corps: unknown };
export type Recepteurs = { url: string; adresse: string; recus: Recu[]; arreter(): Promise<void> };

export async function demarrerRecepteurs(options: { port?: number } = {}): Promise<Recepteurs> {
  const app = Fastify({ logger: false });
  const recus: Recu[] = [];
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, corps, fin) => {
    try {
      fin(null, corps === "" ? {} : JSON.parse(corps as string));
    } catch {
      fin(null, { brut: String(corps) });
    }
  });

  app.post("/bot:jeton/sendMessage", async (req, rep) => {
    const corps = (req.body ?? {}) as { text?: string };
    if (typeof corps.text !== "string" || corps.text === "") return rep.code(400).send({ ok: false, description: "message text is empty" });
    recus.push({ canal: "telegram", chemin: req.url, corps });
    return { ok: true, result: { message_id: recus.length } };
  });
  // Sous-ensemble de l'API de campagnes de MailWizz.
  app.post("/api/campaigns", async (req, rep) => {
    recus.push({ canal: "mailwizz", chemin: req.url, corps: req.body });
    return rep.code(201).send({ status: "success", campaign_uid: `faux-${recus.length}` });
  });
  app.all("/webhook/*", async (req) => {
    recus.push({ canal: "webhook", chemin: req.url, corps: req.body });
    return { ok: true };
  });

  app.get("/__recus", async (req) => {
    const canal = (req.query as Record<string, string>)["canal"];
    return canal ? recus.filter((r) => r.canal === canal) : recus;
  });
  app.delete("/__recus", async () => {
    recus.length = 0;
    return { ok: true };
  });

  await app.listen({ host: ADRESSE, port: options.port ?? 0 });
  const adresse = app.server.address();
  const port = typeof adresse === "object" && adresse ? adresse.port : 0;
  return { url: `http://${ADRESSE}:${port}`, adresse: ADRESSE, recus, arreter: () => app.close() };
}
