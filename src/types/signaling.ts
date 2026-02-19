import { Socket } from 'socket.io-client';
import { types } from 'mediasoup-client';
import type { TransportData, ConsumerData } from './mediasoup';

export interface ServerToClientEvents {
  'rtp-capabilities': (rtpCapabilities: types.RtpCapabilities) => void;
  'newConsumer': (data: {
    producerId: string;
    id: string;
    kind: types.MediaKind;
  }) => void;
  'peer-disconnected': (peerId: string) => void;
}

export interface ClientToServerEvents {
  'join-room': (
    data: { roomId: string },
    callback: (response: {
      existingProducers: Array<{
        peerId: string;
        producers: Array<{
          id: string;
          kind: types.MediaKind;
        }>;
      }>;
    }) => void
  ) => void;
  'create-web-rtc-transport': (
    data: { direction?: 'recv' | 'send' },
    callback: (transportData: TransportData) => void
  ) => void;
  'connect-transport': (
    data: {
      transportId: string;
      dtlsParameters: types.DtlsParameters;
    },
    callback: () => void
  ) => void;
  'produce': (
    data: {
      transportId: string;
      kind: types.MediaKind;
      rtpParameters: types.RtpParameters;
    },
    callback: (response: { id: string }) => void
  ) => void;
  'consume': (
    data: {
      transportId: string;
      producerId: string;
      kind: types.MediaKind;
    },
    callback: (consumerData: ConsumerData) => void
  ) => void;
  'leave-room': (data: { roomId: string }) => void;
}

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
