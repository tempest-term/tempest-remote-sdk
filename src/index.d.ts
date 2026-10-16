export interface Server {
  /** Opaque saved-server identifier. Do not decode or reconstruct. */
  id: string;
  label: string;
  description?: string;
}

export interface Remote {
  sshHost: string;
  sessionId: string;
}

export interface Prompt {
  type: 'prompt';
  id: string;
  kind: 'password' | 'text' | 'confirm' | 'select';
  message: string;
  choices?: Array<{ id: string; label: string }>;
}

/** undefined explicitly cancels; empty strings and false are preserved. */
export type PromptAnswer = string | boolean | undefined;
export interface ControlOptions {
  account?: string;
  /** Defaults to ten minutes, including authentication interaction. */
  timeoutMs?: number;
  /** Incoming frame limit. Defaults to 8 MiB; outgoing frames are always <=64 KiB. */
  maxFrameBytes?: number;
  /** Receives method names and safe outcomes only, never frames or answers. */
  onTrace?: (message: string) => void;
}

export class ControlClient {
  constructor(executable: string, prompt: (prompt: Prompt) => PromptAnswer | Promise<PromptAnswer>, options?: ControlOptions);
  readonly closed: boolean;
  request(method: 'capabilities', params?: Record<string, never>): Promise<{ protocol: number }>;
  request(method: 'servers.list', params?: Record<string, never>): Promise<Server[]>;
  request(method: 'remote.ensure', params: { serverId: string; configFile?: string }): Promise<Remote>;
  /** Checks protocol v1 and validates the returned server entries. */
  listServers(): Promise<Server[]>;
  /** Checks protocol v1 and validates the returned host and session identity. */
  ensureRemote(serverId: string, options?: { configFile?: string }): Promise<Remote>;
  /** Terminates this setup process and rejects pending requests. */
  cancel(): void;
  /** After successful setup, releases control without terminating its tunnel. */
  dispose(): void;
}
