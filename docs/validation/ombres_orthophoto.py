"""
Validation des ombres Lumen contre l'orthophoto IGN (BD ORTHO 20 cm, Paris 2024).
Principe : les ombres au sol visibles sur la photo aérienne sont comparées aux ombres calculées
(même méthode que Lumen : lancer de rayons vers le soleil sur le LiDAR HD MNS 50 cm, position du soleil NREL SPA)
au jour exact du vol (graphe de mosaïquage IGN). L'heure du vol n'étant pas publiée, elle est la seule inconnue :
on balaie la journée et on garde le meilleur accord, puis on mesure l'accord et la netteté du pic.
"""
import io, json, sys, urllib.parse, urllib.request
import numpy as np
from PIL import Image
import pandas as pd, pvlib
from pyproj import Transformer
from skimage.filters import threshold_otsu
from scipy.ndimage import binary_dilation

GEOPF = "https://data.geopf.fr"
RES, TAILLE = 0.5, 400  # m
N = int(TAILLE / RES)
vers_wgs = Transformer.from_crs(2154, 4326, always_xy=True)

def wms(couche, bbox, n, fmt):
    q = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS=couche, STYLES="", CRS="EPSG:2154",
             BBOX=",".join(map(str, bbox)), WIDTH=n, HEIGHT=n, FORMAT=fmt)
    return urllib.request.urlopen(f"{GEOPF}/wms-r/wms?" + urllib.parse.urlencode(q), timeout=90).read()

def grille(couche, bbox):
    return np.frombuffer(wms(couche, bbox, N, "image/x-bil;bits=32"), dtype="<f4").reshape(N, N).astype(np.float64)

def date_vol(lon, lat):
    q = dict(SERVICE="WFS", VERSION="2.0.0", REQUEST="GetFeature", TYPENAMES="ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE:graphe_bdortho",
             OUTPUTFORMAT="application/json", COUNT=1, CQL_FILTER=f"INTERSECTS(the_geom,POINT({lat} {lon}))")
    try:
        f = json.load(urllib.request.urlopen(f"{GEOPF}/wfs/ows?" + urllib.parse.urlencode(q), timeout=60))["features"]
        return f[0]["properties"]["date_vol"][:10] if f else None
    except Exception:
        return None

def ombres(mns, az, el):
    """Ombre portée au sol : un pixel est à l'ombre si le MNS dépasse le rayon vers le soleil (Lumen : même principe)."""
    a, t = np.radians(az), np.tan(np.radians(el))
    dx, dy = np.sin(a), -np.cos(a)  # colonnes vers l'est, lignes vers le sud
    om = np.zeros_like(mns, bool)
    hmax = float(np.nanmax(mns) - np.nanmin(mns)) + 1
    for k in range(1, int(min(150, hmax / max(t, 0.05)) / RES) + 1):
        s = k * RES
        c, r = int(round(dx * k)), int(round(dy * k))
        dec = np.full_like(mns, -1e9)
        rs, re_ = max(0, -r), min(N, N - r); cs, ce = max(0, -c), min(N, N - c)
        dec[rs:re_, cs:ce] = mns[rs + r:re_ + r, cs + c:ce + c]
        om |= dec > mns + s * t + 0.3
    return om

