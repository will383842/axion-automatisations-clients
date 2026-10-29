# Plugins prévus par le cahier

Seulement des noms d'outils et leur rôle ; le texte du cahier reste dans le dépôt privé.
Aucun plugin avec connecteur attaché aux routines. La licence est à relever sur la page officielle de chaque plugin avant installation (non reprise ici faute de source dans le dépôt).

| Plugin | Rôle | Licence | État | Installé le |
|---|---|---|---|---|
| Skills du dépôt (`module-automatisation`, `connecteur`, `harnais`) | Écrire un module, un connecteur et ses tests | Celle du dépôt | installé (dossier `.claude/skills/`) | 2026-10-27 |
| `axion-dev` (ligne de commande) | Essayer, tester, emballer un module | Celle du dépôt | à installer par le chef d'orchestre (livraison prévue dans le dépôt, absente à ce jour) | non constaté |
| `feature-dev` | Construire une fonctionnalité par étapes | à relever | à installer par le chef d'orchestre | non constaté |
| `security-guidance` | Alerter sur les changements risqués | à relever | à installer par le chef d'orchestre | non constaté |
| `claude-security` | Analyse de sécurité en fin de lot | à relever | à installer par le chef d'orchestre | non constaté |
| `pr-review-toolkit` | Agents relecteurs de PR (portée projet) | à relever | à installer par le chef d'orchestre | non constaté |
| `claude-md-management` | Garder CLAUDE.md aligné | à relever | à installer par le chef d'orchestre | non constaté |
| `typescript-lsp` | Erreurs de code en temps réel | à relever | à installer par le chef d'orchestre (avec le serveur de langage TypeScript) | non constaté |
| `frontend-design` | Écrans cohérents | à relever | à installer par le chef d'orchestre | non constaté |
| Sentry | Surveillance des erreurs en ligne | à relever | écarté pour les routines (connecteur) ; usage humain seulement, après la mise en ligne | sans objet |

La ligne C-381 de `spec/preuves.md` ne s'écrit que lorsque les 7 plugins sont constatés installés (colonne « Installé le » et licence relevée) ; d'ici là, C-381 reste « partielle ».
