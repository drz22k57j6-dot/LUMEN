import { fromArrayBuffer } from 'geotiff';
import { debutJourParis, type LonLat, type XY } from '@lumen/core';
import { ensoleillementAnnee, type Grille } from '@lumen/analysis';
import { construireVoirie, COUCHES, urlWms, type Troncon } from '@lumen/urban';
import type { Batiment } from '@lumen/core';

export type Requete =
  | { type: 'charger'; centre: XY; rayon: number; emprises: XY[][] }
  | { type: 'voirie'; troncons: Troncon[]; batiments: Batiment[]; emprise: [number, number, number, number] }
  | { type: 'calculer'; lieu: LonLat; points: { x: number; y: number; z: number }[]; azimut: number; annee: number };

let mns: Grille | null = null;

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

async function raster(couche: string, bbox: [number, number, number, number], n: number): Promise<Float32Array> {
  const r = await fetch(urlWms(couche, bbox, n, n, 'image/geotiff'));
  if (!r.ok) throw new Error(`LiDAR indisponible (${r.status})`);
  const tif = await fromArrayBuffer(await r.arrayBuffer());
  const img = await tif.getImage();
  const [bande] = (await img.readRasters()) as unknown as Float32Array[];
  const z = new Float32Array(bande!);
  for (let i = 0; i < z.length; i++) if (!(z[i]! > -100 && z[i]! < 5000)) z[i] = NaN; // nodata (ZICAD)
  return z;
}

async function charger(q: Extract<Requete, { type: 'charger' }>) {
  const R = q.rayon;
  const bbox: [number, number, number, number] = [q.centre.x - R, q.centre.y - R, q.centre.x + R, q.centre.y + R];
  const nS = Math.round((2 * R) / 0.5); // MNS à 50 cm
  const nT = Math.round((2 * R) / 2); // MNT à 2 m
  post({ type: 'etape', texte: 'Téléchargement du LiDAR IGN…' });
  const [zS, zT] = await Promise.all([raster(COUCHES.mns, bbox, nS), raster(COUCHES.mnt, bbox, nT)]);
  post({ type: 'etape', texte: 'Analyse des toits et de la végétation…' });

  // Masque des emprises de bâtiments BD TOPO.
  const masque = new Uint8Array(nS * nS);
  if (typeof OffscreenCanvas !== 'undefined') {
    const cv = new OffscreenCanvas(nS, nS);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#fff';
    for (const e of q.emprises) {
      ctx.beginPath();
      e.forEach((p, i) => {
        const px = (p.x - bbox[0]) / 0.5, py = (bbox[3] - p.y) / 0.5;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
    }
    const d = ctx.getImageData(0, 0, nS, nS).data;
    for (let i = 0; i < masque.length; i++) masque[i] = d[i * 4]! > 127 ? 1 : 0;
  }

  // Emprises dilatées de 1,5 m : les bords de toits mesurés par le LiDAR ne sont pas de la végétation.
  const pres = new Uint8Array(masque);
  for (let passe = 0; passe < 3; passe++) {
    const src = pres.slice();
    for (let r = 1; r < nS - 1; r++)
      for (let c = 1; c < nS - 1; c++) {
        const i = r * nS + c;
        if (!src[i] && (src[i - 1] || src[i + 1] || src[i - nS] || src[i + nS])) pres[i] = 1;
      }
  }

  // Classification : bâtiment (emprise), végétation (> 2,5 m au-dessus du sol, hors bâti), sol.
  const classe = new Uint8Array(nS * nS);
  const solCell = new Float32Array(nS * nS);
  let zMax = -Infinity;
  let trous = 0;
  for (let r = 0; r < nS; r++)
    for (let c = 0; c < nS; c++) {
      const i = r * nS + c;
      let z = zS[i]!;
      let sol = zT[Math.min(nT - 1, r >> 2) * nT + Math.min(nT - 1, c >> 2)]!;
      if (Number.isNaN(sol)) sol = Number.isNaN(z) ? 0 : z;
      solCell[i] = sol;
      if (Number.isNaN(z)) {
        trous++;
        z = zS[i] = sol;
      }
      if (z > zMax) zMax = z;
      classe[i] = masque[i] ? 1 : pres[i] ? (z - sol > 2.5 ? 1 : 0) : z - sol > 2.5 ? 2 : 0;
    }
  mns = { x0: bbox[0], y0: bbox[3], res: 0.5, w: nS, h: nS, z: zS, classe, zMax };

  // Maillage d'affichage à 1 m : toits et arbres au LiDAR, rues aplanies au sol (MNT).
  const n = nS / 2;
  const hauteurs = new Float32Array(n * n);
  const classes = new Uint8Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let bat = -Infinity, veg = -Infinity, sol = 0, nb = 0, nv = 0;
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
        const i = (2 * r + dr) * nS + 2 * c + dc;
        if (masque[i]) (bat = Math.max(bat, zS[i]!)), nb++;
        else if (classe[i] === 2) (veg = Math.max(veg, zS[i]!)), nv++;
        sol += solCell[i]! / 4;
      }
      const k = r * n + c;
      if (nb === 4) (hauteurs[k] = bat), (classes[k] = 1);
      else if (nv >= 2) (hauteurs[k] = veg), (classes[k] = 2);
      else (hauteurs[k] = sol), (classes[k] = 0);
    }
  post(
    { type: 'pret', n, res: 1, bbox, hauteurs, classes, mnt: zT.slice(), nT, couverture: 1 - trous / (nS * nS) },
    [hauteurs.buffer, classes.buffer],
  );
}

function calculer(q: Extract<Requete, { type: 'calculer' }>) {
  if (!mns) throw new Error('Données non chargées');
  const t0 = performance.now();
  const r = ensoleillementAnnee({
    lieu: q.lieu,
    grille: mns,
    points: q.points,
    azimutFacade: q.azimut,
    annee: q.annee,
    debutJour: debutJourParis,
    progression: (f) => post({ type: 'progression', f }),
  });
  post({ type: 'resultat', ...r, ms: performance.now() - t0 }, [r.codes.buffer]);
}

self.onmessage = async (e: MessageEvent<Requete>) => {
  try {
    if (e.data.type === 'charger') await charger(e.data);
    else if (e.data.type === 'voirie') post({ type: 'voirie', v: construireVoirie(e.data.troncons, e.data.batiments, { emprise: e.data.emprise }) });
    else calculer(e.data);
  } catch (err) {
    post({ type: 'erreur', texte: (err as Error).message });
  }
};

