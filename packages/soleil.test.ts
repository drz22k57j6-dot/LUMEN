import { describe, expect, it } from 'vitest';
import { eclairement, positionSoleil } from './analysis/src';

// Algorithme NOAA (feuille de calcul « Solar Calculations », précision ≈ 0,01°), écrit à part du moteur.
function noaa(d: Date, lat: number, lon: number) {
  const r = Math.PI / 180, jd = d.getTime() / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360, M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * r) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * r) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * r) * 0.000289;
  const om = 125.04 - 1934.136 * T, lam = L0 + C - 0.00569 - 0.00478 * Math.sin(om * r);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om * r);
  const dec = Math.asin(Math.sin(eps * r) * Math.sin(lam * r)) / r, y = Math.tan((eps / 2) * r) ** 2;
  const eqt = (4 / r) * (y * Math.sin(2 * L0 * r) - 2 * e * Math.sin(M * r) + 4 * e * y * Math.sin(M * r) * Math.cos(2 * L0 * r) - 0.5 * y * y * Math.sin(4 * L0 * r) - 1.25 * e * e * Math.sin(2 * M * r));
  const mn = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, tst = (((mn + eqt + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const z = Math.acos(Math.sin(lat * r) * Math.sin(dec * r) + Math.cos(lat * r) * Math.cos(dec * r) * Math.cos(ha * r)) / r;
  const h = 90 - z, te = Math.tan(h * r);
  const refr = h > 5 ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5 : h > -0.575 ? 1735 + h * (-518.2 + h * (103.4 + h * (-12.79 + h * 0.711))) : -20.772 / te;
  const az0 = Math.acos((Math.sin(lat * r) * Math.cos(z * r) - Math.sin(dec * r)) / (Math.cos(lat * r) * Math.sin(z * r))) / r;
  return { elevation: h + refr / 3600, azimut: ha > 0 ? (az0 + 180) % 360 : (540 - az0) % 360 };
}

describe('analysis — soleil réel', () => {
  it('cas de référence officiel NREL SPA (Reda & Andreas 2008) à 0,01° près', () => {
    // 17/10/2003 12:30:30 heure locale (UTC−7), Golden (Colorado), 1 830 m : zénith 50,11162°, azimut 194,34024°
    const s = positionSoleil(new Date(Date.UTC(2003, 9, 17, 19, 30, 30)), { lat: 39.742476, lon: -105.1786 }, 1830.14);
    expect(Math.abs(s.elevation - (90 - 50.11162))).toBeLessThan(0.01);
    expect(Math.abs(s.azimut - 194.34024)).toBeLessThan(0.01);
  });
  it('accord avec l’algorithme NOAA sur Paris, Limoges, Marseille (solstices, équinoxes, 4 heures)', () => {
    const lieux = [{ lat: 48.8462, lon: 2.3464 }, { lat: 45.8336, lon: 1.2611 }, { lat: 43.2965, lon: 5.3698 }];
    let n = 0;
    for (const l of lieux)
      for (const [mo, j] of [[2, 20], [5, 21], [8, 22], [11, 21]] as const)
        for (const hUtc of [7, 10, 12, 15]) {
          const d = new Date(Date.UTC(2026, mo, j, hUtc, 0));
          const a = positionSoleil(d, l), b = noaa(d, l.lat, l.lon);
          if (b.elevation < 5) continue;
          expect(Math.abs(a.elevation - b.elevation)).toBeLessThan(0.02);
          expect(Math.abs(((a.azimut - b.azimut + 540) % 360) - 180)).toBeLessThan(0.02);
          n++;
        }
    expect(n).toBeGreaterThan(30);
  });
  it('éclairement de ciel clair dans les plages mesurées', () => {
    const midi = eclairement(60), bas = eclairement(10);
    expect(midi.globalHorizontal).toBeGreaterThan(85_000);
    expect(midi.globalHorizontal).toBeLessThan(115_000);
    expect(midi.diffusHorizontal).toBeGreaterThan(10_000);
    expect(midi.diffusHorizontal).toBeLessThan(25_000);
    expect(bas.globalHorizontal).toBeGreaterThan(10_000);
    expect(eclairement(-3).diffusHorizontal).toBeLessThan(400);
    expect(eclairement(-12).directNormal).toBe(0);
  });
  it('soleil blanc en journée, orangé au coucher ; ciel bleu', () => {
    const [r, v, b] = eclairement(5).couleurSoleil;
    expect(r).toBe(1);
    expect(v).toBeLessThan(0.5);
    expect(b).toBeLessThan(v);
    expect(eclairement(50).couleurSoleil[2]).toBeGreaterThan(0.6);
    const c = eclairement(40).couleurCiel;
    expect(c[2]).toBeGreaterThan(c[0]);
  });
});

import { convergenceL93, azimutVrai } from './core/src';
import { directionSoleil } from './analysis/src';
describe('Lambert-93 — nord vrai / nord grille', () => {
  it('convergence des méridiens (Paris, Limoges, Marseille, vérifiée avec proj4)', () => {
    expect(convergenceL93(2.3464)).toBeCloseTo(0.4743, 3);
    expect(convergenceL93(1.2611)).toBeCloseTo(1.2618, 3);
    expect(convergenceL93(5.3698)).toBeCloseTo(-1.7195, 3);
  });
  it('le soleil plein sud vrai est tourné de la convergence dans la scène', () => {
    const [x, , z] = directionSoleil({ azimut: 180, elevation: 0, convergence: 0.4743 });
    expect((Math.atan2(x, -z) * 180) / Math.PI + 360).toBeCloseTo(180.4743, 3);
    expect(azimutVrai(180.4743, 2.3464)).toBeCloseTo(180, 3);
  });
});
