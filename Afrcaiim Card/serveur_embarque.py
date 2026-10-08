"""Lancement par l'application Scolarité (même site, même dossier, sans sous-domaine).

Usage : python serveur_embarque.py /chemin/du/socket
L'application écoute sur un socket Unix privé ; elle s'arrête si la Scolarité disparaît.
"""

import os
import sys
import threading
import time

import uvicorn


def surveiller_parent(parent: int) -> None:
    while os.getppid() == parent:
        time.sleep(5)
    os._exit(0)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage : python serveur_embarque.py /chemin/du/socket")
    threading.Thread(target=surveiller_parent, args=(os.getppid(),), daemon=True).start()
    uvicorn.run(
        "app.main:app",
        uds=sys.argv[1],
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=False,
        log_level="warning",
    )
