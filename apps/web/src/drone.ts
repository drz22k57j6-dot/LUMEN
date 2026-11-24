/**
 * Mode drone : vol libre pour inspecter la ville de près (façades, sol, arbres), sur iPhone comme sur ordinateur.
 * Quand le drone s'éloigne de la zone chargée, le quartier se recharge autour de lui (LiDAR, façades, sol…)
 * sans le faire atterrir : on peut parcourir tout Paris (et toute la France) en volant.
 *
 * iPhone : joystick gauche = avancer / glisser, joystick droit = tourner / regarder, ▲ ▼ = monter / descendre.
 * Ordinateur : ZQSD ou WASD (ou flèches) pour avancer, Espace / Maj pour monter / descendre, glisser la souris pour regarder.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ContexteDrone {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  /** Altitude locale du sol sous un point local (x, z), ou null hors zone. */
  sol: (x: number, z: number) => number | null;
  /** Demande de rechargement du quartier autour d'un point local (x, z). */
  recentrer: (x: number, z: number) => void;
  /** Rayon (m) au-delà duquel on recharge autour du drone. */
  rayon: number;
  chargementEnCours: () => boolean;
}

export function initDrone(ctx: ContexteDrone) {
  const { camera, controls } = ctx;
  let actif = false, yaw = 0, pitch = -0.25, vitesse = 12;
  const mouv = { av: 0, lat: 0, vert: 0, yaw: 0, pitch: 0 };
  const touches = new Set<string>();
  let immobile = 0;

  const hud = document.createElement('div');
  hud.id = 'drone';
  hud.hidden = true;
  hud.innerHTML = `
    <div class="dr-haut">
      <button id="drQuitter" class="pastille" type="button">✕ Quitter le drone</button>
      <label class="pastille dr-vit">Vitesse <input id="drVit" type="range" min="1" max="60" step="1" value="12" /> <b id="drVitTxt">12 m/s</b></label>
      <span id="drInfo" class="pastille"></span>
    </div>
    <div class="dr-joy" id="drGauche"><div></div></div>
    <div class="dr-joy" id="drDroite"><div></div></div>
    <div class="dr-alt"><button id="drMonter" type="button">▲</button><button id="drDescendre" type="button">▼</button></div>`;
  document.body.append(hud);
  const style = document.createElement('style');
  style.textContent = `
    #drone{position:fixed;inset:0;z-index:15;pointer-events:none}
    #drone[hidden]{display:none}
    #drone .dr-haut{position:absolute;top:calc(env(safe-area-inset-top) + 10px);left:10px;right:64px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:auto}
    #drone .pastille{background:#111c;color:#fff;border:1px solid #fff3;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
    #drone .dr-vit{display:flex;align-items:center;gap:6px;font-size:13px}
    #drone .dr-vit input{width:110px;accent-color:#ffc21a}
    #drone .dr-joy{position:absolute;bottom:calc(env(safe-area-inset-bottom) + 28px);width:130px;height:130px;border-radius:50%;background:#ffffff1a;border:1px solid #ffffff40;pointer-events:auto;touch-action:none;display:grid;place-items:center}
    #drone .dr-joy>div{width:52px;height:52px;border-radius:50%;background:#ffffffcc;pointer-events:none}
    #drGauche{left:22px} #drDroite{right:22px}
    #drone .dr-alt{position:absolute;right:30px;bottom:calc(env(safe-area-inset-bottom) + 175px);display:flex;flex-direction:column;gap:10px;pointer-events:auto}
    #drone .dr-alt button{width:54px;height:54px;border-radius:50%;border:1px solid #fff4;background:#111c;color:#fff;font-size:20px;touch-action:none}
    body.drone-actif #feuille, body.drone-actif .feuille{display:none !important}`;
  document.head.append(style);
  const $ = <T extends HTMLElement>(s: string) => hud.querySelector(s) as T;

  // Joysticks (tactile et souris)
  function joystick(el: HTMLElement, f: (x: number, y: number) => void) {
    let id = -1, cx = 0, cy = 0;
    const bouton = el.firstElementChild as HTMLElement;
    el.addEventListener('pointerdown', (e) => {
      id = e.pointerId; el.setPointerCapture(id);
      const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let x = (e.clientX - cx) / 50, y = (e.clientY - cy) / 50;
      const l = Math.hypot(x, y);
      if (l > 1) (x /= l), (y /= l);
      bouton.style.transform = `translate(${x * 38}px, ${y * 38}px)`;
      f(x, y);
    });
    const fin = () => { id = -1; bouton.style.transform = ''; f(0, 0); };
    el.addEventListener('pointerup', fin);
    el.addEventListener('pointercancel', fin);
  }
  joystick($('#drGauche'), (x, y) => { mouv.lat = x; mouv.av = -y; });
  joystick($('#drDroite'), (x, y) => { mouv.yaw = -x; mouv.pitch = -y; });
  const maintenir = (b: HTMLElement, v: number) => {
    b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); mouv.vert = v; });
    const fin = () => (mouv.vert = 0);
    b.addEventListener('pointerup', fin);
    b.addEventListener('pointercancel', fin);
  };
  maintenir($('#drMonter'), 1);
  maintenir($('#drDescendre'), -1);
  $<HTMLInputElement>('#drVit').oninput = (e) => { vitesse = +(e.target as HTMLInputElement).value; $('#drVitTxt').textContent = `${vitesse} m/s`; };
  $('#drQuitter').onclick = () => basculer(false);

  // Ordinateur : clavier + souris
  addEventListener('keydown', (e) => { if (actif && !(e.target instanceof HTMLInputElement)) touches.add(e.key.toLowerCase()); });
  addEventListener('keyup', (e) => touches.delete(e.key.toLowerCase()));
  let glisse: { x: number; y: number } | null = null;
  ctx.canvas.addEventListener('pointerdown', (e) => { if (actif && e.pointerType === 'mouse') glisse = { x: e.clientX, y: e.clientY }; });
  addEventListener('pointermove', (e) => {
    if (!glisse) return;
    yaw -= (e.clientX - glisse.x) * 0.004;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - glisse.y) * 0.004, -1.5, 1.2);
    glisse = { x: e.clientX, y: e.clientY };
  });
  addEventListener('pointerup', () => (glisse = null));

  function basculer(on: boolean) {
    actif = on;
    hud.hidden = !on;
    document.body.classList.toggle('drone-actif', on);
    controls.enabled = !on;
    if (on) {
      const d = new THREE.Vector3();
      camera.getWorldDirection(d);
      yaw = Math.atan2(-d.x, -d.z);
      pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      camera.near = 0.1;
      camera.updateProjectionMatrix();
    } else {
      const d = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
      controls.target.copy(camera.position).addScaledVector(d, 20);
      controls.update();
    }
  }

  /** À appeler à chaque image. */
  function maj(dt: number) {
    if (!actif) return;
    let av = mouv.av, lat = mouv.lat, vert = mouv.vert;
    if (touches.has('z') || touches.has('w') || touches.has('arrowup')) av = 1;
    if (touches.has('s') || touches.has('arrowdown')) av = -1;
    if (touches.has('q') || touches.has('a') || touches.has('arrowleft')) lat = -1;
    if (touches.has('d') || touches.has('arrowright')) lat = 1;
    if (touches.has(' ')) vert = 1;
    if (touches.has('shift')) vert = -1;
    yaw += mouv.yaw * dt * 1.6;
    pitch = THREE.MathUtils.clamp(pitch + mouv.pitch * dt * 1.2, -1.5, 1.2);
    const v = vitesse * dt;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    camera.position.x += (fx * av + Math.cos(yaw) * lat) * v;
    camera.position.z += (fz * av - Math.sin(yaw) * lat) * v;
    camera.position.y += vert * v * 0.7;
    const s = ctx.sol(camera.position.x, camera.position.z);
    if (s !== null) camera.position.y = Math.max(camera.position.y, s + 1.2); // jamais sous le sol
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const bouge = Math.abs(av) + Math.abs(lat) + Math.abs(vert) > 0.05;
    immobile = bouge ? 0 : immobile + dt;
    const loin = Math.hypot(camera.position.x, camera.position.z);
    $('#drInfo').textContent = ctx.chargementEnCours() ? 'Chargement du quartier…' : `${Math.round(camera.position.y - (s ?? 0))} m sol`;
    // Recharge autour du drone quand on sort de la zone (dès qu'on ralentit, ou tout de suite si on est très loin)
    if (!ctx.chargementEnCours() && loin > ctx.rayon && (immobile > 0.4 || loin > ctx.rayon * 1.8)) ctx.recentrer(camera.position.x, camera.position.z);
  }

  return {
    basculer,
    maj,
    get actif() { return actif; },
    /** Après rechargement : replace la caméra (repère local du nouveau quartier). */
    poser(p: THREE.Vector3) { camera.position.copy(p); camera.rotation.set(pitch, yaw, 0, 'YXZ'); },
  };
}
