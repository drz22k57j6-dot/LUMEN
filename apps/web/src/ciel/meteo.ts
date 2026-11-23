/**
 * Météo des nuages : données réelles quand elles existent, simulation sinon.
 *
 * Sources (Open-Meteo, open data, sans clé) sur une grille 5 × 5 points espacés de 5 km autour de l'adresse :
 *  - J-90 → J+15 : prévisions Météo-France (AROME 1,3 km / ARPEGE, « meteofrance_seamless ») ;
 *  - depuis 2022 : archives de ces mêmes prévisions (historical-forecast-api) ;
 *  - depuis 1940 : réanalyse ERA5 (archive-api) ;
 *  - au-delà de J+15 : simulation climatologique déterministe (même date → même ciel).
 * Variables : nébulosité basse / moyenne / haute (%), rayonnement direct normal et diffus (W/m²), vent.
 */
import type { LonLat } from '@lumen/core';

export const N = 5;
export const PAS_KM = 5;

export interface GrilleMeteo {
  heures: number[]; // instants UTC (ms)
  /** [heure][point][couche 0 bas,1 moyen,2 haut] en 0..1 */
  couv: Float32Array;
  dni: (number | null)[]; // W/m², point central
  dhi: (number | null)[];
  ventE: number[]; // m/s vers l'est (déplacement des nuages)
  ventN: number[];
  pluie: number[];
  source: string;
  reel: boolean;
}

export interface EtatMeteo {
  /** Couverture par point de grille et par couche, interpolée dans le temps : N*N*3 */
  couv: Float32Array;
  bas: number; moyen: number; haut: number; total: number;
  dni: number | null; dhi: number | null;
  ventE: number; ventN: number; pluie: number;
  source: string; reel: boolean;
}

const VARS = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'direct_normal_irradiance', 'diffuse_radiation', 'precipitation'];
const JOUR = 86_400_000;
const isoJour = (t: number) => new Date(t).toISOString().slice(0, 10);

function points(c: LonLat) {
  const lat: number[] = [], lon: number[] = [];
  const dLat = PAS_KM / 111.32, dLon = PAS_KM / (111.32 * Math.cos((c.lat * Math.PI) / 180));
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      // j = 0 au nord, i = 0 à l'ouest
      lat.push(+(c.lat + (N >> 1) * dLat - j * dLat).toFixed(4));
      lon.push(+(c.lon - (N >> 1) * dLon + i * dLon).toFixed(4));
    }
  return { lat, lon };
}

type Reponse = { hourly: Record<string, (number | null)[]> & { time: string[] } };

async function demander(url: string): Promise<Reponse[] | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = (await r.json()) as Reponse | Reponse[];
    const l = Array.isArray(j) ? j : [j];
    return l.length === N * N && l[0]?.hourly?.time?.length ? l : null;
  } catch {
    return null;
  }
}

function assembler(l: Reponse[], vent: [string, string], source: string): GrilleMeteo | null {
  const H = l[0]!.hourly.time.length;
  const couv = new Float32Array(H * N * N * 3);
  let manquants = 0;
  for (let h = 0; h < H; h++)
    l.forEach((p, k) => {
      ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'].forEach((v, c) => {
        const x = p.hourly[v]?.[h];
        if (x == null) manquants++;
        couv[(h * N * N + k) * 3 + c] = (x ?? 0) / 100;
      });
    });
  if (manquants > H * N * N) return null; // modèle absent sur cette zone
  const c = l[(N * N) >> 1]!.hourly;
  const ventE: number[] = [], ventN: number[] = [];
  for (let h = 0; h < H; h++) {
    const v = c[vent[0]]?.[h] ?? 8, d = ((c[vent[1]]?.[h] ?? 250) * Math.PI) / 180;
    // direction météo = d'où vient le vent
    ventE.push(-v * Math.sin(d));
    ventN.push(-v * Math.cos(d));
  }
  return {
    heures: c.time.map((t) => Date.parse(t + 'Z')),
    couv,
    dni: c.direct_normal_irradiance ?? new Array(H).fill(null),
    dhi: c.diffuse_radiation ?? new Array(H).fill(null),
    ventE, ventN,
    pluie: (c.precipitation ?? []).map((x) => x ?? 0),
    source,
    reel: true,
  };
}

// --- Simulation (aucune donnée réelle disponible) ---------------------------
const CLIMAT = [0.76, 0.72, 0.66, 0.6, 0.58, 0.53, 0.5, 0.5, 0.56, 0.66, 0.74, 0.78]; // nébulosité moyenne à Paris
function hash(n: number) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** Bruit lisse 1D déterministe (heures) */
function lisse(t: number, graine: number) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return hash(i * 7919 + graine) * (1 - u) + hash((i + 1) * 7919 + graine) * u;
}
function simuler(c: LonLat, t0: number, t1: number): GrilleMeteo {
  const heures: number[] = [];
  for (let t = t0; t < t1; t += 3_600_000) heures.push(t);
  const H = heures.length;
  const couv = new Float32Array(H * N * N * 3);
  const g = Math.round(c.lat * 100) * 1000 + Math.round(c.lon * 100);
  const ventE: number[] = [], ventN: number[] = [];
  for (let h = 0; h < H; h++) {
    const t = heures[h]! / 3_600_000;
    const mois = new Date(heures[h]!).getUTCMonth();
    const m = CLIMAT[mois]!;
    // régime de temps sur ~2 jours + variations de quelques heures
    const regime = lisse(t / 40, g) * 0.7 + lisse(t / 9, g + 1) * 0.3;
    for (let k = 0; k < N * N; k++) {
      const loc = (lisse(t / 5 + k * 0.37, g + 2) - 0.5) * 0.25;
      const bas = Math.min(1, Math.max(0, (regime - (1 - m)) * 1.8 + loc));
      const moyen = Math.min(1, Math.max(0, (lisse(t / 14, g + 3) - 0.45) * 1.6 + loc * 0.6));
      const haut = Math.min(1, Math.max(0, (lisse(t / 20, g + 4) - 0.4) * 1.5));
      couv.set([bas, moyen, haut], (h * N * N + k) * 3);
    }
    const ang = lisse(t / 30, g + 5) * Math.PI * 2, v = 4 + lisse(t / 12, g + 6) * 12;
    ventE.push(Math.cos(ang) * v);
    ventN.push(Math.sin(ang) * v);
  }
  return { heures, couv, dni: heures.map(() => null), dhi: heures.map(() => null), ventE, ventN, pluie: heures.map(() => 0), source: 'Simulation climatologique (pas de donnée réelle à cette date)', reel: false };
}

