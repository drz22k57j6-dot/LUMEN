// Lumière du jour calculée à partir de l'atmosphère (ciel clair), sans réglage à l'œil.
// - Masse d'air : Kasten & Young (1989).
// - Épaisseurs optiques à 680 / 550 / 440 nm (canaux R, V, B) :
//   Rayleigh (Bodhaine et al. 1999), aérosols (Ångström, β = 0,06, α = 1,3 : ciel clair urbain),
//   ozone (bande de Chappuis, 0,3 atm-cm).
// - Direct : loi de Beer-Lambert ; diffus : diffusion simple (moitié Rayleigh, 80 % aérosols vers le sol).
// - Crépuscule : décroissance mesurée de l'éclairement (≈ 400 lx à 0°, 3 lx à −6°, 0,001 lx la nuit).
// Éclairement solaire hors atmosphère : 128 000 lx (blanc, soleil ≈ 5 800 K).

export interface Atmosphere {
  /** Coefficient de trouble d'Ångström (aérosols à 1 µm). */
  beta: number;
  /** Exposant d'Ångström. */
  alpha: number;
  /** Colonne d'ozone (atm-cm). */
  ozone: number;
}
export const CIEL_CLAIR: Atmosphere = { beta: 0.06, alpha: 1.3, ozone: 0.3 };

export interface Eclairement {
  /** Éclairement direct normal au rayon (lux). */
  directNormal: number;
  /** Éclairement diffus du ciel sur un plan horizontal (lux). */
  diffusHorizontal: number;
  /** Éclairement global horizontal (lux). */
  globalHorizontal: number;
  /** Couleur linéaire du soleil (max = 1). */
  couleurSoleil: [number, number, number];
  /** Couleur linéaire du ciel (max = 1). */
  couleurCiel: [number, number, number];
}

const E0 = 128_000;
const LAMBDA = [0.68, 0.55, 0.44] as const;
const OZONE_K = [0.04, 0.09, 0.004] as const; // cm⁻¹
const LUM = [0.2126, 0.7152, 0.0722] as const;

/** Masse d'air relative pour une élévation apparente (degrés). */
export function masseAir(elevation: number): number {
  const z = 90 - Math.max(elevation, -0.5);
  return 1 / (Math.cos((z * Math.PI) / 180) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
}

const rayleigh = (l: number) => 0.008569 * l ** -4 * (1 + 0.0113 * l ** -2 + 0.00013 * l ** -4);
const norm = (v: number[]): [number, number, number] => {
  const m = Math.max(...v, 1e-12);
  return [v[0]! / m, v[1]! / m, v[2]! / m];
};

export function eclairement(elevation: number, atm: Atmosphere = CIEL_CLAIR): Eclairement {
  const h = Math.max(elevation, 0);
  const m = masseAir(h);
  const T: number[] = [], S: number[] = [];
  LAMBDA.forEach((l, i) => {
    const tR = rayleigh(l) * m, tA = atm.beta * l ** -atm.alpha * m, tO = atm.ozone * OZONE_K[i]! * m;
    T.push(Math.exp(-(tR + tA + tO)));
    S.push(Math.exp(-tO) * (0.5 * (1 - Math.exp(-tR)) + 0.8 * (1 - Math.exp(-tA)) * Math.exp(-0.5 * tR)));
  });
  const lum = (v: number[]) => v.reduce((s, x, i) => s + x * LUM[i]!, 0);
  const sinh = Math.sin((h * Math.PI) / 180);
  let directNormal = E0 * lum(T);
  let diffusHorizontal = E0 * sinh * lum(S);
  // Crépuscule : le soleil passe sous l'horizon, seul le ciel éclaire.
  const crep = (e: number) => (e >= -6 ? 400 * Math.pow(400 / 3, e / 6) : Math.max(0.001, 3 * Math.pow(10, (e + 6) / 2)));
  if (elevation < 0) (directNormal = 0), (diffusHorizontal = crep(elevation));
  else diffusHorizontal = Math.max(diffusHorizontal, crep(0)); // continuité au lever / coucher
  const couleurCiel: [number, number, number] =
    elevation < -2 ? [0.35, 0.45, 1] : norm(S.map((s, i) => s + (elevation < 4 ? T[i]! * 0.05 : 0)));
  return {
    directNormal,
    diffusHorizontal,
    globalHorizontal: directNormal * sinh + diffusHorizontal,
    couleurSoleil: norm(T),
    couleurCiel,
  };
}
