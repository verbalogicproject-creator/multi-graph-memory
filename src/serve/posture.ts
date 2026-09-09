/**
 * Who may reach this server, decided before it listens.
 *
 * The rule is multi-app's `auth/config.js` invariant, not a new one:
 * **reachable from the network or unauthenticated, but not both.** It is
 * deliberately not "auth is off in development", because that is the shape
 * that works on a laptop and is wide open the moment the host stops being
 * loopback.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   loopback + no key      -> start, warn, name what is missing
 *   loopback + key         -> start, enforce
 *   non-loopback + no key  -> refuse to listen at all
 *
 * Pure so `npm test` can assert every branch without binding a socket.
 */

/** Ports this server must never choose for itself. */
export const CONTENDED_PORTS: ReadonlyMap<number, string> = new Map([
  [8080, "contended on this device — a stranger holding it hangs a dev proxy rather than failing it"],
  [8050, "multi-app's Express backend"],
  [5173, "Vite's dev server"],
  [8144, "the local reranker"],
  [8145, "the local embedder"],
  [8147, "the local generator"],
  [8148, "the classify proxy"],
]);

/**
 * The default. Clear of the model stack at 8144-8148 and of the app ports,
 * with room either side, so nothing here has to move when one of those grows.
 */
export const DEFAULT_PORT = 8321;
export const DEFAULT_HOST = "127.0.0.1";

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1";
}

export interface Posture {
  /** Present when the server must not listen. */
  readonly fatal?: string;
  /** Present when it may listen but the operator should know something. */
  readonly warning?: string;
  readonly enforcesAuth: boolean;
}

export function bootPosture(host: string, apiKey: string | undefined, port: number): Posture {
  const contended = CONTENDED_PORTS.get(port);
  if (contended) {
    return {
      fatal:
        `refusing to listen on ${port}: ${contended}. Pass --port with something else.`,
      enforcesAuth: Boolean(apiKey),
    };
  }
  if (!isLoopback(host)) {
    if (!apiKey) {
      return {
        fatal:
          `refusing to listen on ${host}:${port} with no --api-key. This server reads the ` +
          `memory stores, so a non-loopback bind without a key would publish them to the ` +
          `network. Bind ${DEFAULT_HOST}, or set one.`,
        enforcesAuth: false,
      };
    }
    return { enforcesAuth: true };
  }
  if (!apiKey) {
    return {
      warning:
        `no --api-key: every caller on this machine may read the graph. Fine on ${DEFAULT_HOST}, ` +
        `and the reason a non-loopback bind refuses to start without one.`,
      enforcesAuth: false,
    };
  }
  return { enforcesAuth: true };
}
