from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request, error
from urllib.parse import urlsplit
import sys
import os

BASE_DIR = Path(__file__).resolve().parent
TARGET_BASE = "https://eservices.minfin.fgov.be/ecad-backend-rest"
TARGET_BASISREGISTERS = "https://api.basisregisters.vlaanderen.be"
TARGET_NOMINATIM = "https://nominatim.openstreetmap.org"
TARGET_PHOTON = "https://photon.komoot.io"
PROXY_TARGETS = {
    "cadgis": TARGET_BASE,
    "basisregisters": TARGET_BASISREGISTERS,
    "nominatim": TARGET_NOMINATIM,
    "photon": TARGET_PHOTON,
}


class PerceelCheckerHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/proxy/"):
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/proxy/cadgis/"):
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/proxy/basisregisters/"):
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/proxy/nominatim/"):
            self.send_response(204)
            self.end_headers()
            return
        if self.path.startswith("/proxy/photon/"):
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/api/proxy/"):
            self._proxy_api_request("GET")
            return
        if self.path.startswith("/proxy/cadgis/"):
            self._proxy_request("GET")
            return
        if self.path.startswith("/proxy/basisregisters/"):
            self._proxy_request("GET", proxy_root="/proxy/basisregisters/", target_base=TARGET_BASISREGISTERS)
            return
        if self.path.startswith("/proxy/nominatim/"):
            self._proxy_request("GET", proxy_root="/proxy/nominatim/", target_base=TARGET_NOMINATIM)
            return
        if self.path.startswith("/proxy/photon/"):
            self._proxy_request("GET", proxy_root="/proxy/photon/", target_base=TARGET_PHOTON)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/proxy/"):
            self._proxy_api_request("POST")
            return
        if self.path.startswith("/proxy/cadgis/"):
            self._proxy_request("POST")
            return
        if self.path.startswith("/proxy/basisregisters/"):
            self._proxy_request("POST", proxy_root="/proxy/basisregisters/", target_base=TARGET_BASISREGISTERS)
            return
        self.send_error(404)

    def _proxy_api_request(self, method):
        route = self.path[len("/api/proxy/"):]
        service, separator, suffix = route.partition("/")
        target_base = PROXY_TARGETS.get(service)
        if not target_base or not separator or not suffix:
            self.send_error(400, "Onbekende of onvolledige proxyroute")
            return
        self._proxy_request(method, proxy_root=f"/api/proxy/{service}/", target_base=target_base)

    def _proxy_request(self, method, proxy_root="/proxy/cadgis/", target_base=TARGET_BASE):
        suffix = self.path[len(proxy_root):]
        target = f"{target_base}/{suffix}"

        payload = None
        if method == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            payload = self.rfile.read(length) if length else None

        headers = {
            "User-Agent": self.headers.get("User-Agent", "Mozilla/5.0"),
            "Accept": self.headers.get("Accept", "application/json"),
            "Content-Type": self.headers.get("Content-Type", "application/json"),
        }

        try:
            req = request.Request(target, data=payload, headers=headers, method=method)
            with request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get_content_type()
                charset = resp.headers.get_content_charset() or "utf-8"
                self.send_header("Content-Type", f"{ctype}; charset={charset}" if ctype.startswith("text/") or ctype == "application/json" else ctype)
                self.end_headers()
                self.wfile.write(body)
        except error.HTTPError as exc:
            body = exc.read() if hasattr(exc, "read") else b""
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get_content_type() if exc.headers else "text/plain")
            self.end_headers()
            self.wfile.write(body or f"HTTP {exc.code}".encode("utf-8"))
        except Exception as exc:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(str(exc).encode("utf-8"))


if __name__ == "__main__":
    port = 8766
    if len(sys.argv) > 1:
      try:
          port = int(sys.argv[1])
      except ValueError:
          print(f"Ongeldige poort '{sys.argv[1]}', fallback naar {port}")
    os.chdir(BASE_DIR)
    server = ThreadingHTTPServer(("127.0.0.1", port), PerceelCheckerHandler)
    print(f"Serving on http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
