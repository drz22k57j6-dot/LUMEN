/**
 * MODE DÉVELOPPEUR — temporaire.
 *
 * Ce fichier n'est inclus dans le site que si le build est lancé avec VITE_MODE_DEV=1
 * (voir .github/workflows/pages.yml). Sans ce réglage, Vite supprime l'import et ce code
 * n'existe pas dans le site publié : aucune porte dérobée.
 *
 * Pour le retirer définitivement : supprimer le dossier src/dev/, le bloc « Mode développeur »
 * à la fin de main.ts et la ligne VITE_MODE_DEV du workflow.
 *
 * Le site est 100 % statique : aucun secret, aucune clé, aucune donnée serveur n'est exposé ici.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { geocoder } from '@lumen/urban';
import type { Adresse } from '@lumen/core';

export interface ContexteDev {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  /** Ouvre le monde 3D (dernière version) à cette adresse, sans passer par la carte 2D. */
  charger: (a: Adresse) => unknown;
  carte2D: () => void;
  ouvrirStudio: () => void;
  ouvrirPlan: () => void;
  etat: () => Record<string, unknown>;
  diagnostic: Record<string, unknown>;
}

const LIEUX: [string, string][] = [
  ['Panthéon', '1 place du Panthéon 75005 Paris'],
  ['Tour Eiffel', '5 avenue Anatole France 75007 Paris'],
  ['Opéra Garnier', '8 rue Scribe 75009 Paris'],
  ['Montmartre', '35 rue du Chevalier de la Barre 75018 Paris'],
  ['Av. Victor-Hugo', '100 avenue Victor Hugo 75116 Paris'],
  ['Limoges, Le Gréco', '31 allée Le Gréco 87100 Limoges'],
];

