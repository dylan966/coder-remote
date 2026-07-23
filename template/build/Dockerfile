# syntax=docker/dockerfile:1.6
#
# coder-remote hub —— always-on lightweight workspace, runs only coder-switcher (Node).
# No JDK/Maven/python needed: the transcript enumeration script (SESS_PY) runs on the
# **target** workspace via `coder ssh`; the hub only proxies. So the image only needs
# Node + git + coder CLI + basic tools.
#
# Built automatically during server provisioning (main.tf's docker_image points at ./build).

FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH

# ---- OS base tools (base64/tar/ss etc. come with coreutils/procps/iproute2) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg sudo \
        git jq tmux less procps iproute2 openssh-client \
        ripgrep python3 \
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
# npm pinned to @11: npm@12 requires Node >=22 and would fail the build with
# EBADENGINE on Node 20.

# ---- coder CLI (installs the version matching the current server, used by the
# `coder ssh` the switcher shells out to) ------
RUN curl -fsSL https://coder.gmaster888.com/install.sh | sh \
    && coder version || true

# ---- Claude Code (this hub doubles as a claude workspace: ?ws=coder-remote) ----
RUN npm install -g @anthropic-ai/claude-code \
    && (claude --version || true)

# ---- uv / uvx (run MCP servers + python tooling for claude; manages its own python) ----
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version && uvx --version

# ---- claude-hud (statusline HUD → node /opt/claude-hud/dist/index.js) ----
RUN git clone --depth 1 https://github.com/jarrodwatts/claude-hud /opt/claude-hud \
    && cd /opt/claude-hud && npm ci && npm run build \
    && test -f dist/index.js && echo "claude-hud built"

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
