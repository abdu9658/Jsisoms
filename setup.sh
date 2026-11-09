#!/usr/bin/env bash
# Ubuntu 22.04/24.04 serverda root sifatida ishga tushiring:
#   DOMAIN=qalam.example.uz bash deploy/setup.sh
# Oldin: domen A-yozuvi shu serverning IP siga qaratilgan bo'lsin, loyiha /opt/qalam ga nusxalangan bo'lsin.
set -euo pipefail
: "${DOMAIN:?DOMAIN=sizning-domen.uz ni bering}"
apt-get update && apt-get install -y curl ufw debian-keyring debian-archive-keyring apt-transport-https gpg
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# Caddy (avtomatik HTTPS)
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sed 's|^deb |deb [signed-by=/usr/share/keyrings/caddy.gpg] |' > /etc/apt/sources.list.d/caddy.list
apt-get update && apt-get install -y caddy
id qalam &>/dev/null || useradd -r -m -d /opt/qalam -s /usr/sbin/nologin qalam
[ -f /opt/qalam/.env ] || { echo "/opt/qalam/.env yo'q: .env.example dan nusxa olib to'ldiring"; exit 1; }
sed -i "s|^WEBAPP_URL=.*|WEBAPP_URL=https://$DOMAIN|" /opt/qalam/.env
grep -q '^HOST=' /opt/qalam/.env || echo 'HOST=127.0.0.1' >> /opt/qalam/.env
mkdir -p /opt/qalam/data && chown -R qalam:qalam /opt/qalam && chmod 600 /opt/qalam/.env
cp /opt/qalam/deploy/qalam.service /etc/systemd/system/qalam.service
sed "s/DOMEN.UZ/$DOMAIN/" /opt/qalam/deploy/Caddyfile > /etc/caddy/Caddyfile
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
systemctl daemon-reload && systemctl enable --now qalam && systemctl restart caddy
echo "Tayyor: https://$DOMAIN  (loglar: journalctl -u qalam -f)"
