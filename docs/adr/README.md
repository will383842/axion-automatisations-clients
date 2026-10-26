# Décisions d'architecture (ADR)

Format court : contexte, décision, conséquences, date. Un ADR par décision, numéroté. Un ADR accepté ne se réécrit pas : on en écrit un nouveau qui le remplace.

Il n'y a plus de liste à la main ici : l'index est généré à partir des fichiers (ADR 0029).
- `node scripts/adr-index.ts` affiche l'index ; `node scripts/adr-index.ts --ecrire` l'écrit dans `docs/adr/index.md` (fichier local, ignoré par git).
- `node scripts/adr-index.ts --verifier` refuse deux ADR de même numéro, un nom de fichier qui ne correspond pas au titre et un `index.md` périmé ; la même garde tourne dans `pnpm test`.
- Fichier : `NNNN-sujet.md`, première ligne `# NNNN · Titre`. Le numéro vient de la fiche (réservé) ; une PR n'ajoute que son fichier d'ADR.
