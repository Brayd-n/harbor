#!/usr/bin/env bash
# Build the image here, copy it to the server, and (re)start it with Docker Compose.
# Secrets stay on the server in root-only files under /etc/harbor.
# Usage: DOMAIN=chat.example.com [OWNER_EMAIL=you@example.com] ./deploy.sh
# OWNER_EMAIL is needed on the first deploy; later deploys keep the saved one unless you pass a new one.
set -euo pipefail

SERVER="${SERVER:-braydon@brayd-n.com}"
DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=harbor.brayd-n.com}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
DIR=/opt/harbor
cd "$(dirname "$0")"

if [ -S "$HOME/.ssh/agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/.ssh/agent.sock"
fi

echo "Building image..."
docker build -t harbor:latest .

echo "Copying image, compose file and backup script..."
ssh "$SERVER" "sudo install -d -o \$USER $DIR"
scp -q docker-compose.yml backup.sh "$SERVER:$DIR/"
docker save harbor:latest | gzip | ssh "$SERVER" 'gunzip | docker load'

echo "Starting..."
ssh "$SERVER" "set -e
  sudo install -d -m 700 /etc/harbor
  if ! sudo test -f /etc/harbor/db.env; then
    pw=\$(openssl rand -hex 24)
    printf 'POSTGRES_PASSWORD=%s\n' \"\$pw\" | sudo sh -c 'umask 077; cat > /etc/harbor/db.env'
    printf 'PGPASSWORD=%s\n' \"\$pw\" | sudo sh -c 'umask 077; cat > /etc/harbor/app.env'
  fi
  # Master key that wraps every user's data key. Losing it makes stored API keys unreadable.
  if ! sudo grep -q '^MASTER_KEY=' /etc/harbor/app.env; then
    printf 'MASTER_KEY=%s\n' \"\$(openssl rand -hex 32)\" | sudo tee -a /etc/harbor/app.env >/dev/null
  fi
  sudo sed -i '/^APP_ORIGIN=/d' /etc/harbor/app.env
  printf 'APP_ORIGIN=https://%s\n' '$DOMAIN' | sudo tee -a /etc/harbor/app.env >/dev/null
  if [ -n '$OWNER_EMAIL' ]; then
    sudo sed -i '/^OWNER_EMAIL=/d' /etc/harbor/app.env
    printf 'OWNER_EMAIL=%s\n' '$OWNER_EMAIL' | sudo tee -a /etc/harbor/app.env >/dev/null
  elif ! sudo grep -q '^OWNER_EMAIL=.' /etc/harbor/app.env; then
    echo 'First deploy: set OWNER_EMAIL to the Google account that gets the admin page.' >&2; exit 1
  fi
  chmod 755 $DIR/backup.sh
  echo '40 3 * * * root $DIR/backup.sh' | sudo tee /etc/cron.d/harbor >/dev/null
  cd $DIR && sudo docker compose up -d --remove-orphans && docker image prune -f >/dev/null"

echo "Done. Caddy block (once, by hand): see README."
