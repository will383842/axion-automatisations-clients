# Image dérivée temporaire (ADR 0014) : postgres officielle sans gosu (binaire Go vulnérable). Retour à l'amont dès qu'il est vert.
FROM postgres:18.0-alpine@sha256:48c8ad3a7284b82be4482a52076d47d879fd6fb084a1cbfccbd551f9331b0e40
RUN rm /usr/local/bin/gosu /usr/local/bin/su-exec
USER postgres
