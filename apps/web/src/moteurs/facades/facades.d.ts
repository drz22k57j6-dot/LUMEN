// Types minimaux du moteur de façades (JavaScript repris de limoges-3d, moteur_facades v3).
import type * as THREE from 'three';
export interface Kit { partages(): Set<THREE.Material>; [k: string]: unknown }
export interface OptionsImmeuble {
  width: number; depth?: number; seed?: number;
  style?: 'riche' | 'classique' | 'modeste' | 'moderne';
  hGout?: number; wear?: number; reno?: number; tone?: number; rdc?: 'commerce' | 'habitation';
  pShop?: number; pOpen?: number; pClosed?: number; tagP?: number; verdure?: number; toneJit?: number;
  lod?: 0 | 1; numero?: number;
}
export const TQ: number;
export function createKit(T: typeof THREE, base: string): Kit;
export function buildBuilding(T: typeof THREE, kit: Kit, o: OptionsImmeuble): THREE.Group;
