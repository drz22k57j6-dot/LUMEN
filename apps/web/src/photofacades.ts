// Façades réelles des immeubles non haussmanniens : photos de rue Panoramax (CC BY-SA) projetées
// sur la géométrie mesurée (contour IGN, gouttière LiDAR), puis figées dans un atlas compact.
//
// Pour chaque bande verticale de façade (8–12 cm), on garde la meilleure photo : façade dans le champ,
// vue de face, proche, non masquée par un autre bâtiment (test 2D sur les emprises IGN). Chaque pixel
// est projeté dans la photo (modèle sténopé, ou équirectangulaire pour les 360°) avec la position, le
// cap et l'angle de champ de la photo. Hors photo : teinte moyenne de la façade (signalée « générée »).
// Limites : voitures/arbres présents sur la photo restent visibles ; GPS ≈ 1–3 m.
import { convergenceL93, versL93, type LonLat, type XY } from '@lumen/core';
export interface TachePhoto {
  a: [number, number];
  b: [number, number];
  y: number;
  hGout: number;
  /** index du bâtiment dans `batis` */
  bat: number;
}

export interface PhotoRue {
  id: string;
  /** Position dans la scène (x est, z sud) et hauteur de l'objectif (m, repère scène). */
  x: number;
  z: number;
  y: number;
  /** Cap dans la grille Lambert-93 (degrés depuis le nord grille). */
  cap: number;
  hfov: number;
  equi: boolean;
  url: string;
  auteur: string;
  date: string;
  vehicule: boolean;
}

interface Pnx {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: Record<string, unknown> & { 'view:azimuth'?: number; datetime?: string; 'geovisio:producer'?: string; 'pers:interior_orientation'?: { field_of_view?: number; camera_manufacturer?: string } };
  assets: { sd?: { href: string } };
}

/** Photos Panoramax dans un carré autour d'un point (jusqu'à 1 500). */
export async function photosRue(
  centre: LonLat,
  rayon: number,
  versScene: (p: XY) => { x: number; z: number },
  solScene: (p: XY) => number,
): Promise<PhotoRue[]> {
  const dLat = rayon / 111_320, dLon = rayon / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  let url: string | null =
    `https://api.panoramax.xyz/api/search?bbox=${centre.lon - dLon},${centre.lat - dLat},${centre.lon + dLon},${centre.lat + dLat}&limit=500`;
  const out: PhotoRue[] = [];
  for (let page = 0; url && page < 3; page++) {
    const r: Response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) break;
    const j = (await r.json()) as { features: Pnx[]; links?: { rel: string; href: string }[] };
    for (const f of j.features) {
      const pr = f.properties, az = pr['view:azimuth'], io = pr['pers:interior_orientation'] ?? {};
      const sd = f.assets.sd?.href;
      if (typeof az !== 'number' || !sd) continue;
      const [lon, lat] = f.geometry.coordinates;
      const p = versL93({ lon, lat });
      const s = versScene(p);
      const vehicule = /imajing|ladybug|mosaic|trimble/i.test(io.camera_manufacturer ?? '');
      const hfov = io.field_of_view ?? 65; // téléphone sans métadonnée : ≈ 65°
      out.push({
        id: f.id,
        x: s.x,
        z: s.z,
        y: solScene(p) + (vehicule ? 2.5 : 1.6),
        cap: az + convergenceL93(lon),
        hfov,
        equi: hfov >= 359,
        url: sd,
        auteur: String(pr['geovisio:producer'] ?? 'Panoramax'),
        date: String(pr.datetime ?? '').slice(0, 10),
        vehicule,
      });
    }
    url = j.links?.find((l) => l.rel === 'next')?.href ?? null;
  }
  return out;
}

