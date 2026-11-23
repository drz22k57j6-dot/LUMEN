import type { LonLat } from '@lumen/core';
import { positionSoleil, directionSoleil } from './index';

/**
 * Grille d'altitude (MNS LiDAR HD) en Lambert-93.
 * (x0, y0) = coin haut-gauche du pixel (0,0) ; les lignes descendent vers le sud.
 */
export interface Grille {
  x0: number;
  y0: number;
  res: number;
  w: number;
  h: number;
  z: Float32Array;
  /** 0 = sol, 1 = bâtiment, 2 = végétation (optionnel). */
  classe?: Uint8Array;
  zMax: number;
}

/** Codes d'ensoleillement par créneau. */
export enum Code {
  Rien = 0, // nuit ou soleil derrière la façade
  Soleil = 1,
  OmbreBatiment = 2,
  OmbreVegetation = 3,
  OmbreRelief = 4,
}

export function altitude(g: Grille, x: number, y: number): number {
  const c = Math.floor((x - g.x0) / g.res);
  const r = Math.floor((g.y0 - y) / g.res);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return NaN;
  return g.z[r * g.w + c]!;
}

/**
 * Lance un rayon depuis o (L93 + altitude) dans la direction d (est, nord, haut).
 * Renvoie le code d'obstacle rencontré, ou Code.Soleil si le rayon sort libre.
 */
export function lancerRayon(g: Grille, o: { x: number; y: number; z: number }, d: [number, number, number], attenuationVeg?: number): Code {
  const horiz = Math.hypot(d[0], d[1]);
  if (horiz < 1e-6) return Code.Soleil;
  const pas = g.res * 0.5;
  const dt = pas / horiz;
  // Végétation semi-transparente (loi de Beer-Lambert) : transmission = exp(−k × distance dans la couronne).
  // Le rayon est « ombré » quand moins de la moitié de la lumière passe. Sans k : végétation opaque.
  let optique = 0;
  const pasReel = Math.hypot(pas, d[2] * dt);
  for (let t = dt; ; t += dt) {
    const z = o.z + d[2] * t;
    if (z > g.zMax) return Code.Soleil;
    const x = o.x + d[0] * t;
    const y = o.y + d[1] * t;
    const c = Math.floor((x - g.x0) / g.res);
    const r = Math.floor((g.y0 - y) / g.res);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) return Code.Soleil;
    const i = r * g.w + c;
    const zz = g.z[i]!;
    if (zz > z) {
      const k = g.classe?.[i] ?? 1;
      if (k === 2 && attenuationVeg !== undefined) {
        optique += attenuationVeg * pasReel;
        if (optique > Math.LN2) return Code.OmbreVegetation;
        continue;
      }
      return k === 2 ? Code.OmbreVegetation : k === 0 ? Code.OmbreRelief : Code.OmbreBatiment;
    }
  }
}

const ecartAngle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

export interface ParamsAnnee {
  lieu: LonLat;
  grille: Grille;
  /** Points de la fenêtre (L93 + altitude), déjà décalés hors de la façade. */
  points: { x: number; y: number; z: number }[];
  azimutFacade: number;
  annee: number;
  /** Début (UTC, ms) de la journée murale à Paris pour un jour donné de l'année. */
  debutJour: (annee: number, jourAnnee: number) => number;
  pasMinutes?: number;
  progression?: (f: number) => void;
  /** Atténuation de la végétation (par mètre) selon le jour de l'année : feuillage saisonnier. Absent : arbres opaques. */
  attenuationVegetation?: (jourAnnee: number) => number;
}

export interface ResultatAnnee {
  jours: number;
  creneaux: number;
  pasMinutes: number;
  /** codes[jour * creneaux + k] */
  codes: Uint8Array;
}

export function ensoleillementAnnee(p: ParamsAnnee): ResultatAnnee {
  const pas = p.pasMinutes ?? 10;
  const creneaux = Math.round((24 * 60) / pas);
  const bissextile = new Date(Date.UTC(p.annee, 1, 29)).getUTCMonth() === 1;
  const jours = bissextile ? 366 : 365;
  const codes = new Uint8Array(jours * creneaux);
  const majorite = Math.ceil(p.points.length / 2);
  for (let j = 0; j < jours; j++) {
    const t0 = p.debutJour(p.annee, j);
    const kVeg = p.attenuationVegetation?.(j);
    for (let k = 0; k < creneaux; k++) {
      // Milieu du créneau.
      const s = positionSoleil(new Date(t0 + (k + 0.5) * pas * 60_000), p.lieu);
      if (s.elevation <= 0 || ecartAngle(s.azimut, p.azimutFacade) >= 90) continue;
      const [e, u, sud] = directionSoleil(s);
      const d: [number, number, number] = [e, -sud, u];
      let soleil = 0;
      const obstacles = [0, 0, 0, 0, 0];
      for (const o of p.points) {
        const c = lancerRayon(p.grille, o, d, kVeg);
        if (c === Code.Soleil) soleil++;
        else obstacles[c]!++;
      }
      if (soleil >= majorite) codes[j * creneaux + k] = Code.Soleil;
      else {
        let best = Code.OmbreBatiment as number;
        for (let c = 2; c <= 4; c++) if (obstacles[c]! > obstacles[best]!) best = c;
        codes[j * creneaux + k] = best;
      }
    }
    if (p.progression && j % 10 === 0) p.progression(j / jours);
  }
  return { jours, creneaux, pasMinutes: pas, codes };
}

/** Minutes de soleil par jour. */
export function minutesParJour(r: ResultatAnnee): number[] {
  const out: number[] = [];
  for (let j = 0; j < r.jours; j++) {
    let n = 0;
    for (let k = 0; k < r.creneaux; k++) if (r.codes[j * r.creneaux + k] === Code.Soleil) n++;
    out.push(n * r.pasMinutes);
  }
  return out;
}
