export interface User {
  userId: string;
  userName: string;
}

export interface IceServerConfig extends RTCIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface PeerInfo {
  stream: MediaStream;
  userId: string;
  userName: string;
}

export type PeersState = Record<string, PeerInfo>;