/** Index 2D des murs (emprises IGN) pour savoir si un bâtiment masque la façade. */
class Masques {
  private g = new Map<number, number[]>();
  private s: number[] = [];
  private cle = (i: number, j: number) => i * 100003 + j;
  ajouter(a: { x: number; z: number }, b: { x: number; z: number }, bat: number) {
    const id = this.s.length / 5;
    this.s.push(a.x, a.z, b.x, b.z, bat);
    for (let i = Math.floor(Math.min(a.x, b.x) / 10); i <= Math.floor(Math.max(a.x, b.x) / 10); i++)
      for (let j = Math.floor(Math.min(a.z, b.z) / 10); j <= Math.floor(Math.max(a.z, b.z) / 10); j++) {
        const k = this.cle(i, j), l = this.g.get(k);
        l ? l.push(id) : this.g.set(k, [id]);
      }
  }
  /** Le segment p→q coupe-t-il un mur (d'un autre bâtiment que `sauf`, ou du même avant la fin) ? */
  coupe(px: number, pz: number, qx: number, qz: number, sauf: number): boolean {
    const vus = new Set<number>();
    const steps = Math.ceil(Math.hypot(qx - px, qz - pz) / 8) + 1;
    for (let t = 0; t <= steps; t++) {
      const x = px + ((qx - px) * t) / steps, z = pz + ((qz - pz) * t) / steps;
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (const id of this.g.get(this.cle(Math.floor(x / 10) + di, Math.floor(z / 10) + dj)) ?? []) {
            if (vus.has(id)) continue;
            vus.add(id);
            const s = this.s, ax = s[id * 5]!, az = s[id * 5 + 1]!, bx = s[id * 5 + 2]!, bz = s[id * 5 + 3]!;
            if (s[id * 5 + 4] === sauf) continue;
            const d1x = qx - px, d1z = qz - pz, d2x = bx - ax, d2z = bz - az, den = d1x * d2z - d1z * d2x;
            if (Math.abs(den) < 1e-9) continue;
            const u = ((ax - px) * d2z - (az - pz) * d2x) / den, v = ((ax - px) * d1z - (az - pz) * d1x) / den;
            if (u > 0.02 && u < 0.98 && v >= 0 && v <= 1) return true;
          }
    }
    return false;
  }
}

/** Projette un point de la scène dans une photo ; renvoie (u, v) dans [0,1] ou null. */
function projeter(ph: PhotoRue, x: number, y: number, z: number, W: number, H: number): [number, number] | null {
  const a = (ph.cap * Math.PI) / 180;
  const fx = Math.sin(a), fz = -Math.cos(a), rx = Math.cos(a), rz = Math.sin(a);
  const dx = x - ph.x, dy = y - ph.y, dz = z - ph.z;
  const xc = dx * rx + dz * rz, zc = dx * fx + dz * fz, yc = dy;
  if (ph.equi) {
    const lon = Math.atan2(xc, zc), lat = Math.atan2(yc, Math.hypot(xc, zc));
    return [0.5 + lon / (2 * Math.PI), 0.5 - lat / Math.PI];
  }
  if (zc < 0.5) return null;
  const tx = Math.tan((ph.hfov * Math.PI) / 360), ty = tx * (H / W);
  const u = 0.5 + xc / zc / (2 * tx), v = 0.5 - yc / zc / (2 * ty);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
}

export interface Bati {
  contour: { x: number; z: number }[];
}

export interface ResultatPhotos {
  /** Atlas RGBA (2048²) et, par atlas, quads : positions (x,y,z ×4) et uv (×4). */
  atlas: { img: ImageData; pos: Float32Array; uv: Float32Array }[];
  couverture: number;
  auteurs: string[];
}

