/**
 * Minimal request surface the thread/turn control layers need from the App
 * Server connection. Contract tests substitute a fake; production wiring
 * passes a CodexAppServerConnection.
 */
export interface CodexRequester {
  request(method: string, params: unknown): Promise<unknown>;
}