// --- Chargement --------------------------------------------------------------
const cache = new Map<string, Promise<GrilleMeteo>>();

/** Météo sur 3 jours centrés sur `date` (veille, jour, lendemain). */
export function chargerMeteo(c: LonLat, date: Date): Promise<GrilleMeteo> {
  const j0 = Math.floor(date.getTime() / JOUR) * JOUR - JOUR, j1 = j0 + 3 * JOUR;
  const cle = `${c.lat.toFixed(2)},${c.lon.toFixed(2)},${j0}`;
  if (!cache.has(cle)) cache.set(cle, charger(c, j0, j1));
  return cache.get(cle)!;
}

async function charger(c: LonLat, j0: number, j1: number): Promise<GrilleMeteo> {
  const { lat, lon } = points(c);
  const maintenant = Date.now();
  const base = `latitude=${lat.join(',')}&longitude=${lon.join(',')}&start_date=${isoJour(j0)}&end_date=${isoJour(j1 - JOUR)}&timezone=GMT&wind_speed_unit=ms`;
  const pl = `&hourly=${[...VARS, 'wind_speed_850hPa', 'wind_direction_850hPa'].join(',')}`;
  const essais: [string, [string, string], string][] = [];
  if (j0 > maintenant - 90 * JOUR && j1 < maintenant + 16 * JOUR) {
    essais.push([`https://api.open-meteo.com/v1/forecast?${base}${pl}&models=meteofrance_seamless`, ['wind_speed_850hPa', 'wind_direction_850hPa'], 'Météo-France AROME/ARPEGE (prévision)']);
    essais.push([`https://api.open-meteo.com/v1/forecast?${base}${pl}`, ['wind_speed_850hPa', 'wind_direction_850hPa'], 'Open-Meteo (meilleur modèle disponible)']);
  }
  if (j0 >= Date.UTC(2022, 0, 1) && j1 < maintenant + JOUR) {
    essais.push([`https://historical-forecast-api.open-meteo.com/v1/forecast?${base}${pl}&models=meteofrance_seamless`, ['wind_speed_850hPa', 'wind_direction_850hPa'], 'Météo-France AROME/ARPEGE (archive des prévisions)']);
  }
  if (j0 >= Date.UTC(1940, 0, 1) && j1 < maintenant - 5 * JOUR) {
    essais.push([`https://archive-api.open-meteo.com/v1/archive?${base}&hourly=${[...VARS, 'wind_speed_100m', 'wind_direction_100m'].join(',')}`, ['wind_speed_100m', 'wind_direction_100m'], 'Réanalyse ERA5 (ECMWF)']);
  }
  for (const [url, vent, source] of essais) {
    const l = await demander(url);
    const g = l && assembler(l, vent, source);
    if (g) return g;
  }
  return simuler(c, j0, j1);
}

/** État interpolé à l'instant t. */
export function etatA(g: GrilleMeteo, t: number): EtatMeteo {
  const H = g.heures.length;
  let h = 0;
  while (h < H - 2 && g.heures[h + 1]! <= t) h++;
  const f = Math.min(1, Math.max(0, (t - g.heures[h]!) / 3_600_000));
  const couv = new Float32Array(N * N * 3);
  for (let i = 0; i < couv.length; i++) couv[i] = g.couv[h * couv.length + i]! * (1 - f) + g.couv[(h + 1) * couv.length + i]! * f;
  const k = (N * N) >> 1;
  const mix = (a: (number | null)[]) => (a[h] == null || a[h + 1] == null ? null : a[h]! * (1 - f) + a[h + 1]! * f);
  const bas = couv[k * 3]!, moyen = couv[k * 3 + 1]!, haut = couv[k * 3 + 2]!;
  return {
    couv, bas, moyen, haut,
    total: 1 - (1 - bas) * (1 - moyen) * (1 - haut),
    // Le rayonnement d'Open-Meteo est la moyenne de l'heure qui précède : on le centre.
    dni: mix(g.dni.map((_, i) => g.dni[Math.min(H - 1, i + 1)] ?? null)),
    dhi: mix(g.dhi.map((_, i) => g.dhi[Math.min(H - 1, i + 1)] ?? null)),
    ventE: g.ventE[h]! * (1 - f) + g.ventE[h + 1]! * f,
    ventN: g.ventN[h]! * (1 - f) + g.ventN[h + 1]! * f,
    pluie: g.pluie[h] ?? 0,
    source: g.source,
    reel: g.reel,
  };
}
