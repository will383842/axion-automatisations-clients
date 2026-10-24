// Contrôle d'accessibilité structurel (remplace axe-core, dont la licence MPL-2.0 est refusée par la garde des licences).
// Le contraste n'est pas calculable hors navigateur : il est couvert par les jetons (responsive.test.tsx).
const nomAccessible = (el: Element): string => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();

export function violations(racine: ParentNode): string[] {
  const erreurs: string[] = [];
  racine.querySelectorAll("button, a[href]").forEach((el) => {
    if (!nomAccessible(el) && !el.querySelector("img[alt]:not([alt=''])")) erreurs.push(`${el.tagName} sans nom accessible`);
  });
  racine.querySelectorAll("img").forEach((el) => {
    if (!el.hasAttribute("alt")) erreurs.push("img sans attribut alt");
  });
  racine.querySelectorAll("input, select, textarea").forEach((el) => {
    const id = el.getAttribute("id");
    const etiquette = el.closest("label") ?? (id ? racine.querySelector(`label[for="${id}"]`) : null);
    if (!etiquette && !el.getAttribute("aria-label")) erreurs.push("champ sans label");
  });
  racine.querySelectorAll('[role="img"]').forEach((el) => {
    if (!el.getAttribute("aria-label")) erreurs.push("role=img sans aria-label");
  });
  racine.querySelectorAll('[role="progressbar"]').forEach((el) => {
    if (!el.hasAttribute("aria-valuenow") || !el.getAttribute("aria-label")) erreurs.push("progressbar incomplète");
  });
  racine.querySelectorAll("table").forEach((el) => {
    if (!el.querySelector("caption") || !el.querySelector("th[scope]")) erreurs.push("table sans légende ou en-têtes");
  });
  const ids = [...racine.querySelectorAll("[id]")].map((e) => e.id);
  if (new Set(ids).size !== ids.length) erreurs.push("id en double");
  return erreurs;
}
