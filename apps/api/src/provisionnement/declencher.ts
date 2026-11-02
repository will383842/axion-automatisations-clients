import { z } from "zod";
import { idTacheProvisionnement, normaliser, OPTIONS_TACHE } from "./machine.js";

// Déclenchement (C-498, C-682) : le consommateur de l'événement contrat_signe passe le client à « client » et écrit la ligne bases_client
// DANS LA MÊME TRANSACTION ; la tâche n'est déposée qu'APRÈS validation. T3-42 est le producteur réel ; ici, la forme de l'événement.
export const EvenementContratSigne = z.strictObject({
  type: z.literal("contrat_signe"),
  organisation: z.uuid(),
  devis: z.string().min(1).max(100),
  emisLe: z.iso.datetime(),
});
export type EvenementContratSigne = z.infer<typeof EvenementContratSigne>;
export const cleEvenementContratSigne = (e: EvenementContratSigne): string => `contrat_signe:${e.organisation}:${e.devis}`;

export interface Transaction {
  query(texte: string, valeurs: unknown[]): Promise<{ rows: unknown[] }>;
}
// nom_base est dérivé du seul tenant_id (contrainte bases_client_nom_base_derive) ; la grappe est choisie par l'étape 1.
export async function declencherProvisionnement(tx: Transaction, tenantId: string): Promise<{ cree: boolean }> {
  const id = z.uuid().parse(normaliser(tenantId));
  const nom = `cli_${id.replaceAll("-", "")}`;
  const { rows } = await tx.query(
    "INSERT INTO bases_client (id, tenant_id, organisation_id, grappe, nom_base) VALUES (gen_random_uuid(), $1, $2, 'a_choisir', $3) ON CONFLICT (tenant_id, nom_base) DO NOTHING RETURNING nom_base",
    [id, id, nom],
  );
  return { cree: rows.length > 0 };
}

export interface DepsContratSigne {
  enTransaction<T>(tenantId: string, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  // Passage du statut console « en_signature » à « client » (C1/T2-15 : pas de fonction commune à ce jour, câblée par l'appelant).
  passerAuStatutClient(tx: Transaction, organisation: string): Promise<void>;
  deposer(tenantId: string): Promise<void>;
}
export async function surContratSigne(evenement: EvenementContratSigne, d: DepsContratSigne): Promise<void> {
  const e = EvenementContratSigne.parse(evenement);
  const { cree } = await d.enTransaction(e.organisation, async (tx) => {
    await d.passerAuStatutClient(tx, e.organisation);
    return declencherProvisionnement(tx, e.organisation);
  });
  // Après validation seulement ; même jobId à chaque dépôt, donc jamais deux tâches pour un client.
  if (cree) await d.deposer(e.organisation);
}

// Relais propre au provisionnement : après un arrêt entre la validation et le dépôt, le balayage redépose chaque base encore en_creation (même jobId, jamais deux tâches).
export async function balayerProvisionnement(d: { enCreation(): Promise<string[]>; deposer(tenantId: string): Promise<void> }): Promise<number> {
  const clients = await d.enCreation();
  for (const t of clients) await d.deposer(z.uuid().parse(t));
  return clients.length;
}

// Dépôt de la tâche (une par client, jobId fixe). BullMQ ignore en silence un add dont le jobId existe encore, y compris dans l'ensemble « failed » :
// une tâche en échec définitif est donc retirée avant d'être redéposée (attempts repart de zéro) ; une tâche en attente, active ou différée est laissée telle quelle.
// La charge ne porte que le tenantId : jamais un mot de passe ni un chemin de coffre.
export interface FileProvisionnement {
  getJob(id: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined>;
  add(nom: string, donnees: { tenantId: string }, options: Record<string, unknown>): Promise<unknown>;
}
export async function deposerProvisionnement(file: FileProvisionnement, tenantId: string): Promise<void> {
  const id = idTacheProvisionnement(tenantId);
  const existante = await file.getJob(id);
  if (existante) {
    const etat = await existante.getState();
    if (etat !== "failed" && etat !== "completed") return;
    await existante.remove();
  }
  await file.add("provisionner", { tenantId: normaliser(tenantId) }, { ...OPTIONS_TACHE, jobId: id });
}
