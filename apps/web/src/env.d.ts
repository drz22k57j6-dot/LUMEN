/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** « 1 » : inclut le mode développeur dans le build. Absent : le code du mode dev n'existe pas dans le site. */
  readonly VITE_MODE_DEV?: string;
}
