"""Traffic-Sim 本機伺服器：提供靜態檔案，並讓網頁把專案 JSON 直接寫回 projects/。

僅供單人在本機使用（只聽 127.0.0.1）。部署給多人使用時需改用其他儲存方式。
用法：python server.py [port]
"""
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(ROOT, 'projects')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 存檔後重新讀取必須拿到最新內容
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/ping':
            return self.send_json(200, {'ok': True})
        super().do_GET()

    def do_POST(self):
        if self.path != '/api/save':
            return self.send_json(404, {'error': 'not found'})
        # 要求 JSON content-type（跨站表單無法送出）且來源必須是本頁，防止其他網站寫檔
        origin = self.headers.get('Origin')
        if not self.headers.get('Content-Type', '').startswith('application/json') or \
                (origin and origin != f'http://{self.headers.get("Host")}'):
            return self.send_json(403, {'error': 'forbidden'})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            rel, data = req['path'], req['data']
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {'error': 'bad request'})
        full = os.path.realpath(os.path.join(ROOT, rel))
        if not full.startswith(PROJECTS + os.sep) or not full.endswith('.json'):
            return self.send_json(403, {'error': 'path not allowed'})
        os.makedirs(os.path.dirname(full), exist_ok=True)
        tmp = full + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, full)  # 先寫暫存檔再替換，避免寫到一半的壞檔
        self.send_json(200, {'ok': True})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f'Serving Traffic-Sim at http://localhost:{port}  (Ctrl+C to stop)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
