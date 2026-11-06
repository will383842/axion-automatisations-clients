# Console des automatisations — AXION IA

Code source de la console et du portail client des automatisations d'AXION IA (axion-ia.com).

- Ce dépôt est **public**. Il ne contient **aucun secret**, **aucune donnée réelle de client**, **aucun prix**, **aucun extrait du cahier des charges ni document juridique**.
- Les documents de conception sont dans un dépôt privé distinct.
- Toutes les données de test sont fictives (domaines `exemple.fr`, `.test`, `.example`).
- Signaler une faille : voir [SECURITY.md](SECURITY.md).

Statut : lot 0 (fondations) en cours.

## Contribuer

**Règle unique : fusionner `main` dans sa branche avant d'ouvrir la PR et avant de demander la relecture.** Une preuve ou une dette nouvelle va dans un fichier neuf `spec/preuves/<branche-assainie>.md`, jamais dans `spec/preuves.md` (historique figé, voir `spec/preuves/README.md` et l'ADR 0029) ; `ops/secrets-inventaire.md` et `docs/localisation-des-donnees.md` se fusionnent à la main ; l'index des ADR est généré (voir `docs/adr/README.md`). Jamais de rebase ni de force-push.
