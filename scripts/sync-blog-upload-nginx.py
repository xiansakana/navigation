#!/usr/bin/env python3
"""Configure streaming uploads and a maintenance switch on the origin HTTPS site."""
import pathlib
import re
import subprocess
import sys

START = '    # BEGIN navigation blog media upload'
END = '    # END navigation blog media upload'
BLOCK = r'''    # BEGIN navigation blog media upload
    location ~ "^/api/blog/posts/[a-f0-9]{32}/media$" {
        client_max_body_size 0;
        client_body_timeout 3600s;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
    # END navigation blog media upload
'''
BLOCK = BLOCK.replace('    # END navigation blog media upload', r'''    location ^~ /api/knowledge/ {
        client_max_body_size 20m;
        client_body_timeout 3600s;
        proxy_request_buffering off;
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
    # END navigation blog media upload''')
MAINTENANCE = '''    # BEGIN navigation maintenance
    if (-f /run/navigation/maintenance) {
        return 503 "Navigation is temporarily unavailable for maintenance. Please try again later.";
    }
    # END navigation maintenance
'''


def patch(text):
    marker = '    # BEGIN navigation maintenance'
    end = '    # END navigation maintenance'
    if marker in text or end in text:
        if text.count(marker) != 1 or text.count(end) != 1 or text.index(marker) >= text.index(end):
            raise ValueError('Invalid maintenance config markers')
        text = re.sub(re.escape(marker) + r'.*?' + re.escape(end) + r'\n?', lambda _: MAINTENANCE, text, count=1, flags=re.S)
    else:
        anchor = '    location / {'
        if text.count(anchor) != 1:
            raise ValueError('Expected one origin proxy location; refusing to change nginx config')
        text = text.replace(anchor, MAINTENANCE + '\n' + anchor, 1)
    if START in text:
        if text.count(START) != 1 or text.count(END) != 1:
            raise ValueError('Invalid blog upload config markers')
        return re.sub(re.escape(START) + r'.*?' + re.escape(END) + r'\n?', lambda _: BLOCK, text, count=1, flags=re.S)
    anchor = '    location / {'
    if text.count(anchor) != 1:
        raise ValueError('Expected one origin proxy location; refusing to change nginx config')
    return text.replace(anchor, BLOCK + '\n' + anchor, 1)


def main():
    site = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/etc/nginx/conf.d/saoyu-origin-https.conf')
    if not site.exists():
        print('blog upload nginx: origin HTTPS config absent, skipped')
        return
    original = site.read_text()
    updated = patch(original)
    if updated == original:
        print('blog upload nginx: already configured')
        return
    site.write_text(updated)
    if '--write-only' in sys.argv:
        print('blog upload nginx: config generated for origin HTTPS setup')
        return
    try:
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        site.write_text(original)
        raise
    print('blog upload nginx: streaming uploads configured')


if __name__ == '__main__':
    main()
