"""Contrôles qui ne demandent pas la base de données."""

import io
import zipfile
from datetime import date
from types import SimpleNamespace

from pypdf import PdfReader

from app.services.import_etudiants import analyser_lignes, controler_fiche, lire_tableau, validite_par_defaut
from app.services.pdf_carte import (
    A4_H,
    A4_W,
    CARD_H,
    CARD_W,
    charger_modele,
    image_code128,
    mm,
    pdf_individuel,
    positions_lot,
    taille_carte,
    url_qr,
)
from app.services.pdf_liste import pdf_liste_etudiants
from app.services.photos import normaliser_photo, photos_depuis_zip
from app.services.statut import statut_effectif


def test_compte_cantine_et_mail():
    from app.services.cantine import decision_repas
    from app.services.courrier import formater_francs, message_debit
    from app.services.import_etudiants import controler_email

    assert formater_francs(10000) == "10.000 GNF"
    assert controler_email("Amina.Diop@AfricaIIM.edu.gn") == "amina.diop@africaiim.edu.gn"
    try:
        controler_email("pas-un-mail")
        raise AssertionError("aurait dû refuser")
    except ValueError:
        pass
    assert decision_repas(5000, 10000, "amina.diop@africaiim.edu.gn", True).ok is False
    assert decision_repas(20000, 10000, "", True).ok is False
    assert decision_repas(20000, 10000, "amina.diop@africaiim.edu.gn", False).ok is False
    ok = decision_repas(20000, 10000, "amina.diop@africaiim.edu.gn", True)
    assert ok.ok is True
    sujet, corps = message_debit("Amina", "Diop", 10000, 40000)
    assert "10.000 GNF" in corps
    assert "débité" in corps
    assert "Amina Diop" in corps
    assert "débit" in sujet


def test_annee_scolaire_commence_en_septembre():
    from app.services.ecoles import annee_academique_courante, ecole_officielle

    assert annee_academique_courante(date(2026, 9, 29)) == "2026-2027"
    assert annee_academique_courante(date(2026, 8, 31)) == "2025-2026"
    assert ecole_officielle("africaiim tech") == "AFRICAIIM Tech"
    try:
        ecole_officielle("Université AFRICAIIM")
        raise AssertionError("aurait dû refuser")
    except ValueError:
        pass


def test_validite_une_annee_apres_la_rentree():
    assert validite_par_defaut("2026-2027") == date(2027, 8, 31)


def test_fiche_respecte_la_date_de_validite_fournie():
    """La date passée (API Université / formulaire) doit être conservée, pas écrasée."""
    fiche = controler_fiche(
        "Awa",
        "Camara",
        "UA26AT0001",
        "AFRICAIIM Tech",
        "2026-2027",
        "2029-08-31",
    )
    assert fiche.date_validite == date(2029, 8, 31)
    fiche2 = controler_fiche(
        "Awa",
        "Camara",
        "UA26AT0002",
        "AFRICAIIM Tech",
        "2026-2027",
        "31/08/2031",
    )
    assert fiche2.date_validite == date(2031, 8, 31)


def test_carte_active_perimee_s_affiche_expiree():
    assert statut_effectif("active", date(2020, 7, 31), date(2026, 9, 29)) == "expiree"
    assert statut_effectif("suspendue", date(2020, 7, 31), date(2026, 9, 29)) == "suspendue"


def test_fiche_refuse_un_matricule_bizarre():
    try:
        controler_fiche("Awa", "Ndiaye", "14", "Droit", "2026-2027")
        raise AssertionError("aurait dû refuser")
    except ValueError as exc:
        assert "matricule" in str(exc)


