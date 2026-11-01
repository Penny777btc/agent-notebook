#!/usr/bin/env bash
# Deploy Agent Notebook on a Linux server (Ubuntu / Debian), as the user running this script:
#   Node 20+, the code repo, the private vault repo (via a deploy key), a systemd service bound to
#   127.0.0.1:$PORT, and a public https address through Tailscale Funnel. Safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/Penny777btc/agent-notebook/main/scripts/deploy-linux.sh | bash
#   or: bash scripts/deploy-linux.sh
#
# Tunables (env): APP_DIR, PORT, CODE_REPO, VAULT_REPO, SKIP_TAILSCALE=1, TZ_NAME (journal clock, e.g. Asia/Tokyo)
# Run it as a dedicated unprivileged user (e.g. `sudo useradd -m notebook`, then `sudo -u notebook -H bash`), not as
# an account with sudo: the service only needs its own home.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/agent-notebook}"
PORT="${PORT:-3777}"
CODE_REPO="${CODE_REPO:-https://github.com/Penny777btc/agent-notebook.git}"
VAULT_REPO="${VAULT_REPO:-git@github.com:Penny777btc/agent-notebook-vault.git}"
KEY="$HOME/.ssh/agent-notebook-vault"
SERVICE="agent-notebook"
SSH_CMD="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
need_sudo() { if ! sudo -n true 2>/dev/null; then echo "(需要 sudo 密码来安装软件 / 写 systemd)"; fi; }

say "1/6 system packages"
need_sudo
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v), npm $(npm -v)"

say "2/6 code → $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$CODE_REPO" "$APP_DIR"; fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null

say "3/6 vault (private repo) → $APP_DIR/vault"
if [ ! -d "$APP_DIR/vault/.git" ]; then
  if [ ! -f "$KEY" ]; then ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "agent-notebook@$(hostname)"; fi
  cat <<EOF

  把下面这把公钥加为 vault 仓库的 Deploy key（勾选 Allow write access）：
  https://github.com/Penny777btc/agent-notebook-vault/settings/keys/new

  $(cat "$KEY.pub")

EOF
  read -r -p "  加好后按回车继续… " _
  GIT_SSH_COMMAND="$SSH_CMD" git clone "$VAULT_REPO" "$APP_DIR/vault"
fi
git -C "$APP_DIR/vault" config core.sshCommand "$SSH_CMD"
git -C "$APP_DIR/vault" config user.name "agent-notebook"
git -C "$APP_DIR/vault" config user.email "agent-notebook@$(hostname)"
git -C "$APP_DIR/vault" remote set-url origin "$VAULT_REPO"

CONFIG="$APP_DIR/vault/.notebook/config.json"
mkdir -p "$APP_DIR/vault/.notebook"
if [ -f "$CONFIG" ]; then
  # keep tokens / password / AI settings, but bind locally and push backups over the deploy key
  node -e '
    const fs = require("fs"); const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.host = "127.0.0.1"; c.port = Number(process.argv[2]);
    c.backup = { ...(c.backup || {}), enabled: true, remote: process.argv[3] };
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  ' "$CONFIG" "$PORT" "$VAULT_REPO"
  echo "config.json 已在（保留 token、密码、AI 设置；host→127.0.0.1，备份远端→deploy key）"
else
  cat <<EOF
  没有 vault/.notebook/config.json：服务会以空配置启动，所有 agent token 和访问密码都要重新设。
  要沿用原来的，把原机器上的 vault/.notebook/config.json 拷到这里再重启服务：
    scp <原机器>:~/1Note/agent-notebook/vault/.notebook/config.json $CONFIG
EOF
fi

say "4/6 systemd service ($SERVICE, 127.0.0.1:$PORT)"
NODE_BIN="$(command -v node)"
mkdir -p "$HOME/.grok" "$HOME/.claude" "$HOME/.codex" "$HOME/.cache" "$HOME/.config"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=Agent Notebook (web UI + REST + MCP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=TZ=${TZ_NAME:-$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)}
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.grok/bin
ExecStart=$NODE_BIN $APP_DIR/src/cli.js serve --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/vault $HOME/.grok $HOME/.claude $HOME/.codex $HOME/.cache $HOME/.config

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE >/dev/null
sleep 1.5
if curl -fsS "http://127.0.0.1:$PORT/api/access" >/dev/null; then echo "service up: http://127.0.0.1:$PORT"; else sudo journalctl -u $SERVICE -n 20 --no-pager; exit 1; fi

if [ "${SKIP_TAILSCALE:-0}" = "1" ]; then say "SKIP_TAILSCALE=1 → 不配隧道"; exit 0; fi

say "5/6 Tailscale"
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh >/dev/null; fi
if ! tailscale status >/dev/null 2>&1; then
  echo "  下面会打印一个登录链接，用浏览器打开并授权这台机器："
  sudo tailscale up
fi

say "6/6 Tailscale Funnel → public https"
sudo tailscale funnel --bg "$PORT" || {
  echo "  如果提示 Funnel 未启用：打开它给出的链接，在管理后台点一次启用，然后重跑："
  echo "  sudo tailscale funnel --bg $PORT"; exit 1; }
URL="https://$(tailscale status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).Self.DNSName.replace(/\.$/,"")))')"
echo
echo "  公网地址：$URL"
echo "  手机和 agent 都用它；本机 agent（Hermes 等）可直接用 http://127.0.0.1:$PORT"
echo "  设置访问密码 / 生成 agent token：浏览器打开 $URL （若带了旧 config.json，原密码和 token 继续有效）"
echo "  日志：sudo journalctl -u $SERVICE -f    更新：cd $APP_DIR && git pull && sudo systemctl restart $SERVICE"
