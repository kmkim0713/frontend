export interface IceServerConfig extends RTCIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export type PeersState = Record<string, MediaStream>;
