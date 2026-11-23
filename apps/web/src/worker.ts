import { fromArrayBuffer } from 'geotiff';
import { convergenceL93, debutJourParis, type LonLat, type XY } from '@lumen/core';
import { altitude, ensoleillementAnnee, type Grille } from '@lumen/analysis';
import { construireVoirie, COUCHES, urlWms, type Troncon } from '@lumen/urban';
import type { Batiment } from '@lumen/core';

export type Requete =
  | { type: 'charger'; centre: XY; rayon: number; rayonDetail: number; rayonLoin: number; emprises: XY[][] }
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
  // Zone de détail (50 cm) autour de l'adresse.
  const nD = Math.round((2 * q.rayonDetail) / 0.5);
  const o = Math.round((nS - nD) / 2);
  const hD = new Float32Array(nD * nD);
  const cD = new Uint8Array(nD * nD);
  const bD = new Float32Array(nD * nD);
  for (let r = 0; r < nD; r++)
    for (let c = 0; c < nD; c++) {
      const i = (r + o) * nS + c + o;
      const k = classe[i]!;
      hD[r * nD + c] = masque[i] || k === 2 ? zS[i]! : solCell[i]!;
      bD[r * nD + c] = zS[i]!;
      cD[r * nD + c] = masque[i] ? 1 : k === 2 ? 2 : 0;
    }
  // Affichage : médiane 3×3 sur les toits (antennes et pics isolés du LiDAR ; le calcul garde la donnée brute).
  {
    const src = hD.slice(), v: number[] = [];
    for (let r = 1; r < nD - 1; r++)
      for (let c = 1; c < nD - 1; c++) {
        const i = r * nD + c;
        if (cD[i] !== 1) continue;
        v.length = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (cD[i + dr * nD + dc] === 1) v.push(src[i + dr * nD + dc]!);
        v.sort((a, b) => a - b);
        hD[i] = v[v.length >> 1]!;
      }
  }
  const bboxD = [bbox[0] + o * 0.5, bbox[3] - (o + nD) * 0.5, bbox[0] + (o + nD) * 0.5, bbox[3] - o * 0.5];
  post(
    { type: 'pret', n, res: 1, bbox, hauteurs, classes, mnt: zT.slice(), nT, couverture: 1 - trous / (nS * nS), detail: { n: nD, bbox: bboxD, hauteurs: hD, classes: cD, brut: bD } },
    [hauteurs.buffer, classes.buffer, hD.buffer, cD.buffer, bD.buffer],
  );

  // Zone lointaine : LiDAR à 8 m sur 2 km de rayon (silhouette de la ville, collines).
  const RL = q.rayonLoin, nL = Math.round((2 * RL) / 8);
  const bboxL: [number, number, number, number] = [q.centre.x - RL, q.centre.y - RL, q.centre.x + RL, q.centre.y + RL];
  const [zL, tL] = await Promise.all([raster(COUCHES.mns, bboxL, nL), raster(COUCHES.mnt, bboxL, nL)]);
  const cL = new Uint8Array(nL * nL);
  for (let i = 0; i < zL.length; i++) {
    if (Number.isNaN(tL[i]!)) tL[i] = 0;
    if (Number.isNaN(zL[i]!)) zL[i] = tL[i]!;
    cL[i] = zL[i]! - tL[i]! > 3 ? 1 : 0;
  }
  post({ type: 'loin', n: nL, bbox: bboxL, hauteurs: zL, classes: cL }, [zL.buffer, cL.buffer]);
}

function calculer(q: Extract<Requete, { type: 'calculer' }>) {
  if (!mns) throw new Error('Données non chargées');
  const t0 = performance.now();
  // Le contour cadastral et le LiDAR peuvent être décalés (corniches, recalage) : on avance chaque point
  // vers la rue jusqu'à sortir du volume mesuré de l'immeuble, pour ne pas compter son propre toit comme obstacle.
  // azimut vrai → direction dans la grille Lambert-93
  const az = ((q.azimut + convergenceL93(q.lieu.lon)) * Math.PI) / 180, nx = Math.sin(az), ny = Math.cos(az);
  const points = q.points.map((o) => {
    for (let t = 0; t <= 3; t += 0.25) {
      const x = o.x + nx * t, y = o.y + ny * t;
      if (!(altitude(mns!, x, y) > o.z - 0.2)) return { x: x + nx * 0.3, y: y + ny * 0.3, z: o.z };
    }
    return o;
  });
  const r = ensoleillementAnnee({
    lieu: q.lieu,
    grille: mns,
    points,
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

