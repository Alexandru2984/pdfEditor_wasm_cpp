"""
Django settings for pdf_backend project.

All secrets are loaded from .env via python-dotenv.
The .env file lives ONLY on the server — the browser/Wasm frontend
has zero access to it (browser sandboxing prevents filesystem access).

SECURITY NOTE: Why .env MUST NEVER be exposed to the C++ Wasm frontend:
──────────────────────────────────────────────────────────────────────────
1. SECRET_KEY — if leaked, an attacker can forge session cookies and CSRF
   tokens, hijacking any user session.
2. DATABASE_URL — if leaked, an attacker gets direct database credentials
   and can read/write/delete all data.
3. API_AUTH_TOKEN — if leaked, anyone can impersonate authorized API clients.
4. WebAssembly runs inside a browser SANDBOX. It has no access to the server
   filesystem, no access to process.env, no access to fopen("/path/.env").
   The architecture is intentionally split: secrets live on Django (server),
   the frontend talks to Django over HTTP, and Django decides what to reveal.
──────────────────────────────────────────────────────────────────────────
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# ─── Load .env ──────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

# ─── Core Settings ──────────────────────────────────────
SECRET_KEY = os.getenv("SECRET_KEY", "fallback-insecure-key")
DEBUG = os.getenv("DEBUG", "False").lower() in ("true", "1", "yes")
ALLOWED_HOSTS = [
    h.strip() for h in os.getenv("ALLOWED_HOSTS", "localhost").split(",") if h.strip()
]

# ─── Installed Apps ─────────────────────────────────────
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "corsheaders",
    # Local
    "jobs",
]

# ─── Middleware ──────────────────────────────────────────
MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",  # MUST be first
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

# ─── CORS ───────────────────────────────────────────────
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:8080").split(",")
    if o.strip()
]

# ─── URL / WSGI ─────────────────────────────────────────
ROOT_URLCONF = "pdf_backend.urls"
WSGI_APPLICATION = "pdf_backend.wsgi.application"

# ─── Templates ──────────────────────────────────────────
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ─── Database ───────────────────────────────────────────
# Reads DATABASE_URL from .env. Default: SQLite.
_db_url = os.getenv("DATABASE_URL", "sqlite:///db.sqlite3")

if _db_url.startswith("sqlite"):
    # sqlite:///db.sqlite3 → absolute path relative to BASE_DIR
    _db_path = _db_url.replace("sqlite:///", "")
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / _db_path,
        }
    }
elif _db_url.startswith("postgres"):
    # postgres://user:pass@host:port/dbname
    from urllib.parse import urlparse

    _parsed = urlparse(_db_url)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": _parsed.path.lstrip("/"),
            "USER": _parsed.username or "",
            "PASSWORD": _parsed.password or "",
            "HOST": _parsed.hostname or "localhost",
            "PORT": str(_parsed.port or 5432),
        }
    }
else:
    raise ValueError(f"Unsupported DATABASE_URL scheme: {_db_url}")

# ─── Auth Password Validators ──────────────────────────
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ─── Internationalization ──────────────────────────────
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# ─── Static Files ──────────────────────────────────────
STATIC_URL = "static/"

# ─── Default PK ────────────────────────────────────────
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ─── Django REST Framework ─────────────────────────────
REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
    ],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
    ],
}

# ─── Custom Auth Token ─────────────────────────────────
# Simple bearer token for PoC — use JWT/OAuth2 in production
API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN", "dev-token")
