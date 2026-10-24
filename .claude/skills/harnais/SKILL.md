---
name: harnais
description: Utiliser le harnais de test : Mailpit, faux Microsoft 365, bouchons signés du Hub et du CRM.
---

# Skill : harnais
Outils dans `packages/harnais` (fiche T0-20).
- Mailpit pour les e-mails ; faux Microsoft 365 pour le calendrier et la messagerie.
- Bouchons signés du Hub et du CRM, à partir des fixtures de `packages/contrats`.
- Tout envoi va dans le piège : aucun message ne sort jamais vers l'extérieur pendant un test.
- Données générées seulement (`@exemple.fr`, `*.test`).
