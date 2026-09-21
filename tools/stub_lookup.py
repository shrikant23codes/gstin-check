"""A stand-in for a commercial GSTIN API, for testing the lookup path end to end.

Run:  python3 tools/stub_lookup.py [port]
Answers every GET with a small JSON payload that looks like a typical provider
response, so the app's tolerant status mapping can be exercised without a real
API key. The numbers in it are fabricated — this is a test fixture, not data.
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        gstin = self.path.rstrip("/").split("/")[-1].upper()
        # Anything containing "BALAJI"/traders-style GSTIN reports composition,
        # everything else reports a regular taxpayer: two branches to test.
        composition = gstin.startswith("08")
        payload = {
            "error": False,
            "message": "Test fixture",
            "data": {
                "gstin": gstin,
                "lgnm": "SHREE BALAJI TRADERS" if composition else "HOTEL JAMMU HIMACHAL DHABA",
                "tradeNam": "SHREE BALAJI TRADERS" if composition else "HOTEL JAMMU HIMACHAL DHABA",
                "sts": "Active",
                "taxpayerType": "Composition" if composition else "Regular",
                "dty": "Composition" if composition else "Regular",
                "rgdt": "01/07/2017",
            },
        }
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter
        sys.stderr.write("stub %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8789
    print("stub lookup on http://127.0.0.1:%d" % port)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
