#!/bin/bash
# 在 ECS 上为 Cloudflare 回源开启 443：portal 继续占用 :80，nginx 仅监听 443 并反代到本机 80。
# 使用自签证书即可配合 Cloudflare「完全」(Full)；「完全（严格）」需换成 Cloudflare Origin CA。
set -euo pipefail

DOMAIN="${DOMAIN:-saoyu.fun}"
SSL_DIR="/etc/nginx/ssl"
CRT="$SSL_DIR/${DOMAIN}.crt"
KEY="$SSL_DIR/${DOMAIN}.key"
NGINX_CONF="/etc/nginx/nginx.conf"
SITE_CONF="/etc/nginx/conf.d/saoyu-origin-https.conf"
NAV_CONF="/etc/nginx/conf.d/navigation.conf"

mkdir -p "$SSL_DIR"

if [[ ! -s "$CRT" || ! -s "$KEY" ]]; then
  echo "==> 生成 ${DOMAIN} 自签证书（15 年）"
  openssl req -x509 -nodes -newkey rsa:2048 -days 5475 \
    -keyout "$KEY" \
    -out "$CRT" \
    -subj "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN},DNS:www.${DOMAIN}"
  chmod 600 "$KEY"
  chmod 644 "$CRT"
else
  echo "==> 已有证书，跳过生成: $CRT"
fi

if [[ -f "$NAV_CONF" ]]; then
  echo "==> 停用会占用 :80 的 navigation.conf（portal 已占用 80）"
  mv -f "$NAV_CONF" "${NAV_CONF}.disabled"
fi

if grep -q 'listen       80;' "$NGINX_CONF" && ! grep -q 'saoyu-disabled-default-80' "$NGINX_CONF"; then
  echo "==> 注释 nginx 默认 server :80，避免与 portal 抢端口"
  python3 - <<'PY'
from pathlib import Path
p = Path("/etc/nginx/nginx.conf")
text = p.read_text()
old = '''    server {
        listen       80;
        listen       [::]:80;
        server_name  _;
        root         /usr/share/nginx/html;

        # Load configuration files for the default server block.
        include /etc/nginx/default.d/*.conf;

        error_page 404 /404.html;
        location = /404.html {
        }

        error_page 500 502 503 504 /50x.html;
        location = /50x.html {
        }
    }'''
new = '''    # saoyu-disabled-default-80: portal 占用 :80，由 conf.d 提供 :443
    # server {
    #     listen       80;
    #     listen       [::]:80;
    #     server_name  _;
    #     root         /usr/share/nginx/html;
    #     include /etc/nginx/default.d/*.conf;
    # }'''
if old not in text:
    raise SystemExit("nginx.conf default server block not found; abort")
p.write_text(text.replace(old, new, 1))
print("patched nginx.conf")
PY
fi

cat > "$SITE_CONF" <<EOF
# Cloudflare origin HTTPS: 443 -> portal :80
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN} www.${DOMAIN};

    ssl_certificate     ${CRT};
    ssl_certificate_key ${KEY};
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_buffering off;
    }
}
EOF

echo "==> nginx -t"
nginx -t
systemctl enable nginx
systemctl restart nginx
systemctl --no-pager --full -l status nginx | head -20

echo "==> 本机探测"
curl -skI --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/" | head -15
ss -tlnp | grep -E ':80|:443' || true
echo "完成。Cloudflare 加密模式请改为「完全」(Full)，不要用「完全（严格）」直到换成 Origin CA。"
