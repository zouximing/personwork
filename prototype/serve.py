"""Throwaway prototype server. Run: python prototype/serve.py"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial
import argparse

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="个人工作台原型，仅监听本机")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(SimpleHTTPRequestHandler, directory=str(root)))
    print(f"Prototype: http://127.0.0.1:{args.port}/?variant=A", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
