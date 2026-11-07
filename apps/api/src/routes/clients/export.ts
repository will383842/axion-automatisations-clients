import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { empreinteCsv, versCsv } from "../../clients/export-csv.js";
import { filtrerClients, SchemaFiltres } from "../../clients/liste.js";
import { BASE, clientsVisibles, filtresDeLaVue, lire, membreAutorise, type DepsClients } from "./liste.js";

const Corps = z.strictObject({ filtres: SchemaFiltres.optional(), vue: z.string().max(64).optional() });

// Export CSV (C-579) : exactement les lignes du filtre courant, dans la portée du membre. La trace est écrite AVANT l'envoi : si elle échoue, aucun fichier ne part.
export function routeExport(serveur: FastifyInstance, d: DepsClients, pre: { preHandler: unknown[] }): void {
  serveur.post(`${BASE}/export`, pre as never, async (req, rep) => {
    const c = lire(Corps, req.body ?? {});
    const m = await membreAutorise(d, req);
    const filtres = { ...(await filtresDeLaVue(d, m, c.vue)), ...c.filtres };
    const lignes = filtrerClients(await clientsVisibles(d, m), filtres);
    const csv = versCsv(lignes);
    await d.tracerExport({ sujet: m.sujet, filtres, lignes: lignes.length, empreinte: empreinteCsv(csv) });
    return rep.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="clients.csv"').send(csv);
  });
}
