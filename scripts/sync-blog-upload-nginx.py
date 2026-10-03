#!/usr/bin/env python3
"""Allow streaming blog media uploads through the existing origin HTTPS site."""
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


def patch(text):
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
