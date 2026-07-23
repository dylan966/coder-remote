# =============================================================================
# coder-remote —— always-on lightweight hub workspace, runs only this repo's
# coder-switcher (Node)
# =============================================================================
# One page to view/switch all workspaces and enter each one's claude session;
# mobile bubble chat + PWA + Web Push. App code lives at this repo's root
# (src/ public/); this directory is just the Coder template that deploys it.
# The hub clones this repo on startup.
#
# One-time setup (run on Mac, connected to coder.gmaster888.com):
#   coder templates push coder-remote -d template --yes    # run from repo root, -d points here
#   coder create --template coder-remote coder-remote --yes
#   coder tokens create --lifetime 168h                     # 168h = server max lifetime
#   printf %s '<token>' | coder secret create switcher-token --env SWITCHER_TOKEN
#   coder schedule stop coder-remote manual                 # always-on: disable auto-stop
#   coder restart coder-remote

terraform {
  required_providers {
    coder  = { source = "coder/coder" }
    docker = { source = "kreuzwerker/docker" }
  }
}

provider "docker" {}

data "coder_workspace"       "me" {}
data "coder_workspace_owner" "me" {}
data "coder_provisioner"     "me" {}

locals {
  owner_name = data.coder_workspace_owner.me.full_name != "" && data.coder_workspace_owner.me.full_name != "default" ? data.coder_workspace_owner.me.full_name : split("@", data.coder_workspace_owner.me.email)[0]
}

# ------------------------------------------------------------------------------
# Coder agent —— injects CODER_URL (used by the switcher backend + coder CLI).
# The user token is not set here: it's injected via
# `coder secret create switcher-token --env SWITCHER_TOKEN`
# (a user-level secret; CODER_* env names are reserved, so startup.sh maps
# SWITCHER_TOKEN -> CODER_TOKEN for the switcher backend).
# ------------------------------------------------------------------------------
resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  env = {
    CODER_URL         = data.coder_workspace.me.access_url
    CODER_OWNER_NAME  = local.owner_name
    CODER_OWNER_EMAIL = data.coder_workspace_owner.me.email
  }

  startup_script = file("${path.root}/startup.sh")

  metadata {
    display_name = "CPU"
    key          = "cpu"
    script       = "top -bn1 | grep '%Cpu' | awk '{print $2\"% user\"}'"
    interval     = 10
    timeout      = 1
  }
  metadata {
    display_name = "Memory"
    key          = "mem"
    script       = "u=$(cat /sys/fs/cgroup/memory.current 2>/dev/null||echo 0); m=$(cat /sys/fs/cgroup/memory.max 2>/dev/null||echo 0); echo $u $m | awk '{printf \"%.1f / %.1fGi\", $1/1073741824, $2/1073741824}'"
    interval     = 10
    timeout      = 1
  }
  metadata {
    display_name = "Switcher :8080"
    key          = "svc-switcher"
    script       = "curl -s -o /dev/null --connect-timeout 1 --max-time 2 http://127.0.0.1:8080/ 2>/dev/null && echo '✓ up' || echo '✗ down'"
    interval     = 15
    timeout      = 2
  }
}

# ------------------------------------------------------------------------------
# Switcher app —— subdomain HTTPS (PWA/Web Push require a secure context);
# share=owner is the auth layer: only whoever is logged into this Coder
# account can open it. Healthcheck hits static / (no token needed, just
# reflects whether the service is up).
# ------------------------------------------------------------------------------
resource "coder_app" "switcher" {
  agent_id     = coder_agent.main.id
  slug         = "switcher"
  display_name = "Workspace Switcher"
  url          = "http://localhost:8080"
  icon         = "/emojis/1f4ac.png" # 💬
  subdomain    = true
  share        = "owner"
  open_in      = "tab"
  order        = -20
  healthcheck {
    url       = "http://localhost:8080/"
    interval  = 10
    threshold = 30
  }
}

# ------------------------------------------------------------------------------
# Token auto-refresh —— daily cron: while the session is valid, mint a fresh 168h
# token, re-login, and overwrite the switcher-token secret so the token never hits
# the server's 7-day cap (as long as the hub isn't offline > 7 days).
# ------------------------------------------------------------------------------
resource "coder_script" "token_refresh" {
  agent_id     = coder_agent.main.id
  display_name = "Token auto-refresh"
  icon         = "/emojis/1f501.png" # 🔁
  cron         = "0 4 * * *"         # daily 04:00, well within the 7-day window
  run_on_start = false               # startup.sh already logs in from the secret on boot
  script       = file("${path.root}/token-refresh.sh")
}

# ------------------------------------------------------------------------------
# Base image —— built locally on the server during provisioning (build/
# context is uploaded along with the template).
# ------------------------------------------------------------------------------
resource "docker_image" "base" {
  name = "coder-remote-hub-${lower(data.coder_workspace.me.name)}"
  build {
    context = "${path.root}/build"
  }
  triggers = {
    dir_sha1 = sha1(join("", [
      for f in fileset("${path.root}/build", "*") : filesha1("${path.root}/build/${f}")
    ]))
  }
}

# ------------------------------------------------------------------------------
# Home volume + container (lightweight: 2G RAM is enough for node + a few
# PTY bridges).
# ------------------------------------------------------------------------------
resource "docker_volume" "home" {
  name = "coder-remote-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}-home"
  lifecycle { ignore_changes = all }
}

resource "docker_container" "workspace" {
  count      = data.coder_workspace.me.start_count
  name       = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  image      = docker_image.base.name
  hostname   = data.coder_workspace.me.name
  memory     = 2048
  entrypoint = ["sh", "-c", coder_agent.main.init_script]

  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
  ]

  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home.name
    read_only      = false
  }

  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
}
