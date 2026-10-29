import http.server, sys, functools
coi = len(sys.argv) > 2 and sys.argv[2] == 'coi'
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
    def end_headers(self):
        if coi:
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin'); self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
