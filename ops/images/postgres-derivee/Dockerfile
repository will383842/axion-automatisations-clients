# Image dérivée temporaire (ADR 0014) : postgres officielle sans gosu (binaire Go vulnérable). Retour à l'amont dès qu'il est vert.
FROM postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
RUN rm /usr/local/bin/gosu /usr/local/bin/su-exec
USER postgres
