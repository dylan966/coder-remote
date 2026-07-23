# syntax=docker/dockerfile:1.6
#
# scratch —— a general claude work workspace (blank; for starting new projects).
# Full toolchain: Node 20 + python3 + ripgrep + uv + claude-code + claude-hud + code-server.
# No switcher service here (that's the coder-remote hub's job) — this box is for doing work.
#
# Built automatically during server provisioning (main.tf's docker_image points at ./build).

FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH

# ---- OS base + build tooling ---------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg sudo \
        git jq tmux less procps iproute2 openssh-client \
        ripgrep python3 python3-venv build-essential pkg-config \
        locales tzdata \
    && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# ---- Node 20 LTS (NodeSource, multi-arch) -----------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@11 \
    && node --version && npm --version

# ---- coder CLI -----------------------------------------------------------------
RUN curl -fsSL https://coder.gmaster888.com/install.sh | sh \
    && coder version || true

# ---- Claude Code ---------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code \
    && (claude --version || true)

# ---- uv / uvx (MCP servers + python tooling; manages its own python) -----------
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version && uvx --version

# ---- claude-hud (statusline HUD → node /opt/claude-hud/dist/index.js) ----------
RUN git clone --depth 1 https://github.com/jarrodwatts/claude-hud /opt/claude-hud \
    && cd /opt/claude-hud && npm ci && npm run build \
    && test -f dist/index.js && echo "claude-hud built"

# ---- code-server (VS Code in the browser) --------------------------------------
RUN curl -fsSL https://code-server.dev/install.sh | sh \
    && code-server --version | head -1

# ---- coder user ----------------------------------------------------------------
ARG USERNAME=coder
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

USER ${USERNAME}
WORKDIR /home/${USERNAME}
SHELL ["/bin/bash", "-lc"]