def test_import_signale_doublon_et_prenom_manquant():
    contenu = (
        "prenom;nom;matricule;ecole\n"
        "Moussa;Traoré;AIIM-2026-0143;AFRICAIIM Tech\n"
        ";Diallo;AIIM-2026-0145;AFRICAIIM Tech\n"
        "Moussa;Traoré;AIIM-2026-0143;AFRICAIIM Tech\n"
    ).encode()
    pretes, erreurs, _avertissements = analyser_lignes(
        lire_tableau(contenu, "essai.csv"),
        {"AIIM-2026-0001"},
    )
    assert len(pretes) == 1
    from app.services.ecoles import annee_academique_courante

    assert pretes[0][1].annee_academique == annee_academique_courante()
    assert pretes[0][1].date_validite == validite_par_defaut(annee_academique_courante())
    assert pretes[0][1].filiere == "AFRICAIIM Tech"
    assert any("prénom" in message for message in erreurs)
    assert any("double" in message for message in erreurs)


def test_zip_ne_sort_pas_du_fichier():
    tampon = io.BytesIO()
    with zipfile.ZipFile(tampon, "w") as archive:
        archive.writestr("../../secret.jpg", b"abc")
        archive.writestr("dossier/AIIM-2026-0143.JPG", b"photo")
    photos = photos_depuis_zip(tampon.getvalue())
    assert photos["AIIM-2026-0143"] == b"photo"
    assert "SECRET" in photos
    assert all("/" not in cle for cle in photos)


def _png(image) -> bytes:
    tampon = io.BytesIO()
    image.save(tampon, "PNG")
    return tampon.getvalue()


def test_photo_png_acceptee_sous_toutes_ses_formes():
    from PIL import Image

    def proche(blob: bytes, attendu: tuple[int, int, int]) -> bool:
        sortie = Image.open(io.BytesIO(normaliser_photo(blob)))
        assert sortie.format == "JPEG" and sortie.size == (1200, 1600)
        return all(abs(a - b) <= 3 for a, b in zip(sortie.getpixel((20, 20)), attendu))

    assert proche(_png(Image.new("RGB", (600, 800), (10, 120, 60))), (10, 120, 60))
    seize_bits = Image.new("I;16", (600, 800))
    seize_bits.putdata([32768] * (600 * 800))
    assert proche(_png(seize_bits), (128, 128, 128))
    transparent = Image.new("RGBA", (600, 800), (0, 0, 0, 0))
    assert proche(_png(transparent), (244, 241, 234))
    assert proche(_png(transparent.convert("P")), (244, 241, 234))
    assert proche(_png(Image.new("RGB", (4000, 3000), (200, 30, 30))), (200, 30, 30))

    try:
        tampon = io.BytesIO()
        Image.new("RGB", (400, 400)).save(tampon, "GIF")
        normaliser_photo(tampon.getvalue())
        raise AssertionError("aurait dû refuser")
    except ValueError as exc:
        assert "PNG" in str(exc)


def test_liste_des_etudiants_en_pdf():
    lignes = [
        {
            "etudiant": SimpleNamespace(
                nom=f"Diallo{rang}", prenom="Aïssatou", matricule=f"UA26AT{rang:04d}",
                filiere="AFRICAIIM Tech", annee_academique="2026-2027",
                photo_chemin="data/photos/1.jpg" if rang % 2 else None,
            ),
            "statut": "active" if rang % 3 else None,
        }
        for rang in range(1, 81)
    ]
    lecteur = PdfReader(io.BytesIO(pdf_liste_etudiants(lignes, ["AFRICAIIM Tech", "2026-2027"])))
    assert len(lecteur.pages) >= 2
    texte = "".join(page.extract_text() for page in lecteur.pages)
    assert "Liste des étudiants" in texte
    assert "80 étudiants" in texte and "AFRICAIIM Tech" in texte
    assert "UA26AT0001" in texte and "UA26AT0080" in texte
    assert "Aïssatou" in texte and "Sans carte" in texte and "Valide" in texte

    vide = PdfReader(io.BytesIO(pdf_liste_etudiants([], [])))
    assert "Aucun étudiant" in vide.pages[0].extract_text()


def test_huit_cartes_tiennent_sur_la_feuille():
    debord = mm(5)
    assert len(positions_lot()) == 8
    for x, y in positions_lot():
        assert x - debord > 0
        assert y - debord > 0
        assert x + CARD_W + debord < A4_W
        assert y + CARD_H + debord < A4_H


