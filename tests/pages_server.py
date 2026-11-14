from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from tournament.battles import ROOT


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT / "dist", **kwargs)

    def do_GET(self):
        prefix = "/pokemon-tcg-tournament/"
        if not self.path.startswith(prefix):
            self.send_error(404)
            return
        self.path = "/" + self.path[len(prefix) :]
        super().do_GET()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8005), Handler).serve_forever()
