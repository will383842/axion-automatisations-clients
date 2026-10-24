import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import nodemailer from "nodemailer";
import type { ClientMailpit } from "../mailpit.js";
import type { Brouillon, EtatGraph } from "./etat.js";

// Sous-ensemble de Microsoft Graph v1.0. Comme le vrai, AUCUN en-tête anti-doublon n'est lu à l'envoi.

const ADRESSE_FICTIVE = /^[^@\s]+@(?:exemple\.fr|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test)$/i;

const compteDe = (req: FastifyRequest): string => /^Bearer faux\.(.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "inconnu@exemple.fr";

type CorpsMessage = { subject?: string; body?: { contentType?: string; content?: string }; toRecipients?: { emailAddress?: { address?: string } }[] };

export function routesGraph(app: FastifyInstance, etat: EtatGraph, mailpit: ClientMailpit): void {
  const transport = nodemailer.createTransport({ host: mailpit.smtp.host, port: mailpit.smtp.port, secure: false, ignoreTLS: true });

  const jeton = async (req: FastifyRequest<{ Params: { tenant?: string } }>, rep: FastifyReply) => {
    if (etat.mode === "panne_generale") return rep.code(503).send({ error: { code: "ServiceUnavailable" } });
    const corps = (req.body ?? {}) as Record<string, string>;
    const client = corps["client_id"] ?? "inconnu@exemple.fr";
    const locataire = req.params.tenant ?? "common";
    // « Mauvais compte Microsoft » : le locataire de la demande n'est pas celui que l'appelant attendait.
    if (corps["tenant_attendu"] && corps["tenant_attendu"] !== locataire) {
      return rep.code(400).send({ error: "invalid_request", error_description: "AADSTS50020: Le compte utilisateur appartient à un autre locataire." });
    }
    const exige = etat.mode === "consentement_admin_requis" || (etat.consentementRequis && !etat.consentements.has(`${client}|${locataire}`));
    if (exige) {
      return rep.code(400).send({ error: "invalid_grant", error_description: "AADSTS65001: L'administrateur n'a pas donné son consentement à l'application." });
    }
    return { token_type: "Bearer", expires_in: 3599, access_token: `faux.${client}` };
  };
  app.post("/oauth2/v2.0/token", jeton);
  app.post("/:tenant/oauth2/v2.0/token", jeton);

  // Simulation de l'accord de l'administrateur du client.
  app.get("/adminconsent", async (req, rep) => {
    const { client_id, tenant } = req.query as Record<string, string | undefined>;
    if (!client_id || !tenant) return rep.code(400).send({ error: "invalid_request" });
    etat.consentements.add(`${client_id}|${tenant}`);
    return { admin_consent: true, tenant };
  });

  // Pannes communes à toutes les routes /v1.0, pour tous les comptes.
  app.addHook("preHandler", async (req, rep) => {
    if (!req.url.startsWith("/v1.0/")) return;
    if (etat.mode === "panne_generale") return rep.code(503).send({ error: { code: "ServiceUnavailable" } });
    if (etat.mode === "quota") return rep.code(429).header("Retry-After", "2").send({ error: { code: "TooManyRequests" } });
  });

  app.post("/v1.0/me/messages", async (req, rep) => {
    const corps = (req.body ?? {}) as CorpsMessage;
    const destinataires = (corps.toRecipients ?? []).map((d) => d.emailAddress?.address ?? "");
    if (destinataires.some((a) => !ADRESSE_FICTIVE.test(a))) return rep.code(400).send({ error: { code: "ErrorInvalidRecipients" } });
    const id = randomUUID();
    const brouillon: Brouillon = {
      id,
      internetMessageId: `<${id}@faux-graph.test>`,
      compte: compteDe(req),
      subject: corps.subject ?? "",
      contenu: corps.body?.content ?? "",
      type: corps.body?.contentType === "html" ? "html" : "text",
      destinataires,
    };
    etat.brouillons.set(id, brouillon);
    return rep.code(201).send({ id, internetMessageId: brouillon.internetMessageId, subject: brouillon.subject });
  });

  app.post("/v1.0/me/messages/:id/send", async (req: FastifyRequest<{ Params: { id: string } }>, rep: FastifyReply) => {
    const brouillon = etat.brouillons.get(req.params.id);
    if (!brouillon) return rep.code(404).send({ error: { code: "ErrorItemNotFound" } });
    await transport.sendMail({
      messageId: brouillon.internetMessageId,
      from: brouillon.compte,
      to: brouillon.destinataires,
      subject: brouillon.subject,
      ...(brouillon.type === "html" ? { html: brouillon.contenu } : { text: brouillon.contenu }),
    });
    etat.envoyes.push(brouillon);
    if (etat.mode === "reponse_perdue") {
      // Le message est parti ; la connexion est coupée avant la réponse (piège du scénario 8).
      rep.hijack();
      req.raw.socket.destroy();
      return;
    }
    return rep.code(202).send();
  });

  app.get("/v1.0/me/mailFolders/SentItems/messages", async (req) => {
    const filtre = (req.query as Record<string, string>)["$filter"] ?? "";
    const id = /internetMessageId eq '([^']+)'/.exec(filtre)?.[1];
    const compte = compteDe(req);
    const trouves = etat.envoyes.filter((m) => m.compte === compte && (id === undefined || m.internetMessageId === id));
    return { value: trouves.map((m) => ({ id: m.id, internetMessageId: m.internetMessageId, subject: m.subject })) };
  });
}
