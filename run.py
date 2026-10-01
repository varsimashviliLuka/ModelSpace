"""
Development entry point.

Run:
    python run.py             # HTTP on port 5000
    python run.py --https     # HTTPS on port 5443 (requires certs/)

Generating self-signed dev certs (one-time setup):
    mkdir -p certs
    openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem \
        -out certs/cert.pem -days 365 -nodes \
        -subj "/C=US/ST=Dev/L=Dev/O=Dev/CN=localhost"

Meta Quest 3 VR requires HTTPS.  Point your Quest browser to:
    https://<your-local-ip>:5443
and accept the self-signed cert warning.
"""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from app import create_app  # noqa: E402 — after dotenv

app = create_app()


def _ssl_context():
    """Return an SSL context tuple (cert, key) or raise with instructions."""
    cert = app.config.get("SSL_CERT") or "certs/cert.pem"
    key  = app.config.get("SSL_KEY")  or "certs/key.pem"

    if not Path(cert).exists() or not Path(key).exists():
        print(
            "\n[ERROR] SSL certificates not found.\n"
            "Generate them with:\n\n"
            "  mkdir -p certs\n"
            "  openssl req -x509 -newkey rsa:4096 \\\n"
            "    -keyout certs/key.pem -out certs/cert.pem \\\n"
            "    -days 365 -nodes \\\n"
            '    -subj "/C=US/ST=Dev/L=Dev/O=Dev/CN=localhost"\n',
            file=sys.stderr,
        )
        sys.exit(1)

    return (cert, key)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ModelSpace dev server")
    parser.add_argument("--https", action="store_true", help="Run with HTTPS")
    parser.add_argument("--port", type=int, default=None, help="Override port")
    args = parser.parse_args()

    if args.https:
        port = args.port or 5443
        ssl  = _ssl_context()
        print(f"[HTTPS] Running on https://localhost:{port}  (SSL: {ssl[0]})")
        app.run(host="0.0.0.0", port=port, ssl_context=ssl, debug=app.debug)
    else:
        port = args.port or 5000
        print(f"[HTTP]  Running on http://localhost:{port}")
        app.run(host="0.0.0.0", port=port, debug=app.debug)
