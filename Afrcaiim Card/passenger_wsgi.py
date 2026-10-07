"""Démarrage sur o2switch (cPanel « Setup Python App », Phusion Passenger).

Passenger attend une application WSGI : l'application FastAPI (ASGI) passe par a2wsgi.
Passenger n'envoie pas les événements de démarrage ASGI : la base est préparée ici.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from a2wsgi import ASGIMiddleware  # noqa: E402

from app.main import app  # noqa: E402
from app.seed import initialiser, verifier_base  # noqa: E402

verifier_base()
initialiser()

application = ASGIMiddleware(app)
