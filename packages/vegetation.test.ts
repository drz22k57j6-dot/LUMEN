import { describe, expect, it } from 'vitest';
import { ESPECES, couronnesLidar, depuisParis, especeDuGenre, feuillage, fusionner } from './vegetation/src';
import { lancerRayon, Code, type Grille } from './analysis/src';

describe('végétation — phénologie', () => {
  const pl = ESPECES.platane!;
  it('platane : nu en janvier, plein en juillet, coloré fin octobre', () => {
    expect(feuillage(pl, 15).feuilles).toBe(0);
    expect(feuillage(pl, 195).feuilles).toBe(1);
    expect(feuillage(pl, 195).automne).toBe(0);
    expect(feuillage(pl, 300).automne).toBeGreaterThan(0.5);
    expect(feuillage(pl, 300).feuilles).toBeGreaterThan(0.2);
  });
  it('cerisier fleurit avant ses feuilles ; pin toujours vert', () => {
    const c = feuillage(ESPECES.prunus!, 98);
    expect(c.fleurs).toBeGreaterThan(0.9);
    expect(c.feuilles).toBeLessThan(0.1);
    expect(feuillage(ESPECES.pin!, 15).feuilles).toBe(1);
  });
  it('atténuation : hiver ≪ été', () => {
    expect(feuillage(pl, 15).attenuation).toBeLessThan(feuillage(pl, 195).attenuation / 4);
  });
  it('genres latins', () => {
    expect(especeDuGenre('Platanus').id).toBe('platane');
    expect(especeDuGenre('Inconnu').id).toBe('feuillu');
  });
});

describe('végétation — sources', () => {
  it('inventaire de Paris', () => {
    const a = depuisParis({ idbase: 1, genre: 'Aesculus', hauteurenm: 15, circonferenceencm: 120, geo_point_2d: { lon: 2.3, lat: 48.8 } }, () => ({ x: 10, y: 20 }))!;
    expect(a.espece).toBe('marronnier');
    expect(a.hauteur.valeur).toBe(15);
    expect(depuisParis({ idbase: 2, genre: 'Tilia', hauteurenm: 0, circonferenceencm: 90, geo_point_2d: { lon: 2.3, lat: 48.8 } }, () => ({ x: 0, y: 0 }))!.hauteur.valeur).toBeCloseTo(13);
  });
  it('couronne LiDAR : sommet, hauteur et rayon', () => {
    const n = 60, res = 0.5, h = new Float32Array(n * n), veg = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const d = Math.hypot((c - 30) * res, (r - 30) * res);
      if (d < 4) { h[r * n + c] = 12 - d; veg[r * n + c] = 1; }
    }
    const cs = couronnesLidar({ x0: 0, y0: 30, res, n, h, veg });
    expect(cs).toHaveLength(1);
    expect(cs[0]!.hauteur).toBe(12);
    expect(cs[0]!.rayon).toBeGreaterThan(3);
    const f = fusionner([], cs, () => true);
    expect(f[0]!.hauteur.source).toBe('mesure');
  });
});

describe('soleil à travers les arbres (Beer-Lambert)', () => {
  // couronne de 4 m d'épaisseur entre la fenêtre et le soleil
  const w = 40, z = new Float32Array(w * w), classe = new Uint8Array(w * w);
  for (let r = 0; r < w; r++) for (let c = 18; c < 26; c++) { z[r * w + c] = 20; classe[r * w + c] = 2; }
  const g: Grille = { x0: 0, y0: 20, res: 0.5, w, h: w, z, classe, zMax: 20 };
  const o = { x: 5, y: 10, z: 5 };
  it('opaque sans saison, transparent en hiver, ombre en été', () => {
    expect(lancerRayon(g, o, [1, 0, 0])).toBe(Code.OmbreVegetation);
    expect(lancerRayon(g, o, [1, 0, 0], feuillage(ESPECES.platane!, 15).attenuation)).toBe(Code.Soleil);
    expect(lancerRayon(g, o, [1, 0, 0], feuillage(ESPECES.platane!, 195).attenuation)).toBe(Code.OmbreVegetation);
  });
});
