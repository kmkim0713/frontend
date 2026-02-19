import { types } from 'mediasoup-client';

export interface TransportData {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

export interface ConsumerData {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

export interface ProducerRefs {
  video: types.Producer | null;
  audio: types.Producer | null;
}

export type ConsumerTransportsRef = Record<string, types.Transport>;
