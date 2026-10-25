# Image dérivée temporaire (ADR 0014) : postgres officielle sans gosu (binaire Go vulnérable). Retour à l'amont dès qu'il est vert.
FROM postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36
RUN rm /usr/local/bin/gosu /usr/local/bin/su-exec
USER postgres
