# Image for the docker legs of scripts/e2e.ts. kimi + node on PATH,
# agent user with the host UID (bind-mount ownership), sandcastle's
# expected long-running entrypoint.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=501
RUN useradd -m -u ${AGENT_UID} -s /bin/bash agent

RUN npm i -g @moonshot-ai/kimi-code && npm cache clean --force

USER agent
ENTRYPOINT ["sleep", "infinity"]
