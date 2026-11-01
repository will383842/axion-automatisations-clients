# Image unique de l'exécuteur (ADR 0014, ADR 0104). Amont épinglé par empreinte, non root, disque en lecture seule (--read-only au lancement).
# Le moteur, rien d'autre : aucune clé, aucun fichier d'environnement, aucun paquet de maillage réseau. Les services de données restent ceux du socle.
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=10001:10001 apps/executeur/ ./apps/executeur/
COPY --chown=10001:10001 ops/images/axion-moteur/point-entree.sh /usr/local/bin/point-entree.sh
RUN chmod 0555 /usr/local/bin/point-entree.sh
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/point-entree.sh"]
CMD ["node", "apps/executeur/src/index.ts"]
