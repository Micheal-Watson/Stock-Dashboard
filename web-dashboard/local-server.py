"""
Lightweight API server for the stock dashboard.
Handles live data serving and watchlist management (add/remove tickers).

Run: python local-server.py
from the web-dashboard folder.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

BASE_DIR    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = os.path.join(BASE_DIR, "Python Script", "config.json")
DATA_FILE   = os.path.join(BASE_DIR, "Python Script", "stock_data.json")


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"[API] {self.address_string()} {fmt % args}")

    def send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type",  "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/data":
            try:
                self.send_json(200, read_json(DATA_FILE))
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        elif path == "/api/watchlist":
            try:
                cfg = read_json(CONFIG_FILE)
                self.send_json(200, {"stocks": cfg.get("stocks", [])})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/watchlist":
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))
            ticker = body.get("ticker", "").strip().upper()
            if not ticker:
                return self.send_json(400, {"error": "ticker required"})
            try:
                cfg = read_json(CONFIG_FILE)
                if ticker not in cfg["stocks"]:
                    cfg["stocks"].append(ticker)
                    write_json(CONFIG_FILE, cfg)
                self.send_json(200, {"stocks": cfg["stocks"]})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        # /api/watchlist/AAPL
        if path.startswith("/api/watchlist/"):
            ticker = path.split("/")[-1].upper()
            try:
                # Remove from config
                cfg = read_json(CONFIG_FILE)
                cfg["stocks"] = [s for s in cfg["stocks"] if s.upper() != ticker]
                write_json(CONFIG_FILE, cfg)

                # Remove from stock_data so it disappears immediately
                try:
                    data = read_json(DATA_FILE)
                    data.pop(ticker, None)
                    write_json(DATA_FILE, data)
                except Exception:
                    pass

                self.send_json(200, {"stocks": cfg["stocks"]})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
        else:
            self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    port = 5001
    print(f"Stock Dashboard API running on http://localhost:{port}")
    print(f"  Config : {CONFIG_FILE}")
    print(f"  Data   : {DATA_FILE}")
    HTTPServer(("", port), Handler).serve_forever()
