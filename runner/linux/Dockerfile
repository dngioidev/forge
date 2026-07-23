# forge local self-hosted runner — ephemeral Linux image (ADR-0005 decisions 1 + 3).
#
# One image, one job, then torn down: the supervisor mints a 1-hour JIT config
# per job and runs this container with `--ephemeral` so no runner credential or
# workspace state ever survives a job (`docker compose run --rm`).
#
# node + pnpm + gh + the docker CLI are baked in so every Linux leg of verify.yml
# — pnpm verify, actionlint (docker://), plugin-validate — runs offline of hosted
# CI. The docker socket is bind-mounted at run time (see docker-compose.yml), NOT
# baked into the image, so this image holds no host credentials.
#
# NO SECRETS IN THIS IMAGE: the Administration-only PAT never enters a build arg
# or layer — it lives only in the supervisor's service environment and is used
# solely to mint the per-job JIT config, which is passed in at run time.
#
# Pin this to a digest before enabling (#227), e.g.
#   FROM node:22-bookworm-slim@sha256:<digest> AS base
# (forge's image convention is digest-pinned; kept as a tag here so the scaffold
# never ships a fabricated/unresolvable digest.)
FROM node:22-bookworm-slim AS base

# Pin these before enabling (ADR-0005 / #227 dogfood): the runner release + its
# published SHA-256. See https://github.com/actions/runner/releases
ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
ARG TARGETARCH=x64

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_ALLOW_RUNASROOT=0 \
    RUNNER_MANUALLY_TRAP_SIG=1

# Runtime deps: git + the runner's own installdependencies, plus the docker CLI
# (talks to the bind-mounted host socket) and gh. Pinned apt where the distro
# provides it; docker-ce-cli + gh come from their vendor apt repos.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git jq sudo lsb-release; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg; \
    chmod a+r /etc/apt/keyrings/githubcli.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli gh; \
    corepack enable; \
    rm -rf /var/lib/apt/lists/*

# Non-root runner user; the docker group lets it reach the bind-mounted socket.
RUN groupadd -g 999 docker || true; \
    useradd -m -s /bin/bash -G docker runner
WORKDIR /home/runner/actions-runner

# Download + checksum-verify the actions runner release, then run its dependency
# installer. A mismatched checksum aborts the build (supply-chain guard).
RUN set -eux; \
    curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${TARGETARCH}-${RUNNER_VERSION}.tar.gz"; \
    echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c -; \
    tar xzf runner.tar.gz; \
    rm runner.tar.gz; \
    ./bin/installdependencies.sh; \
    chown -R runner:docker /home/runner/actions-runner

COPY --chown=runner:docker entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh

USER runner
ENTRYPOINT ["/home/runner/entrypoint.sh"]
