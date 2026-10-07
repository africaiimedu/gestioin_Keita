"""Application des cartes étudiantes AFRICAIIM."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import ROOT, base_url, charger_config, secret_session
from app.deps import Redirection
from app.routes.admin_routes import router as admin_router
from app.routes.cantine_routes import router as cantine_router
from app.routes.auth_routes import router as auth_router
from app.routes.espace_routes import router as espace_router
from app.routes.inscription_routes import router as inscription_router
from app.routes.menu_routes import router as menu_router
from app.routes.public_routes import router as public_router
from app.routes.securite_routes import router as securite_router
from app.routes.studio_routes import router as studio_router
from app.seed import initialiser, verifier_base

_PAGE_404 = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Page introuvable</title></head>
<body style="font-family:Georgia,serif;background:#F4F1EA;color:#004C22;padding:3rem">
<h1>Page introuvable</h1>
<p><a href="/login">Retour à la connexion</a></p>
</body></html>"""


@asynccontextmanager
async def duree_de_vie(_app: FastAPI):
    verifier_base()
    initialiser()
    yield


app = FastAPI(title="AFRICAIIM Cartes", docs_url=None, redoc_url=None, openapi_url=None, lifespan=duree_de_vie)
app.add_middleware(
    SessionMiddleware,
    secret_key=secret_session(),
    session_cookie="africard",
    same_site="lax",
    https_only=base_url().startswith("https://"),
    max_age=8 * 3600,
)

app.include_router(auth_router)
app.include_router(cantine_router)
app.include_router(menu_router)
app.include_router(studio_router)
app.include_router(admin_router)
app.include_router(espace_router)
app.include_router(public_router)
app.include_router(securite_router)
app.include_router(inscription_router)
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")
app.mount("/fonts", StaticFiles(directory=str(ROOT / "fonts")), name="fonts")


@app.middleware("http")
async def entetes_securite(request, suite):
    reponse = await suite(request)
    reponse.headers["X-Content-Type-Options"] = "nosniff"
    reponse.headers["X-Frame-Options"] = "DENY"
    reponse.headers["Referrer-Policy"] = "same-origin"
    reponse.headers["X-Robots-Tag"] = "noindex, nofollow"
    return reponse


@app.exception_handler(Redirection)
async def rediriger(_request, exc: Redirection):
    return RedirectResponse(exc.url, status_code=303)


@app.exception_handler(404)
async def page_absente(_request, _exc):
    return HTMLResponse(_PAGE_404, status_code=404)


@app.get("/theme.css")
def theme():
    couleurs = charger_config()["couleurs"]
    css = (
        ":root{"
        f"--vert:{couleurs['vert']};"
        f"--or:{couleurs['or']};"
        f"--gris:{couleurs['gris']};"
        f"--gris-clair:{couleurs['gris_clair']};"
        f"--creme:{couleurs['creme']};"
        f"--blanc:{couleurs['blanc']};"
        "}"
    )
    return Response(css, media_type="text/css")