def test_atelier_personnel_valide_fonction():
    from app.routes.studio_routes import _valider_modele
    from app.services.pdf_carte import charger_modele_personnel

    modele = charger_modele_personnel()
    propre = _valider_modele(modele)
    assert propre["orientation"] == "portrait"
    champs = {obj.get("champ") for face in ("recto", "verso") for obj in propre[face] if obj.get("type") == "champ"}
    assert "fonction" in champs or "filiere" in champs


def test_badge_personnel_portrait():
    from app.services.pdf_carte import charger_modele_personnel, pdf_badge_personnel
    from app.services.photos import portrait_initiales

    modele = charger_modele_personnel()
    assert modele["orientation"] == "portrait"
    assert taille_carte(modele) == (CARD_H, CARD_W)
    personne = SimpleNamespace(
        prenom="Aissatou",
        nom="DIALLO",
        matricule="PERS260001",
        numero="PERS260001",
        filiere="Scolarité",
        fonction="Scolarité",
        annee_academique="2026-2027",
        date_validite=date(2027, 8, 31),
        email="aissatou.diallo@univ-africaiim.com",
        sexe="F",
    )
    pdf = pdf_badge_personnel(
        personne, portrait_initiales("Aissatou", "DIALLO"), "jeton-personnel", 1, "https://exemple.test",
    )
    lecteur = PdfReader(io.BytesIO(pdf))
    assert len(lecteur.pages) == 2
    boite = lecteur.pages[0].mediabox
    assert abs(float(boite.width) - CARD_H) < 0.2
    assert abs(float(boite.height) - CARD_W) < 0.2
    texte = "\n".join(page.extract_text() or "" for page in lecteur.pages)
    assert "DIALLO" in texte
    assert "BADGE" in texte.upper() or "PERSONNEL" in texte.upper()


def test_orientation_portrait():
    from app.routes.studio_routes import _valider_modele
    from app.services import pdf_carte

    assert pdf_carte.taille_carte({"orientation": "portrait"}) == (CARD_H, CARD_W)
    assert pdf_carte.taille_carte({"orientation": "paysage"}) == (CARD_W, CARD_H)
    modele = charger_modele()
    portrait = _valider_modele({**modele, "orientation": "portrait"})
    assert portrait["orientation"] == "portrait"

    def lire_portrait():
        return portrait

    original = pdf_carte.charger_modele
    pdf_carte.charger_modele = lire_portrait
    try:
        etudiant = SimpleNamespace(
            prenom="Amina",
            nom="Diop",
            matricule="AIIM-2026-0142",
            filiere="AFRICAIIM Business School",
            annee_academique="2026-2027",
            date_validite=date(2027, 8, 31),
            email="",
        )
        from app.services.photos import portrait_initiales

        pdf = pdf_individuel(etudiant, portrait_initiales("Amina", "Diop"), "jeton-test", 1, "https://exemple.test")
    finally:
        pdf_carte.charger_modele = original
    lecteur = PdfReader(io.BytesIO(pdf))
    boite = lecteur.pages[0].mediabox
    assert abs(float(boite.width) - CARD_H) < 0.2
    assert abs(float(boite.height) - CARD_W) < 0.2


def test_pdf_carte_a_la_taille_cr80():
    etudiant = SimpleNamespace(
        prenom="Amina",
        nom="Diop",
        matricule="AIIM-2026-0142",
        filiere="AFRICAIIM Business School",
        annee_academique="2026-2027",
        date_validite=date(2027, 7, 31),
    )
    from app.services.photos import portrait_initiales

    pdf = pdf_individuel(etudiant, portrait_initiales("Amina", "Diop"), "jeton-test", 1, "https://africaiim.com")
    lecteur = PdfReader(io.BytesIO(pdf))
    assert len(lecteur.pages) == 2
    boite = lecteur.pages[0].mediabox
    assert abs(float(boite.width) - CARD_W) < 0.2
    assert abs(float(boite.height) - CARD_H) < 0.2
    texte = "\n".join(page.extract_text() or "" for page in lecteur.pages)
    assert "DIOP" in texte
    assert "Amina" in texte
    assert "AFRICAIIM Business School" in texte
    assert "CARTE D'ÉTUDIANT" in texte.replace("\n", "")
    prefs = lecteur.trailer["/Root"]["/ViewerPreferences"]
    assert "DuplexFlipLongEdge" in str(prefs["/Duplex"])
    assert "t=jeton-test" in url_qr("https://africaiim.com", etudiant.matricule, "jeton-test")


