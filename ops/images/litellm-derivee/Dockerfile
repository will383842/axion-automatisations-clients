# Image dérivée temporaire (ADR 0015) : litellm-non_root au même tag, paquets Python vulnérables mis à jour. Retour à l'amont dès qu'il est vert.
FROM ghcr.io/berriai/litellm-non_root:v1.106.3@sha256:4fe2270c8b66d25654514744ee6629445c255c0303c292fcbd2d973117a04207
USER root
COPY correctifs.txt /tmp/correctifs.txt
RUN python -m ensurepip && python -m pip install --no-cache-dir --no-deps --require-hashes -r /tmp/correctifs.txt && python -m pip check && python -c "import importlib.metadata as m; assert m.version('litellm') == '1.106.3'" && python -m pip uninstall -y pip && rm /tmp/correctifs.txt
USER 65534