def site(nom, x, y):
    bbox = [x - TAILLE / 2, y - TAILLE / 2, x + TAILLE / 2, y + TAILLE / 2]
    lon, lat = vers_wgs.transform(x, y)
    jour = date_vol(lon, lat) or "2024-08-27"
    mns = grille("IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93", bbox)
    mnt = grille("IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93", bbox)
    photo = Image.open(io.BytesIO(wms("HR.ORTHOIMAGERY.ORTHOPHOTOS", bbox, 2000, "image/jpeg"))).convert("RGB").resize((N, N), Image.BILINEAR)
    rgb = np.asarray(photo, float) / 255
    lum = rgb @ [0.299, 0.587, 0.114]
    sat = rgb.max(2) - rgb.min(2)
    cos = np.asarray(Image.open(io.BytesIO(wms("IGNF_COSIA_2024-2026", bbox, N, "image/png"))).convert("RGB"), int)
    eau = (np.abs(cos - [51, 117, 161]).sum(2) < 40) | (np.abs(cos - [98, 208, 255]).sum(2) < 40)
    # Sol nu (ni bâtiment, ni arbre, ni voiture), hors eau, loin des bords d'immeubles (la photo n'est pas une
    # « vraie ortho » : les immeubles penchent de quelques mètres et masquent le pied des façades).
    sol = (mns - mnt < 0.4) & ~eau
    hauts = mns - mnt > 2.5
    sol_loin = sol & ~binary_dilation(hauts, iterations=8)  # > 4 m des bâtiments et arbres
    seuil = threshold_otsu(lum[sol])
    obs = (lum < seuil) & (sat < 0.25)
    res = []
    def evaluer(h):
        t = pd.Timestamp(f"{jour} 00:00", tz="UTC") + pd.Timedelta(hours=float(h))
        sp = pvlib.solarposition.spa_python(t, lat, lon, altitude=mnt.mean())
        el, az = float(sp["apparent_elevation"].iloc[0]), float(sp["azimuth"].iloc[0])
        if el < 5:
            return
        pred = ombres(mns, az, el)
        m = sol_loin
        tp = (pred & obs & m).sum(); fp = (pred & ~obs & m).sum(); fn = (~pred & obs & m).sum(); tn = (~pred & ~obs & m).sum()
        res.append(dict(h=h, az=az, el=el, iou=tp / max(1, tp + fp + fn), acc=(tp + tn) / max(1, m.sum())))
    for h in np.arange(7.0, 16.01, 0.25):  # heure UTC, pas de 15 min
        evaluer(h)
    h0 = max(res, key=lambda r: r["iou"])["h"]
    for h in np.arange(h0 - 0.5, h0 + 0.51, 1 / 12):  # affinage, pas de 5 min
        evaluer(h)
    df = pd.DataFrame(res).sort_values("h")
    b = df.loc[df.iou.idxmax()]
    # netteté : écart d'heure (min) pour lequel l'accord perd 10 % de sa valeur
    proche = df[df.iou >= b.iou * 0.9]
    largeur = (proche.h.max() - proche.h.min()) * 60
    def iou_a(dh):
        d = df.iloc[(df.h - (b.h + dh)).abs().argsort()[:1]]
        return round(float(d.iou.iloc[0]), 3)
    pred = ombres(mns, b.az, b.el)
    # image de contrôle : vert = accord ombre, rouge = ombre calculée seule, bleu = ombre photo seule
    v = (np.asarray(photo, float) * 0.55).astype(np.uint8)
    v[pred & obs & sol_loin] = [40, 220, 60]; v[pred & ~obs & sol_loin] = [230, 40, 40]; v[~pred & obs & sol_loin] = [40, 90, 255]
    Image.fromarray(v).save(f"controle_{nom}.png")
    heure_paris = (pd.Timestamp(f"{jour}", tz="UTC") + pd.Timedelta(hours=float(b.h))).tz_convert("Europe/Paris").strftime("%H:%M")
    return dict(site=nom, jour=jour, heure_vol_deduite=heure_paris, soleil=f"az {b.az:.1f}° / haut. {b.el:.1f}°",
                iou=round(b.iou, 3), exactitude=round(b.acc, 3), pic_min=round(largeur), iou_moins1h=iou_a(-1), iou_plus1h=iou_a(1),
                iou_pire=round(float(df.iou.min()), 3), part_ombre_photo=round(float((obs & sol_loin).sum() / sol_loin.sum()), 3), pixels=int(sol_loin.sum()))

if __name__ == "__main__":
    sites = json.loads(sys.argv[1])
    out = [site(n, x, y) for n, x, y in sites]
    print(json.dumps(out, ensure_ascii=False, indent=1))
