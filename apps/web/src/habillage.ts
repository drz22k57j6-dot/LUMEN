/**
 * Habillage des immeubles réels par le générateur de façades parisiennes.
 * Entrée : façades sur rue (arêtes BD TOPO dégagées d'après le LiDAR), hauteur réelle à la gouttière.
 * Les façades sont fabriquées progressivement (budget de temps par image) puis fusionnées par matériau
 * par paquets, pour garder peu d'appels de dessin et aucune saccade.
 * Les façades sont ILLUSTRATIVES : volumes, hauteurs et toits mesurés viennent de l'IGN.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildBuilding, createKit } from './generateur/facades.js';
import { buildShop } from './generateur/commerces.js';
import { equiperFenetres } from './nuit';

export interface TacheFacade {
  id: string;
  /** Début et fin de la façade en repère local (x, z), orientés pour que la normale (-dz, dx) sorte vers la rue. */
  a: [number, number];
  b: [number, number];
  y: number;
  hGout: number;
  style: 'riche' | 'classique' | 'modeste' | 'moderne';
  lod: 0 | 1;
}

const TEINTES: Record<string, [number, number][]> = {
  pierre: [[0xf6ead2, 5], [0xfbf3e4, 3], [0xe9e2d6, 2], [0xf0dcb8, 1.5], [0xdcd8d0, 1]],
  riche: [[0xfaf2e3, 4], [0xf6eddb, 3], [0xfdf8ef, 2]],
  enduit: [[0xeee6d6, 3], [0xe2c08e, 1.2], [0xe6c2b6, 1], [0xe8da9e, 1], [0xbdb9b0, 1.5], [0xf4f1ea, 1.5]],
};
export const hachage = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const alea = (s: string) => {
  let x = (hachage(s) % 2147483646) + 1;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
};
const tirage = (R: () => number, l: [number, number][]) => {
  let x = R() * l.reduce((t, e) => t + e[1], 0);
  for (const [v, w] of l) if ((x -= w) <= 0) return v;
  return l[0]![0];
};

export class Habillage {
  readonly groupe = new THREE.Group();
  private kit: unknown;
  private file: TacheFacade[] = [];
  private lot = new THREE.Group();
  private nLot = 0;
  private total = 0;
  fait = 0;

  constructor(baseTextures: string) {
    this.kit = createKit(THREE, baseTextures);
    // éclairage de nuit des pièces derrière les fenêtres (modèle horaire, voir nuit.ts)
    equiperFenetres(this.kit as { vc: THREE.Material; rideau: THREE.Material; rideauTire: THREE.Material });
    this.groupe.name = 'facades_generees';
  }

  /** Lueur de jour des intérieurs : compensée la nuit (sinon l'adaptation de l'œil la rend blanche). */
  nuit(expo: number) {
    const M = this.kit as { vc: THREE.MeshStandardMaterial; uJour: { value: number } };
    // proportionnel à la lumière du jour (expo ≈ 1–3 de jour, jusqu'à 6 000 la nuit) : nul la nuit
    const jour = Math.min(1, 2 / expo);
    M.vc.emissiveIntensity = jour;
    M.uJour.value = jour;
  }

  vider() {
    this.file = [];
    this.lot.clear();
    this.nLot = 0;
    this.groupe.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.groupe.clear();
    this.total = this.fait = 0;
  }

  lancer(taches: TacheFacade[]) {
    this.vider();
    // Les plus proches d'abord (déjà triées par l'appelant).
    this.file = taches.slice();
    this.total = taches.length;
  }

  get progression() {
    return this.total ? this.fait / this.total : 1;
  }

  /** À appeler à chaque image : fabrique des façades pendant `budgetMs`. */
  etape(budgetMs: number) {
    if (!this.file.length && !this.nLot) return;
    const t0 = performance.now();
    while (this.file.length && performance.now() - t0 < budgetMs) {
      const t = this.file.shift()!;
      this.fabriquer(t);
      this.fait++;
      if (++this.nLot >= 20) {
        this.fusionner();
        if (this.fait % 100 < 20) this.consolider();
      }
    }
    if (!this.file.length && this.nLot) {
      this.fusionner();
      this.consolider();
    }
  }

