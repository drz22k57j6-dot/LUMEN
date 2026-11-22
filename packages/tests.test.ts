import { describe, expect, it } from 'vitest';
import { azimutDe, versL93, versWgs84 } from './core/src';
import { ensoleillementJour, positionSoleil } from './analysis/src';
import { contient, versBatiment } from './urban/src';

const PANTHEON = { lon: 2.346631, lat: 48.845364 };

describe('core — projections', () => {
  it('WGS84 → Lambert-93 (référence IGN Géoplateforme, < 1 cm)', () => {
    // Valeurs x/y renvoyées par le géocodeur IGN pour « 1 place du Panthéon ».
    const p = versL93(PANTHEON);
    expect(Math.abs(p.x - 652050.08)).toBeLessThan(0.5); // l'API arrondit les coordonnées WGS84 à 1e-6° (~7 cm)
    expect(Math.abs(p.y - 6860789.29)).toBeLessThan(0.5);
  });
  it('aller-retour sans perte (< 1 mm)', () => {
    const q = versWgs84(versL93(PANTHEON));
    expect(Math.abs(q.lon - PANTHEON.lon)).toBeLessThan(1e-8);
    expect(Math.abs(q.lat - PANTHEON.lat)).toBeLessThan(1e-8);
  });
  it('azimuts', () => {
    expect(azimutDe(0, 1)).toBeCloseTo(0);
    expect(azimutDe(1, 0)).toBeCloseTo(90);
    expect(azimutDe(0, -1)).toBeCloseTo(180);
    expect(azimutDe(-1, 0)).toBeCloseTo(270);
  });
});

describe('analysis — soleil', () => {
  it('élévation max à Paris au solstice d’été ≈ 90 − 48,85 + 23,44', () => {
    let max = -90;
    for (let m = 0; m < 24 * 60; m += 2) {
      const e = positionSoleil(new Date(Date.UTC(2026, 5, 21, 0, m)), PANTHEON).elevation;
      if (e > max) max = e;
    }
    expect(Math.abs(max - (90 - 48.845 + 23.44))).toBeLessThan(0.1);
  });
  it('midi solaire : azimut ≈ 180° à 11h50 UTC environ (équation du temps incluse)', () => {
    const s = positionSoleil(new Date(Date.UTC(2026, 2, 20, 11, 58)), PANTHEON);
    expect(Math.abs(s.azimut - 180)).toBeLessThan(3);
  });
  it('façade sud sans obstacle : ~ 12 h de soleil à l’équinoxe', () => {
    const r = ensoleillementJour(
      { lieu: PANTHEON, point: [0, 0, 0], azimutFacade: 180, annee: 2026, obstacle: () => false },
      new Date(Date.UTC(2026, 2, 21, 12)),
    );
    expect(r.minutes).toBeGreaterThan(11 * 60);
    expect(r.minutes).toBeLessThan(12.5 * 60);
  });
  it('façade nord à l’équinoxe : quasiment pas de soleil', () => {
    const r = ensoleillementJour(
      { lieu: PANTHEON, point: [0, 0, 0], azimutFacade: 0, annee: 2026, obstacle: () => false },
      new Date(Date.UTC(2026, 2, 21, 12)),
    );
    expect(r.minutes).toBeLessThanOrEqual(20);
  });
  it('obstacle total : 0 minute', () => {
    const r = ensoleillementJour(
      { lieu: PANTHEON, point: [0, 0, 0], azimutFacade: 180, annee: 2026, obstacle: () => true },
      new Date(Date.UTC(2026, 5, 21, 12)),
    );
    expect(r.minutes).toBe(0);
  });
});

describe('urban — BD TOPO', () => {
  it('convertit une entité et marque la provenance', () => {
    const b = versBatiment({
      id: 'batiment.1',
      geometry: { type: 'Polygon', coordinates: [[[2.3466, 48.8453], [2.3467, 48.8453], [2.3467, 48.8454], [2.3466, 48.8454], [2.3466, 48.8453]]] },
      properties: { hauteur: null, altitude_minimale_sol: 57, altitude_minimale_toit: null, precision_altimetrique: 2.5, nature: null, usage_1: 'Résidentiel', nombre_de_logements: 12, nombre_d_etages: null, identifiants_rnb: null },
    });
    expect(b?.contour).toHaveLength(4);
    expect(b?.hauteur.source).toBe('genere');
    expect(b?.altitudeSol).toEqual({ valeur: 57, source: 'mesure', origine: 'IGN BD TOPO', precision_m: 2.5 });
    expect(b && contient(b.contour, versL93({ lon: 2.34665, lat: 48.84535 }))).toBe(true);
  });
});

import { Code, ensoleillementAnnee, lancerRayon, type Grille } from './analysis/src';
import { debutJourParis } from './core/src';

describe('analysis — rayons sur MNS', () => {
  // Grille 100 m × 100 m à 1 m, sol à 0, mur de 20 m de haut au sud (lignes 70 à 72).
  const n = 100;
  const z = new Float32Array(n * n);
  const classe = new Uint8Array(n * n);
  for (let r = 70; r < 73; r++) for (let c = 0; c < n; c++) (z[r * n + c] = 20), (classe[r * n + c] = 1);
  const g: Grille = { x0: 0, y0: 100, res: 1, w: n, h: n, z, classe, zMax: 20 };
  it('le mur bloque un soleil bas venant du sud', () => {
    expect(lancerRayon(g, { x: 50, y: 50, z: 1 }, [0, -Math.cos(0.3), Math.sin(0.3)])).toBe(Code.OmbreBatiment);
  });
  it('un soleil haut passe au-dessus', () => {
    expect(lancerRayon(g, { x: 50, y: 50, z: 1 }, [0, -Math.cos(1.2), Math.sin(1.2)])).toBe(Code.Soleil);
  });
  it('année complète : le mur coupe le soleil d’hiver', () => {
    const r = ensoleillementAnnee({
      lieu: { lon: 2.35, lat: 48.85 }, grille: g, points: [{ x: 50, y: 50, z: 1 }], azimutFacade: 180, annee: 2026, debutJour: debutJourParis,
    });
    const jour = (j: number) => { let m = 0; for (let k = 0; k < r.creneaux; k++) if (r.codes[j * r.creneaux + k] === Code.Soleil) m++; return m; };
    expect(r.jours).toBe(365);
    expect(jour(354)).toBe(0); // 21 déc. : soleil < 18°, mur à 21 m sous ~26° → ombre
    expect(jour(171)).toBeGreaterThan(30); // 21 juin : soleil haut
  });
});
