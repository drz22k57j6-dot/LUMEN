import { describe, expect, it } from 'vitest';
import {
  azimutPlan, blocsMurs, depuisDXF, depuisPlan, depuisRoomPlan, directionPlan, erreursModele, longueur, normaleExterieure, planModele,
} from './interior/src';

const T = (x: number, y: number, z: number, ang = 0) => [Math.cos(ang), 0, -Math.sin(ang), 0, 0, 1, 0, 0, Math.sin(ang), 0, Math.cos(ang), 0, x, y, z, 1];

describe('modèle — sources', () => {
  it('plan Lumen T3 → murs, fenêtres, portes, pièces', () => {
    const m = depuisPlan(planModele('t3'));
    expect(erreursModele(m)).toEqual([]);
    expect(m.ouvertures.filter((o) => o.type === 'fenetre').length).toBe(3);
    expect(m.ouvertures.filter((o) => o.type === 'porte').length).toBeGreaterThan(3);
    expect(m.pieces).toHaveLength(9);
  });
  it('RoomPlan : 4 murs, une fenêtre, une porte, un lit', () => {
    // Pièce 4 × 3 m, sol à y = −1,4 (ARKit), murs de 2,5 m.
    const y = -1.4 + 1.25;
    const json = {
      walls: [
        { dimensions: [4, 2.5, 0], transform: T(0, y, 1.5) },
        { dimensions: [4, 2.5, 0], transform: T(0, y, -1.5) },
        { dimensions: [3, 2.5, 0], transform: T(2, y, 0, Math.PI / 2) },
        { dimensions: [3, 2.5, 0], transform: T(-2, y, 0, Math.PI / 2) },
      ],
      windows: [{ dimensions: [1.2, 1.4, 0], transform: T(0.5, -1.4 + 0.9 + 0.7, -1.5) }],
      doors: [{ dimensions: [0.9, 2.05, 0], transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [-1, -1.4 + 1.025, 1.5, 1]], category: { door: { isOpen: false } } }],
      objects: [{ dimensions: [1.6, 0.5, 2], transform: T(0, -1.15, 0), category: { bed: {} } }],
      sections: [{ label: 'bedroom', center: [0, 0, 0] }],
    };
    const m = depuisRoomPlan(json);
    expect(m.murs).toHaveLength(4);
    expect(m.hauteurSousPlafond).toBe(2.5);
    const f = m.ouvertures.find((o) => o.type === 'fenetre')!;
    expect(f.allege).toBeCloseTo(0.9);
    expect(f.t).toBeCloseTo(2.5); // mur de x −2 → 2, fenêtre centrée en x = 0,5
    expect(m.ouvertures.find((o) => o.type === 'porte')!.allege).toBeCloseTo(0);
    expect(m.objets[0]).toMatchObject({ categorie: 'bed' });
    expect(m.objets[0]!.centre[2]).toBeCloseTo(0.25);
    expect(m.pieces[0]!.type).toBe('chambre');
    // Mur du fond (z = −1,5 ARKit → y = +1,5 plan) : fenêtre, donc mur extérieur, normale vers +y.
    const w = m.murs.find((x) => x.exterieur)!;
    expect(normaleExterieure(m, w)[1]).toBeCloseTo(1);
  });
  it('DXF en mm → mètres, calque murs', () => {
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'MURS', '90', '4', '70', '1', '10', '0', '20', '0', '10', '5000', '20', '0', '10', '5000', '20', '4000', '10', '0', '20', '4000',
      '0', 'LINE', '8', 'COTES', '10', '0', '20', '0', '11', '99999', '21', '0',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const m = depuisDXF(dxf);
    expect(m.murs).toHaveLength(4);
    expect(Math.max(...m.murs.map(longueur))).toBeCloseTo(5);
  });
});

describe('modèle — géométrie', () => {
  it('mur percé : surface = mur − fenêtre', () => {
    const m = depuisPlan(planModele('studio'));
    const f = m.ouvertures.find((o) => o.type === 'fenetre')!;
    const w = m.murs.find((x) => x.id === f.mur)!;
    const blocs = blocsMurs(m).filter((b) => b.mur === w.id && b.type === 'mur');
    const aire = blocs.reduce((s, b) => s + b.taille[0] * b.taille[2], 0);
    const ouv = m.ouvertures.filter((o) => o.mur === w.id).reduce((s, o) => s + o.largeur * o.hauteur, 0);
    expect(aire).toBeCloseTo((longueur(w) + w.epaisseur) * w.hauteur - ouv, 5);
  });
  it('azimuts du plan', () => {
    expect(azimutPlan(180, [0, -1])).toBeCloseTo(180);
    expect(azimutPlan(180, [1, 0])).toBeCloseTo(90);
    const d = directionPlan(180, 90);
    expect(d[0]).toBeCloseTo(1);
  });
});