  private fabriquer(t: TacheFacade) {
    const [ax, az] = t.a, [bx, bz] = t.b;
    const W = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / W, dz = (bz - az) / W;
    const R = alea(t.id);
    const COM: [string, number][] = [['boulangerie', 3], ['cafe', 4], ['restaurant', 4], ['pharmacie', 2], ['superette', 2], ['coiffeur', 2], ['immobilier', 2], ['mode', 2], ['fleuriste', 1], ['librairie', 1], ['opticien', 1], ['tabac', 1], ['caviste', 1], ['vacant', 2]];
    const shops = R() < (t.style === 'modeste' ? 0.3 : 0.45)
      ? Array.from({ length: W > 14 ? 2 : 1 }, (_, i) => ({ type: tirage(R, COM as unknown as [number, number][]) as unknown as string, id: `${t.id}-${i}`, ferme: R() < 0.1 }))
      : [];
    const famille = t.style === 'modeste' ? 'enduit' : t.style === 'riche' ? 'riche' : 'pierre';
    const g = buildBuilding(THREE, this.kit, {
      width: W,
      depth: 2.6,
      sansToit: true,
      seed: hachage(t.id),
      style: t.style,
      hGout: t.hGout,
      wear: Math.round((0.12 + R() * 0.3) * 4) / 4,
      tone: tirage(R, TEINTES[famille]!),
      toneJit: 0,
      shops,
      shopBuilder: buildShop,
      verdure: 0.5,
      tagP: 0.2,
      pClosed: 0.1,
      lod: t.lod,
    });
    g.applyMatrix4(
      new THREE.Matrix4().makeBasis(new THREE.Vector3(dx, 0, dz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-dz, 0, dx)).setPosition(ax, t.y, az),
    );
    this.lot.add(g);
  }

  /** Fusion finale : un seul maillage par matériau (peu d'appels de dessin). */
  private consolider() {
    const par = new Map<string, THREE.Mesh[]>();
    for (const o of this.groupe.children) {
      const m = o as THREE.Mesh;
      const cle = (m.material as THREE.Material).uuid + Object.keys(m.geometry.attributes).sort().join(',');
      if (!par.has(cle)) par.set(cle, []);
      par.get(cle)!.push(m);
    }
    for (const L of par.values()) {
      if (L.length < 2) continue;
      const g = mergeGeometries(L.map((m) => m.geometry), false);
      if (!g) continue;
      const m = new THREE.Mesh(g, L[0]!.material);
      m.castShadow = L[0]!.castShadow;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      for (const x of L) (x.geometry.dispose(), this.groupe.remove(x));
      this.groupe.add(m);
    }
  }

  /** Fusionne le lot courant par matériau. */
  private fusionner() {
    this.lot.updateMatrixWorld(true);
    const par = new Map<string, { m: THREE.Material; L: THREE.BufferGeometry[] }>();
    this.lot.traverse((o) => {
      const me = o as THREE.Mesh;
      if (!me.isMesh) return;
      const g = me.geometry.index ? me.geometry.toNonIndexed() : me.geometry.clone();
      g.applyMatrix4(me.matrixWorld);
      me.geometry.dispose();
      const m = me.material as THREE.Material;
      const cle = m.uuid + Object.keys(g.attributes).sort().join(',');
      if (!par.has(cle)) par.set(cle, { m, L: [] });
      par.get(cle)!.L.push(g);
    });
    for (const { m, L } of par.values()) {
      const g = L.length > 1 ? mergeGeometries(L, false) : L[0]!;
      if (L.length > 1) L.forEach((x) => x.dispose());
      if (!g) continue;
      const mesh = new THREE.Mesh(g, m);
      const mm = m as THREE.MeshStandardMaterial;
      mesh.castShadow = !m.transparent && !(mm.emissiveIntensity > 0.5);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.groupe.add(mesh);
    }
    this.lot.clear();
    this.nLot = 0;
  }
}

/** Style d'immeuble déduit de la hauteur et de l'identifiant (en attendant les vraies données de façade). */
export function styleDe(id: string, hauteur: number): TacheFacade['style'] {
  if (hauteur > 32) return 'moderne';
  if (hauteur < 11) return 'modeste';
  const r = (hachage(id) % 100) / 100;
  return r < 0.22 ? 'riche' : r < 0.82 ? 'classique' : 'modeste';
}
