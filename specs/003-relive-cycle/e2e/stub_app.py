"""Test application and stub supplier for the Relive end-to-end check (T082).

    python stub_app.py [--app-port 9003] [--supplier-port 9500] [--proxy http://127.0.0.2:443]

The app is a project behind ALFRED's reverse proxy (settings: core-service:8083:9003). It sends
its supplier calls through ALFRED's forward proxy to the stub supplier, which counts what it
receives:

    POST /login   -> {"token": ...}                      no supplier call
    POST /search  -> Supplier A, B and C in parallel      /supplierA /supplierB /supplierC
    POST /price   -> Supplier B                           /price
    POST /book    -> 200, or 500 while /__fail_book is on

Stub supplier control (direct, not through the proxy):
    GET  /__count       per-path request counts
    POST /__reset       zero the counts
App control:
    POST /__fail_book   body "on" or "off"
"""

import argparse
import json
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COUNTS = {}
COUNT_LOCK = threading.Lock()
STATE = {'fail_book': False}


def body_of(handler):
    length = int(handler.headers.get('Content-Length') or 0)
    return handler.rfile.read(length) if length else b''


def reply(handler, status, doc):
    data = json.dumps(doc).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Supplier(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/__count':
            with COUNT_LOCK:
                return reply(self, 200, dict(COUNTS))
        reply(self, 404, {})

    def do_POST(self):
        raw = body_of(self)
        if self.path == '/__reset':
            with COUNT_LOCK:
                COUNTS.clear()
            return reply(self, 200, {})
        with COUNT_LOCK:
            COUNTS[self.path] = COUNTS.get(self.path, 0) + 1
        try:
            request = json.loads(raw or b'{}')
        except ValueError:
            request = {}
        name = self.path.strip('/')
        reply(self, 200, {'supplier': name, 'live': True, 'echo': request,
                          'fares': [{'id': name + '-1', 'total': 100 + len(name)}]})


class App(BaseHTTPRequestHandler):
    supplier = None
    opener = None

    def log_message(self, *args):
        pass

    def call(self, path, doc):
        request = urllib.request.Request(self.supplier + path, data=json.dumps(doc).encode('utf-8'),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with self.opener.open(request, timeout=40) as response:
                return response.status, json.loads(response.read() or b'null')
        except urllib.error.HTTPError as error:
            text = error.read().decode('utf-8', 'replace')
            try:
                return error.code, json.loads(text)
            except ValueError:
                return error.code, text

    def do_POST(self):
        raw = body_of(self)
        try:
            doc = json.loads(raw or b'{}')
        except ValueError:
            doc = {}
        if self.path == '/__fail_book':
            STATE['fail_book'] = raw.strip() == b'on'
            return reply(self, 200, STATE)
        if self.path == '/login':
            return reply(self, 200, {'token': 'tok-' + str(doc.get('user', 'guest'))})
        if self.path == '/search':
            query = {'from': doc.get('from'), 'to': doc.get('to'), 'date': doc.get('date')}
            with ThreadPoolExecutor(3) as pool:
                results = list(pool.map(lambda p: self.call(p, query), ['/supplierA', '/supplierB', '/supplierC']))
            return reply(self, 200, {'results': [{'status': s, 'body': b} for s, b in results]})
        if self.path == '/price':
            status, body = self.call('/price', {'fare': doc.get('fare')})
            return reply(self, 200 if status < 400 else 502, {'price': body})
        if self.path == '/book':
            if STATE['fail_book']:
                return reply(self, 500, {'error': 'booking failed'})
            return reply(self, 200, {'pnr': 'PNR' + str(doc.get('fare', 'X'))[-3:].upper(), 'fare': doc.get('fare')})
        reply(self, 404, {})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app-port', type=int, default=9003)
    parser.add_argument('--supplier-port', type=int, default=9500)
    parser.add_argument('--proxy', default='http://127.0.0.2:443')
    parser.add_argument('--supplier-host', default='host.docker.internal')
    args = parser.parse_args()
    App.supplier = f'http://{args.supplier_host}:{args.supplier_port}'
    App.opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': args.proxy, 'https': args.proxy}))
    supplier = ThreadingHTTPServer(('0.0.0.0', args.supplier_port), Supplier)
    threading.Thread(target=supplier.serve_forever, daemon=True).start()
    print(f'supplier on :{args.supplier_port}, app on :{args.app_port}, proxy {args.proxy}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', args.app_port), App).serve_forever()


if __name__ == '__main__':
    main()