export async function facadesPhotos(
  taches: TachePhoto[],
  batis: Bati[],
  photos: PhotoRue[],
  mobile: boolean,
  progres: (f: number) => void,
): Promise<ResultatPhotos> {
  const res = mobile ? 0.12 : 0.08, TA = 2048, maxAtlas = mobile ? 2 : 4;
  const masques = new Masques();
  batis.forEach((b, k) => b.contour.forEach((p, i) => masques.ajouter(p, b.contour[(i + 1) % b.contour.length]!, k)));

  // 1. Choix de la meilleure photo par colonne (géométrie seule)
  type Plan = { t: TachePhoto; W: number; Hh: number; cols: Int32Array; nx: number; nz: number; w: number; h: number };
  const plans: Plan[] = [];
  for (const t of taches) {
    const [ax, az] = t.a, [bx, bz] = t.b;
    const W = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / W, dz = (bz - az) / W, nx = -dz, nz = dx;
    const w = Math.max(2, Math.round(W / res)), h = Math.max(2, Math.round(t.hGout / res));
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const cand = photos
      .map((p, i) => ({ p, i, d: Math.hypot(p.x - mx, p.z - mz), f: ((p.x - mx) * nx + (p.z - mz) * nz) / (Math.hypot(p.x - mx, p.z - mz) || 1) }))
      .filter((c) => c.d > 4 && c.d < 30 && c.f > 0.5) // vues de face et proches seulement
      .sort((a, b) => a.d / a.f - b.d / b.f)
      .slice(0, 8);
    const cols = new Int32Array(w).fill(-1);
    const bat = t.bat;
    const nb = Math.max(1, Math.round(W)); // une décision par mètre de façade
    for (let q = 0; q < nb; q++) {
      const s = ((q + 0.5) / nb) * W, px = ax + dx * s, pz = az + dz * s;
      let best = -1, bs = 0;
      for (const k of cand) {
        const p = k.p;
        const vx = px - p.x, vz = pz - p.z, d = Math.hypot(vx, vz);
        const face = -(vx * nx + vz * nz) / d;
        if (face < 0.5) continue;
        if (!projeter(p, px, t.y + Math.min(t.hGout, 6), pz, 16, 9) && !p.equi) continue; // dans le champ
        if (masques.coupe(p.x, p.z, px + nx * 0.3, pz + nz * 0.3, bat)) continue;
        const sc = (face / d) * (p.vehicule ? 1.4 : 1) * (p.equi ? 0.8 : 1);
        if (sc > bs) (bs = sc), (best = k.i);
      }
      for (let c = Math.floor((q / nb) * w); c < Math.floor(((q + 1) / nb) * w); c++) cols[c] = best;
    }
    plans.push({ t, W, Hh: t.hGout, cols, nx, nz, w, h });
  }

  // 2. Rangement en atlas (étagères)
  const atlas: { img: ImageData }[] = [];
  const place: { a: number; x: number; y: number }[] = [];
  let ax0 = 0, ay0 = 0, rang = 0;
  const neuf = () => {
    atlas.push({ img: new ImageData(TA, TA) });
    ax0 = ay0 = rang = 0;
  };
  neuf();
  const ordre = plans.map((_, i) => i).sort((a, b) => plans[b]!.h - plans[a]!.h);
  for (const i of ordre) {
    const p = plans[i]!, w = Math.min(p.w, TA), h = Math.min(p.h, TA);
    if (ax0 + w > TA) (ax0 = 0), (ay0 += rang), (rang = 0);
    if (ay0 + h > TA) {
      if (atlas.length >= maxAtlas) {
        place[i] = { a: -1, x: 0, y: 0 };
        continue;
      }
      neuf();
    }
    place[i] = { a: atlas.length - 1, x: ax0, y: ay0 };
    ax0 += w + 2;
    rang = Math.max(rang, h + 2);
  }

  // 3. Cuisson : une photo à la fois (mémoire iPhone)
  const parPhoto = new Map<number, number[]>();
  plans.forEach((p, i) => new Set(p.cols).forEach((k) => k >= 0 && (parPhoto.get(k) ?? parPhoto.set(k, []).get(k)!).push(i)));
  const somme = plans.map(() => [0, 0, 0, 0]);
  let fait = 0, couvert = 0, total = 0;
  const auteurs = new Set<string>();
  for (const [k, liste] of parPhoto) {
    const ph = photos[k]!;
    let px: ImageData;
    try {
      const bm = await createImageBitmap(await (await fetch(ph.url, { signal: AbortSignal.timeout(20000) })).blob());
      const c2 = new OffscreenCanvas(bm.width, bm.height);
      const x2 = c2.getContext('2d')!;
      x2.drawImage(bm, 0, 0);
      px = x2.getImageData(0, 0, bm.width, bm.height);
      bm.close();
    } catch {
      continue;
    }
    const { width: IW, height: IH, data: D } = px;
    let utile = false;
    for (const i of liste) {
      const P = plans[i]!, pl = place[i]!;
      if (pl.a < 0) continue;
      const A = atlas[pl.a]!.img.data, [ax, az] = P.t.a, [bx, bz] = P.t.b;
      const dx = (bx - ax) / P.W, dz = (bz - az) / P.W;
      for (let c = 0; c < Math.min(P.w, TA); c++) {
        if (P.cols[c] !== k) continue;
        const s = ((c + 0.5) / P.w) * P.W, x = ax + dx * s, z = az + dz * s;
        for (let r = 0; r < Math.min(P.h, TA); r++) {
          const y = P.t.y + P.Hh * (1 - (r + 0.5) / P.h);
          const uv = projeter(ph, x, y, z, IW, IH);
          if (!uv) continue;
          // bilinéaire
          const fx = uv[0] * (IW - 1), fy = uv[1] * (IH - 1), x0 = Math.floor(fx), y0 = Math.floor(fy);
          const x1 = Math.min(IW - 1, x0 + 1), y1 = Math.min(IH - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
          const o = ((pl.y + r) * TA + pl.x + c) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const v = (D[(y0 * IW + x0) * 4 + ch]! * (1 - tx) + D[(y0 * IW + x1) * 4 + ch]! * tx) * (1 - ty) + (D[(y1 * IW + x0) * 4 + ch]! * (1 - tx) + D[(y1 * IW + x1) * 4 + ch]! * tx) * ty;
            A[o + ch] = v;
            somme[i]![ch] = somme[i]![ch]! + v;
          }
          A[o + 3] = 255;
          somme[i]![3] = somme[i]![3]! + 1;
          utile = true;
        }
      }
    }
    if (utile) auteurs.add(ph.auteur);
    progres(++fait / parPhoto.size);
  }

  // 4. Zones sans photo : teinte moyenne de la façade (pixels alpha = 0)
  plans.forEach((P, i) => {
    const pl = place[i]!;
    if (pl.a < 0) return;
    const A = atlas[pl.a]!.img.data, s = somme[i]!;
    const moy = s[3]! ? [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!] : [168, 160, 148];
    for (let r = 0; r < Math.min(P.h, TA); r++)
      for (let c = 0; c < Math.min(P.w, TA); c++) {
        const o = ((pl.y + r) * TA + pl.x + c) * 4;
        total++;
        if (A[o + 3]) (couvert++, (A[o + 3] = 255));
        else (A[o] = moy[0]!), (A[o + 1] = moy[1]!), (A[o + 2] = moy[2]!), (A[o + 3] = 255);
      }
  });

  // 5. Quads (un lot par atlas)
  const sortie = atlas.map((at, ai) => {
    const pos: number[] = [], uv: number[] = [];
    plans.forEach((P, i) => {
      const pl = place[i]!;
      if (pl.a !== ai) return;
      const [ax, az] = P.t.a, [bx, bz] = P.t.b, y0 = P.t.y, y1 = P.t.y + P.Hh;
      const e = 0.04; // légèrement devant le volume LiDAR
      pos.push(ax + P.nx * e, y0, az + P.nz * e, bx + P.nx * e, y0, bz + P.nz * e, bx + P.nx * e, y1, bz + P.nz * e, ax + P.nx * e, y1, az + P.nz * e);
      const u0 = pl.x / TA, u1 = (pl.x + Math.min(P.w, TA)) / TA, v0 = 1 - (pl.y + Math.min(P.h, TA)) / TA, v1 = 1 - pl.y / TA;
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    });
    return { img: at.img, pos: new Float32Array(pos), uv: new Float32Array(uv) };
  });
  return { atlas: sortie, couverture: total ? couvert / total : 0, auteurs: [...auteurs] };
}
