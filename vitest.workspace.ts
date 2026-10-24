// retry: 0 — aucune relance automatique (C-538).
export default [
  { test: { name: "scripts", root: "./scripts", retry: 0, exclude: ["**/node_modules/**", "**/__fixtures__/**"] } },
  "apps/*",
  "packages/*",
];
