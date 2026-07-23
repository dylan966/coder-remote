# =============================================================================
# scratch —— a blank claude work workspace (for starting new projects)
# =============================================================================
# Full toolchain image (node/python/ripgrep/uv/claude/claude-hud/code-server), no
# switcher service. Reached via the coder-remote switcher (?ws=scratch) for claude,
# or the "VS Code (Web)" app to edit. Pre-wired Web(:3000)/API(:8000) quick-links.
#
# One-time setup (run on Mac):
#   coder templates push scratch -d template/scratch --yes
#   coder create --template scratch scratch --yes
# (claude auth uses your existing claude-token secret; no extra secret needed.)

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
  # Public wildcard URLs for the pre-wired ports (same host format as the switcher/apps).
  access_host = replace(replace(data.coder_workspace.me.access_url, "https://", ""), "http://", "")
  app_suffix  = "--${lower(data.coder_workspace.me.name)}--${lower(data.coder_workspace_owner.me.name)}.${local.access_host}"
  web_url     = "https://web${local.app_suffix}"
  api_url     = "https://api${local.app_suffix}"
}

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  env = {
    CODER_URL           = data.coder_workspace.me.access_url
    CODER_OWNER_NAME    = local.owner_name
    CODER_OWNER_EMAIL   = data.coder_workspace_owner.me.email
    WEB_PUBLIC_URL      = local.web_url
    API_PUBLIC_URL      = local.api_url
    DISABLE_AUTOUPDATER = "1" # claude-code is system-installed (root) → its self-update can't write; update via image rebuild
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
}

# ---- code-server (VS Code in the browser) --------------------------------------
resource "coder_script" "code_server" {
  agent_id     = coder_agent.main.id
  display_name = "code-server"
  icon         = "/icon/code.svg"
  run_on_start = true
  start_blocks_login = false
  script       = <<-EOT
    #!/usr/bin/env bash
    set -e
    pgrep -f "code-server" >/dev/null 2>&1 && exit 0
    mkdir -p "$HOME/.local/share/code-server/coder-logs"
    nohup code-server --auth=none --bind-addr=127.0.0.1:13337 --disable-workspace-trust /home/coder \
      >"$HOME/.local/share/code-server/coder-logs/stdout.log" 2>&1 &
    disown
  EOT
}

resource "coder_app" "code_server" {
  agent_id     = coder_agent.main.id
  slug         = "code-server"
  display_name = "VS Code (Web)"
  url          = "http://localhost:13337/"
  icon         = "/icon/code.svg"
  subdomain    = true
  share        = "owner"
  open_in      = "tab"
  order        = -10
  healthcheck {
    url       = "http://localhost:13337/healthz"
    interval  = 5
    threshold = 30
  }
}

# ---- Claude Code (dashboard button; the switcher also attaches to this session) --
resource "coder_app" "claude" {
  agent_id     = coder_agent.main.id
  slug         = "claude"
  display_name = "Claude Code"
  icon         = "/emojis/1f916.png" # 🤖
  command      = "#!/bin/bash\nset -e\nexec tmux new-session -A -s claude /home/coder/.start-claude.sh\n"
  order        = -5
}

# ---- Pre-wired service quick-links (show up in the switcher; work once you run a
# dev server on the port). No healthcheck — these are on-demand.
resource "coder_app" "web" {
  agent_id     = coder_agent.main.id
  slug         = "web"
  display_name = "Web (:3000)"
  url          = "http://localhost:3000"
  icon         = "/emojis/1f310.png" # 🌐
  subdomain    = true
  share        = "owner"
  open_in      = "tab"
  order        = 1
}

resource "coder_app" "api" {
  agent_id     = coder_agent.main.id
  slug         = "api"
  display_name = "API (:8000)"
  url          = "http://localhost:8000"
  icon         = "/emojis/1f527.png" # 🔧
  subdomain    = true
  share        = "owner"
  open_in      = "tab"
  order        = 2
}

# ---- Image + volume + container ------------------------------------------------
resource "docker_image" "base" {
  name = "scratch-coder-base-${lower(data.coder_workspace.me.name)}"
  build {
    context = "${path.root}/build"
  }
  triggers = {
    dir_sha1 = sha1(join("", [
      for f in fileset("${path.root}/build", "*") : filesha1("${path.root}/build/${f}")
    ]))
  }
}

resource "docker_volume" "home" {
  name = "scratch-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}-home"
  lifecycle { ignore_changes = all }
}

resource "docker_container" "workspace" {
  count      = data.coder_workspace.me.start_count
  name       = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  image      = docker_image.base.name
  hostname   = data.coder_workspace.me.name
  memory     = 8192
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