def test_flash_qr_reconnu_sans_code_de_controle():
    from app.routes.securite_routes import _VERIF_LIEN

    jeton = "jeton-secret-de-vingt-car"
    lien = f"https://scolarite.univ-africaiim.com/portail/cartes/verif/UA26AT0001?t={jeton}"
    match = _VERIF_LIEN.search(lien)
    assert match is not None
    assert match.group(1) == "UA26AT0001"
    assert match.group(2) == jeton
    assert _VERIF_LIEN.search("/verif/AIIM-1?t=" + jeton)


def test_mot_de_passe_depart_etudiant():
    from app.services.comptes import mot_de_passe_depart, mots_de_passe_depart

    assert mot_de_passe_depart() in mots_de_passe_depart()
    assert "Africaiim2026@" in mots_de_passe_depart()


def test_feuille_a4_pour_toute_imprimante():
    from app.services.pdf_carte import pdf_feuille_a4, positions_paires, taille_carte
    from app.services.photos import portrait_initiales

    etudiant = SimpleNamespace(
        prenom="Amina", nom="Diop", matricule="AIIM-2026-0142", filiere="AFRICAIIM Business School",
        annee_academique="2026-2027", date_validite=date(2027, 7, 31), email="", sexe="F",
    )
    element = (etudiant, portrait_initiales("Amina", "Diop"), "jeton-test", 1)
    lecteur = PdfReader(io.BytesIO(pdf_feuille_a4([element], "https://africaiim.com", "Carte AIIM-2026-0142")))
    assert len(lecteur.pages) == 1
    boite = lecteur.pages[0].mediabox
    assert abs(float(boite.width) - A4_W) < 0.2 and abs(float(boite.height) - A4_H) < 0.2
    texte = lecteur.pages[0].extract_text()
    assert "DIOP" in texte and "100 %" in texte
    assert "Simplex" in str(lecteur.trailer["/Root"]["/ViewerPreferences"]["/Duplex"])

    for modele in ({"orientation": "paysage"}, {"orientation": "portrait"}):
        largeur, hauteur = taille_carte(modele)
        places = positions_paires(largeur, hauteur)
        assert len(places) >= 2
        for x, y in places:
            assert x >= mm(5) and x + 2 * largeur <= A4_W - mm(5)
            assert y >= mm(16)

    lot = PdfReader(io.BytesIO(pdf_feuille_a4([element] * 9, "https://africaiim.com", "Lot")))
    assert len(lot.pages) == 3


def test_imprimante_ordinaire_recoit_du_a4():
    from app.routes.admin_routes import _commande_lp

    bureau = {"PageSize": ["A4", "Letter", "Card"], "Duplex": ["None", "DuplexNoTumble"]}
    commande = _commande_lp("HP_Bureau", 1, False, "A4", bureau, "portrait")
    assert "media=A4" in commande and "PageSize=A4" in commande
    assert "PageSize=Card" not in commande
    assert "orientation-requested=3" in commande and "sides=one-sided" in commande


