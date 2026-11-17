# U185: target image for the clean-container relay install e2e (U183 R13c/R14).
# node:24-bookworm-slim lacks curl/openssl, which the generated installer needs.
# Build (override the base with a reachable mirror when needed):
#   docker build -f cloud-platform/scripts/relay-e2e-image.Dockerfile \
#     --build-arg BASE_IMAGE=docker.1ms.run/library/node:24-bookworm-slim \
#     -t orca-e2e-node24-bookworm:local .
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
