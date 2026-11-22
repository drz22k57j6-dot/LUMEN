import * as Astronomy from 'astronomy-engine';
import type { LonLat } from '@lumen/core';

/**
 * Position apparente du soleil (éphémérides VSOP87 d'astronomy-engine, précision < 1"),
 * réfraction atmosphérique standard incluse.
 */
export interface PositionSoleil {
  /** Degrés depuis le nord, sens horaire. */
  azimut: number;
  /** Degrés au-dessus de l'horizon (réfraction incluse). */
  elevation: number;
}

export function positionSoleil(date: Date, lieu: LonLat, altitude = 0): PositionSoleil {
  const obs = new Astronomy.Observer(lieu.lat, lieu.lon, altitude);
  const eq = Astronomy.Equator(Astronomy.Body.Sun, date, obs, true, true);
  const hor = Astronomy.Horizon(date, obs, eq.ra, eq.dec, 'normal');
  return { azimut: hor.azimuth, elevation: hor.altitude };
}

/** Vecteur unitaire vers le soleil, dans le repère local (x = est, y = haut, z = sud). */
export function directionSoleil({ azimut, elevation }: PositionSoleil): [number, number, number] {
  const a = (azimut * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

export function leverCoucher(jour: Date, lieu: LonLat): { lever: Date | null; coucher: Date | null } {
  const obs = new Astronomy.Observer(lieu.lat, lieu.lon, 0);
  // Minuit solaire local du jour demandé (indépendant du fuseau de l'appareil).
  const minuit = new Date(
    Date.UTC(jour.getUTCFullYear(), jour.getUTCMonth(), jour.getUTCDate()) - (lieu.lon / 15) * 3_600_000,
  );
  const lever = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, +1, minuit, 1);
  const coucher = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, minuit, 1);
  return { lever: lever?.date ?? null, coucher: coucher?.date ?? null };
}

// --- Ensoleillement d'une fenêtre -----------------------------------------

/** Renvoie true si le rayon partant du point vers la direction donnée est bloqué. */
export type TestObstacle = (origine: [number, number, number], direction: [number, number, number]) => boolean;

export interface ParamsEnsoleillement {
  lieu: LonLat;
  /** Point de départ (repère local), déjà décalé de quelques cm hors de la façade. */
  point: [number, number, number];
  /** Azimut de la normale sortante de la façade (degrés). */
  azimutFacade: number;
  annee: number;
  pasMinutes?: number;
  obstacle: TestObstacle;
}

export interface Plage { debut: Date; fin: Date }
export interface ResultatJour { date: Date; minutes: number; plages: Plage[] }

const ecartAngle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Calcule, pour une journée, les minutes de soleil direct sur le point. */
export function ensoleillementJour(p: ParamsEnsoleillement, jour: Date): ResultatJour {
  const pas = p.pasMinutes ?? 10;
  const { lever, coucher } = leverCoucher(jour, p.lieu);
  const res: ResultatJour = { date: jour, minutes: 0, plages: [] };
  if (!lever || !coucher) return res;
  let enCours: Plage | null = null;
  for (let t = lever.getTime(); t <= coucher.getTime(); t += pas * 60_000) {
    const d = new Date(t);
    const s = positionSoleil(d, p.lieu);
    const visible =
      s.elevation > 0 && ecartAngle(s.azimut, p.azimutFacade) < 90 && !p.obstacle(p.point, directionSoleil(s));
    if (visible) {
      res.minutes += pas;
      if (!enCours) enCours = { debut: d, fin: d };
      enCours.fin = d;
    } else if (enCours) {
      res.plages.push(enCours);
      enCours = null;
    }
  }
  if (enCours) res.plages.push(enCours);
  return res;
}

/** 12 jours types : le 21 de chaque mois, à midi UTC pour fixer la date. */
export function ensoleillementAnnuel(p: ParamsEnsoleillement): ResultatJour[] {
  return Array.from({ length: 12 }, (_, m) => ensoleillementJour(p, new Date(Date.UTC(p.annee, m, 21, 12))));
}

export * from './grille';