def test_sexe_choisit_etudiant_ou_etudiante():
    from app.services.import_etudiants import controler_fiche, lire_sexe
    from app.services.photos import portrait_initiales

    assert lire_sexe("Féminin") == "F"
    assert lire_sexe("Masculin") == "M"
    assert controler_fiche("Awa", "Camara", "AIIM-1", "AFRICAIIM Tech", "", sexe="F", sexe_obligatoire=True).sexe == "F"
    try:
        controler_fiche("Awa", "Camara", "AIIM-1", "AFRICAIIM Tech", "", sexe="", sexe_obligatoire=True)
        raise AssertionError("le sexe vide doit être refusé")
    except ValueError as exc:
        assert "Masculin" in str(exc)

    femme = SimpleNamespace(
        prenom="Awa", nom="Camara", matricule="AIIM-9",
        filiere="AFRICAIIM Tech", annee_academique="2026-2027",
        date_validite=date(2027, 8, 31), email="", sexe="F",
    )
    pdf = pdf_individuel(femme, portrait_initiales("Awa", "Camara"), "jeton-femme", 1, "https://exemple.test")
    texte = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf)).pages)
    compact = texte.replace("\n", "")
    assert "ÉTUDIANTE" in compact
    assert "Féminin" not in texte and "Masculin" not in texte


def test_police_grasse_italique():
    from app.services.pdf_carte import _nom_police, assurer_polices

    assurer_polices()
    assert _nom_police({"police": "serif", "gras": True, "italique": True}) == "DejaVuSerif-BoldItalic"
    assert _nom_police({"gras": True, "italique": True}) == "DejaVu-BoldOblique"


def test_controler_compte_personnel():
    import pytest

    from app.services.metier import controler_compte

    assert controler_compte("Porte.Nord", "Africaiim-porte", "Africaiim-porte", "securite") == (
        "porte.nord",
        "Africaiim-porte",
        "securite",
    )
    with pytest.raises(ValueError):
        controler_compte("ab", "motdepasse1", "motdepasse1", "securite")
    with pytest.raises(ValueError):
        controler_compte("cuisine", "motdepasse1", "motdepasse1", "admin")
    with pytest.raises(ValueError):
        controler_compte("cuisine", "court", "court", "cuisiniere")


def test_code_barres_png_et_modele():
    from app.routes.studio_routes import _valider_modele

    png = image_code128("AIIM-2026-0142")
    assert png.startswith(b"\x89PNG")
    assert len(png) > 200
    modele = _valider_modele(charger_modele())
    types = {obj["type"] for face in ("recto", "verso") for obj in modele[face]}
    assert {"photo", "qr", "codebarres", "image"} <= types
    barres = [obj for face in ("recto", "verso") for obj in modele[face] if obj["type"] == "codebarres"]
    assert all(obj.get("champ") == "controle" for obj in barres)
    from app.services.pdf_carte import code_controle
    assert code_controle("jeton-test") == code_controle("jeton-test")
    assert code_controle("jeton-test") != code_controle("autre")


def test_qr_personnalise_refuse_une_adresse():
    import copy
    from datetime import date

    import pytest

    from app.routes.studio_routes import _valider_modele
    from app.services.pdf_carte import _charge_qr, image_qr, url_qr

    modele = charger_modele()
    for face in ("recto", "verso"):
        for obj in modele[face]:
            if obj.get("type") == "qr":
                obj["contenu"] = "https://pirate.example/vol"
    with pytest.raises(ValueError):
        _valider_modele(copy.deepcopy(modele))

    for face in ("recto", "verso"):
        for obj in modele[face]:
            if obj.get("type") == "qr":
                obj["contenu"] = "matricule"
                obj["couleur"] = "#004C22"
                obj["fond"] = "#FFFFFF"
                obj["cadre"] = False
    propre = _valider_modele(copy.deepcopy(modele))
    qr = next(obj for face in ("recto", "verso") for obj in propre[face] if obj.get("contenu") == "matricule")
    assert qr["couleur"] == "#004C22"
    assert qr["cadre"] is False

    class Fiche:
        matricule = "AIIM-1"
        nom = "Test"
        prenom = "Jo"
        filiere = "AFRICAIIM Tech"
        email = ""
        annee_academique = "2026-2027"
        date_validite = date(2027, 8, 31)

    secret = url_qr("https://exemple.test", "AIIM-1", "jeton-secret")
    assert _charge_qr({"contenu": "securise"}, Fiche(), "jeton-secret", 1, "https://exemple.test") == secret
    assert "pirate" not in _charge_qr(
        {"contenu": "https://pirate.example/vol"}, Fiche(), "jeton-secret", 1, "https://exemple.test"
    )
    assert image_qr(secret, "#004C22", "#FFFFFF").startswith(b"\x89PNG")
    assert image_code128("AIIM-1", "#004C22", "#F4F1EA").startswith(b"\x89PNG")


