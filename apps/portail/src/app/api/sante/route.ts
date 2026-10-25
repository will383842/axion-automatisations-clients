// Route de santé : aucun service touché (A-047).
export function GET() {
  return Response.json(
    { etat: "ok", application: "portail", version: process.env["APP_VERSION"] ?? "0.0.0" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
