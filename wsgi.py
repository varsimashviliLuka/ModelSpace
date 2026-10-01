"""
Production WSGI entry point.

Gunicorn example:
    gunicorn wsgi:application --workers 4 --bind 0.0.0.0:8000

Behind nginx, set X-Forwarded-Proto so Flask knows it is behind HTTPS:
    proxy_set_header X-Forwarded-Proto https;
"""

import os
from dotenv import load_dotenv

load_dotenv()
os.environ.setdefault("FLASK_ENV", "production")

from app import create_app  # noqa: E402

application = create_app("production")