def test_imprimantes_lues_en_francais_et_en_anglais():
    from app.routes.admin_routes import _analyser_imprimantes

    francais = _analyser_imprimantes(
        "l’imprimante EVOLIS_Primacy_2 est inactive, mais activée depuis Mon Oct  5 12:20:38 2026\n",
        "périphérique pour EVOLIS_Primacy_2\u00a0: usb://EVOLIS/Primacy%202?serial=1\n",
    )
    assert francais == [{
        "nom": "EVOLIS_Primacy_2",
        "etat": "prête",
        "primacy": True,
        "uri": "usb://EVOLIS/Primacy%202?serial=1",
    }]

    anglais = _analyser_imprimantes(
        "printer Bureau is idle. enabled since Mon\nprinter Archive disabled since Mon\n",
        "device for Bureau: ipp://bureau/ipp\ndevice for Archive: ipp://archive/ipp\n",
    )
    assert [imp["nom"] for imp in anglais] == ["Bureau", "Archive"]
    assert anglais[0]["etat"] == "prête"
    assert anglais[1]["etat"] == "arrêtée"
    assert anglais[0]["primacy"] is False


def test_impression_recto_verso_et_couleurs():
    from app.routes.admin_routes import _commande_lp

    choix = {
        "PageSize": ["CR80", "A4"],
        "Duplex": ["None", "DuplexNoTumble", "DuplexTumble"],
        "ColorModel": ["Gray", "RGB"],
        "Resolution": ["300dpi", "600dpi"],
    }
    avec = _commande_lp("Primacy_2", 1, True, "Custom.85.6x54mm", choix, "paysage")
    assert "sides=two-sided-long-edge" in avec
    assert "Duplex=DuplexNoTumble" in avec
    assert "PageSize=CR80" in avec
    assert "ColorModel=RGB" in avec
    assert "Resolution=600dpi" in avec
    assert "orientation-requested=5" in avec
    assert "print-color-mode=color" in avec
    assert "fit-to-page=false" in avec
    assert "sides=one-sided" not in avec
    assert "ColorModel=Gray" not in avec

    sans = _commande_lp("Primacy_2", 1, False, "Custom.85.6x54mm", choix, "paysage")
    assert "sides=one-sided" in sans
    evolis = {
        "PageSize": ["Card"],
        "Orientation": ["PORTRAIT", "LANDSCAPE_CC90"],
        "Duplex": ["NONE", "DuplexNoTumble"],
        "ColorModel": ["RGB"],
        "Resolution": ["300dpi", "600dpi", "1200dpi"],
        "FColorContrast": ["VAL10", "VAL16"],
        "BColorContrast": ["VAL10", "VAL16"],
        "FColorBrightness": ["VAL10"],
        "BColorBrightness": ["VAL10"],
        "GDuplexType": ["DUPLEX_CC", "DUPLEX_MM"],
        "FHalftoning": ["THRESHOLD", "FLOYD", "DITHERING"],
        "BHalftoning": ["THRESHOLD", "FLOYD", "DITHERING"],
        "FBlackManagement": ["NOBLACKPOINT", "ALLBLACKPOINT", "TEXTINBLACK"],
        "BBlackManagement": ["NOBLACKPOINT", "ALLBLACKPOINT", "TEXTINBLACK"],
        "IFColorProfileMode": ["DRIVERPROFILE", "NOPROFILE"],
        "IBColorProfileMode": ["DRIVERPROFILE", "NOPROFILE"],
        "IFColorProfile": ["STDPROFILE"],
        "IBColorProfile": ["STDPROFILE"],
        "GSmoothing": ["ADVSMOOTH", "NOSMOOTH"],
        "FPageRotate180": ["OFF", "ON"],
        "BPageRotate180": ["OFF", "ON"],
    }
    paysage = _commande_lp("EVOLIS_Primacy_2", 1, True, "Custom.85.6x54mm", evolis, "paysage")
    assert "PageSize=Card" in paysage
    assert "Orientation=LANDSCAPE_CC90" in paysage
    assert "orientation-requested=5" in paysage
    assert "Resolution=600dpi" in paysage
    assert "Resolution=1200dpi" not in paysage
    assert "FColorContrast=VAL10" in paysage
    assert "BColorContrast=VAL10" in paysage
    assert "FColorContrast=VAL16" not in paysage
    assert "FColorBrightness=VAL10" in paysage
    assert "BColorBrightness=VAL10" in paysage
    assert "GDuplexType=DUPLEX_CC" in paysage
    assert "FHalftoning=THRESHOLD" in paysage
    assert "BHalftoning=THRESHOLD" in paysage
    assert "FBlackManagement=ALLBLACKPOINT" in paysage
    assert "BBlackManagement=ALLBLACKPOINT" in paysage
    assert "IFColorProfileMode=DRIVERPROFILE" in paysage
    assert "IBColorProfileMode=DRIVERPROFILE" in paysage
    assert "IFColorProfile=STDPROFILE" in paysage
    assert "GSmoothing=ADVSMOOTH" in paysage
    assert "FPageRotate180=ON" in paysage
    assert "BPageRotate180=ON" in paysage
    assert "media=" not in "".join(paysage)
    portrait = _commande_lp("EVOLIS_Primacy_2", 1, True, "Custom.54x85.6mm", evolis, "portrait")
    assert "Orientation=PORTRAIT" in portrait
    assert "orientation-requested=3" in portrait
    assert "Orientation=LANDSCAPE_CC90" not in portrait
    assert "FPageRotate180=OFF" in portrait
    assert "BPageRotate180=OFF" in portrait
    assert "media=Custom.54x85.6mm" in portrait
    assert "Duplex=None" in sans
    assert "sides=two-sided-long-edge" not in sans

    etudiant = SimpleNamespace(
        prenom="Joseph",
        nom="TOUPOU",
        matricule="AIIM-4554",
        filiere="AFRICAIIM Business School",
        annee_academique="2026-2027",
        date_validite=date(2027, 8, 31),
        email="",
    )
    from app.services.photos import portrait_initiales

    pdf = pdf_individuel(etudiant, portrait_initiales("Joseph", "TOUPOU"), "jeton-test", 1, "https://exemple.test", True)
    lecteur = PdfReader(io.BytesIO(pdf))
    assert len(lecteur.pages) == 2
    assert "DuplexFlipLongEdge" in str(lecteur.trailer["/Root"]["/ViewerPreferences"]["/Duplex"])
    seul = pdf_individuel(etudiant, portrait_initiales("Joseph", "TOUPOU"), "jeton-test", 1, "https://exemple.test", False)
    lecteur_seul = PdfReader(io.BytesIO(seul))
    assert "Simplex" in str(lecteur_seul.trailer["/Root"]["/ViewerPreferences"]["/Duplex"])

    photo = portrait_initiales("Joseph", "TOUPOU")
    tourne = pdf_individuel(etudiant, photo, "jeton-test", 1, "https://exemple.test", True, True)
    pages = PdfReader(io.BytesIO(tourne)).pages
    assert b"-1 0 0 -1" not in pages[0].get_contents().get_data()
    assert b"-1 0 0 -1" in pages[1].get_contents().get_data()
    droit = pdf_individuel(etudiant, photo, "jeton-test", 1, "https://exemple.test", True, False)
    assert b"-1 0 0 -1" not in PdfReader(io.BytesIO(droit)).pages[1].get_contents().get_data()