export function installerModeDev(ctx: ContexteDev) {
  (window as unknown as { __lumen: unknown }).__lumen = ctx.diagnostic; // outils de test, mode dev seulement

  const bouton = document.createElement('button');
  bouton.id = 'devBouton';
  bouton.type = 'button';
  bouton.textContent = '⚙';
  bouton.title = 'Mode développeur';
  const p = document.createElement('div');
  p.id = 'devPanneau';
  p.hidden = true;
  document.body.append(bouton, p);
  const style = document.createElement('style');
  style.textContent = `
    #devBouton{position:fixed;z-index:20;top:calc(env(safe-area-inset-top) + 10px);right:10px;width:44px;height:44px;border-radius:50%;border:1px solid #fff3;background:#111c;color:#fff;font-size:20px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
    #devPanneau{position:fixed;z-index:20;top:calc(env(safe-area-inset-top) + 60px);right:10px;left:10px;max-width:420px;margin-left:auto;max-height:75vh;overflow:auto;padding:12px;border-radius:16px;background:#111e;color:#eee;font:13px/1.4 system-ui;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
    #devPanneau h4{margin:12px 0 6px;font-size:12px;color:#ffc94d}
    #devPanneau button{margin:2px;padding:8px 10px;border-radius:10px;border:1px solid #fff3;background:#ffffff14;color:#fff;font-size:13px}
    #devPanneau input[type=text]{width:100%;padding:8px;border-radius:10px;border:1px solid #fff3;background:#0006;color:#fff;font-size:16px}
    #devPanneau label{display:flex;gap:8px;align-items:center;padding:3px 0}
    #devPanneau pre{white-space:pre-wrap;font-size:11px;color:#bbb;margin:0}
    #devPanneau .rang{display:flex;flex-wrap:wrap;gap:4px;align-items:center}`;
  document.head.append(style);

  p.innerHTML = `
    <b>Mode développeur</b> <span style="color:#999">— temporaire, retiré au lancement</span>
    <h4>Accès</h4>
    <div class="rang"><button data-a="studio">🧊 Studio 3D</button><button data-a="plan">▦ Plan 2D</button><button data-a="haut">⬆ Vue de haut</button><button data-a="libre">🎥 Caméra libre</button></div>
    <h4>Monde 3D — rechercher une adresse</h4>
    <div class="rang" style="flex-wrap:nowrap"><input id="devAdresse" type="text" placeholder="Ex. 12 rue de Rivoli Paris" autocomplete="off" /><button data-a="chercher">🔍</button></div>
    <div id="devSugg"></div>
    <div class="rang">${LIEUX.map(([n], i) => `<button data-lieu="${i}">${n}</button>`).join('')}</div>
    <div class="rang"><button data-a="carte">🗺 Carte 2D d'accueil</button></div>
    <h4>Monde 3D (calques)</h4><div id="devCalques"></div>
    <div class="rang">
      <label><input id="devFil" type="checkbox"> Fil de fer</label>
      <label><input id="devOmbres" type="checkbox" checked> Ombres</label>
      <label>Résolution <input id="devPr" type="range" min="0.5" max="3" step="0.25"></label>
      <label>Champ <input id="devFov" type="range" min="20" max="100" step="1"></label>
    </div>
    <h4>Performances</h4><pre id="devStats"></pre>
    <h4>Données</h4><pre id="devEtat"></pre>
    <div class="rang"><button data-a="copier">Copier l'état</button><button data-a="vider">Vider les caches</button></div>`;
  const $ = <T extends HTMLElement>(s: string) => p.querySelector(s) as T;

  bouton.onclick = () => { p.hidden = !p.hidden; if (!p.hidden) calques(); };

  // Accès
  const actions: Record<string, () => void> = {
    studio: () => { p.hidden = true; ctx.ouvrirStudio(); },
    plan: () => { p.hidden = true; ctx.ouvrirPlan(); },
    haut: () => { const t = ctx.controls.target; ctx.camera.position.set(t.x, t.y + 600, t.z + 1); },
    libre: () => {
      const c = ctx.controls;
      c.minDistance = 0.5; c.maxDistance = 20000; c.maxPolarAngle = Math.PI; c.enablePan = true;
      c.screenSpacePanning = true;
    },
    chercher: () => void chercher($<HTMLInputElement>('#devAdresse').value, true),
    carte: () => { p.hidden = true; ctx.carte2D(); },
    copier: () => { void navigator.clipboard?.writeText(JSON.stringify(ctx.etat(), null, 2)).catch(() => undefined); },
    vider: async () => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* indisponible */ }
      try { for (const d of (await indexedDB.databases?.()) ?? []) if (d.name) indexedDB.deleteDatabase(d.name); } catch { /* indisponible */ }
      try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* indisponible */ }
      location.reload();
    },
  };
  p.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => (b.onclick = () => void actions[b.dataset.a!]?.()));

  // Recherche d'adresse → monde 3D
  const ouvrir = (a: Adresse) => { p.hidden = true; $('#devSugg').innerHTML = ''; ctx.charger(a); };
  let jeton = 0, minuteur = 0;
  async function chercher(q: string, direct = false) {
    const sugg = $('#devSugg');
    if (q.trim().length < 3) return void (sugg.innerHTML = '');
    const n = ++jeton;
    try {
      const res = await geocoder(q, 6);
      if (n !== jeton) return;
      if (direct && res[0]) return ouvrir(res[0]);
      sugg.innerHTML = '';
      for (const a of res) {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = 'display:block;width:100%;text-align:left';
        b.textContent = a.label;
        b.onclick = () => ouvrir(a);
        sugg.append(b);
      }
      if (!res.length) sugg.textContent = 'Aucune adresse trouvée.';
    } catch (e) { sugg.textContent = String(e); }
  }
  const champ = $<HTMLInputElement>('#devAdresse');
  champ.oninput = () => { clearTimeout(minuteur); minuteur = window.setTimeout(() => void chercher(champ.value), 250); };
  champ.onkeydown = (e) => { if (e.key === 'Enter') void chercher(champ.value, true); };
  p.querySelectorAll<HTMLButtonElement>('[data-lieu]').forEach((b) => (b.onclick = () => void chercher(LIEUX[+b.dataset.lieu!]![1], true)));

  // Calques : chaque objet de la scène peut être masqué
  function calques() {
    const box = $('#devCalques');
    box.innerHTML = '';
    ctx.scene.children.forEach((o, i) => {
      const nom = o.name || o.type;
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" ${o.visible ? 'checked' : ''}> ${nom} <span style="color:#888">#${i}</span>`;
      l.querySelector('input')!.onchange = (e) => (o.visible = (e.target as HTMLInputElement).checked);
      box.append(l);
    });
  }
  $<HTMLInputElement>('#devFil').onchange = (e) => {
    const on = (e.target as HTMLInputElement).checked;
    ctx.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const x of Array.isArray(m) ? m : m ? [m] : []) if ('wireframe' in x) (x as THREE.MeshStandardMaterial).wireframe = on;
    });
  };
  $<HTMLInputElement>('#devOmbres').onchange = (e) => {
    ctx.renderer.shadowMap.enabled = (e.target as HTMLInputElement).checked;
    ctx.scene.traverse((o) => { const m = (o as THREE.Mesh).material; for (const x of Array.isArray(m) ? m : m ? [m] : []) x.needsUpdate = true; });
  };
  const pr = $<HTMLInputElement>('#devPr');
  pr.value = String(ctx.renderer.getPixelRatio());
  pr.oninput = () => { ctx.renderer.setPixelRatio(+pr.value); dispatchEvent(new Event('resize')); };
  const fov = $<HTMLInputElement>('#devFov');
  fov.value = String(ctx.camera.fov);
  fov.oninput = () => { ctx.camera.fov = +fov.value; ctx.camera.updateProjectionMatrix(); };

  // Stats (rafraîchies 2×/s quand le panneau est ouvert)
  let images = 0, t0 = performance.now();
  const compter = () => { images++; requestAnimationFrame(compter); };
  requestAnimationFrame(compter);
  setInterval(() => {
    const t = performance.now(), ips = (images * 1000) / (t - t0);
    images = 0; t0 = t;
    if (p.hidden) return;
    const i = ctx.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    $('#devStats').textContent =
      `${ips.toFixed(0)} images/s · ${i.render.calls} appels · ${(i.render.triangles / 1e6).toFixed(2)} M triangles\n` +
      `${i.memory.geometries} géométries · ${i.memory.textures} textures` +
      (mem ? ` · ${(mem.usedJSHeapSize / 1e6).toFixed(0)} Mo JS` : '') +
      `\ncaméra ${ctx.camera.position.toArray().map((v) => v.toFixed(1)).join(', ')}`;
    $('#devEtat').textContent = JSON.stringify(ctx.etat(), null, 1).slice(0, 1500);
  }, 500);
}
