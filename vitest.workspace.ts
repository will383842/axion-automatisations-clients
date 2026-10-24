// retry: 0 — aucune relance automatique (C-538), pour chaque projet.
const retry = 0;
const exclude = ["**/node_modules/**", "**/__fixtures__/**"];
const espaces = ["console", "portail", "api", "executeur"].map((n) => `apps/${n}`);
const paquets = ["contrats", "design", "sdk-module", "harnais"].map((n) => `packages/${n}`);

export default [
  { test: { name: "scripts", root: "./scripts", retry, exclude } },
  ...[...espaces, ...paquets].map((d) => ({ test: { name: d, root: `./${d}`, retry, exclude } })),
];
