import { useState, useRef, useEffect, FC } from 'react';
import io, { Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { types } from 'mediasoup-client';

// Socket.IO 서버→클라이언트 이벤트 타입
interface ServerToClientEvents {
  'rtp-capabilities': (rtpCapabilities: types.RtpCapabilities) => void;
  'newConsumer': (data: {
    producerId: string;
    id: string;
    kind: types.MediaKind;
  }) => void;
  'peer-disconnected': (peerId: string) => void;
}

// Socket.IO 클라이언트→서버 이벤트 타입
interface ClientToServerEvents {
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

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// 커스텀 타입 정의
interface TransportData {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

interface ConsumerData {
  id: string;
  producerId: string;
  kind: types.MediaKind;
  rtpParameters: types.RtpParameters;
}

interface ProducerRefs {
  video: types.Producer | null;
  audio: types.Producer | null;
}

type PeersState = Record<string, MediaStream>;
type ConsumerTransportsRef = Record<string, types.Transport>;

interface IceServerConfig extends RTCIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

const App: FC = () => {
  // 상수
  const SIGNALING_SERVER: string = 'http://localhost:3000';
  const ICE_SERVERS: IceServerConfig[] = [
    { urls: 'stun:127.0.0.1:3478' },
    { urls: 'turn:127.0.0.1:3478', username: 'user1', credential: 'pass1' }
  ];
  const roomId: string = 'default';

  // 상태
  const [joined, setJoined] = useState<boolean>(false);
  const [peers, setPeers] = useState<PeersState>({});

  // 참조
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const deviceRef = useRef<types.Device | null>(null);
  const sendTransportRef = useRef<types.Transport | null>(null);
  const producerRef = useRef<ProducerRefs | null>(null);
  const consumerTransportsRef = useRef<ConsumerTransportsRef>({});

  // 로컬 스트림 시작
  const startLocalStream = async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  };

  // 입장 처리
  const handleJoin = async (): Promise<void> => {
    console.log("🛑🛑🛑 ~~~ :35 ~~~ handleJoin ~~~ socketRef.current:", socketRef.current);

    if (socketRef.current === null) {
      socketRef.current = io(SIGNALING_SERVER);
      setJoined(true);
      const stream = await startLocalStream();

      socketRef.current.emit('join-room', { roomId }, async ({ existingProducers }) => {
        console.log('기존 프로듀서들:', existingProducers);

        for (const peerInfo of existingProducers) {
          const { peerId, producers } = peerInfo;

          if (!consumerTransportsRef.current[peerId]) {
            const recvTransportData = await new Promise<TransportData>(resolve =>
              socketRef.current?.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
            );

            const recvTransport = deviceRef.current?.createRecvTransport({
              ...recvTransportData,
              iceServers: ICE_SERVERS
            });

            if (recvTransport) {
              recvTransport.on('connect', ({ dtlsParameters }, callback) => {
                socketRef.current?.emit('connect-transport', { transportId: recvTransport.id, dtlsParameters }, callback);
              });

              consumerTransportsRef.current[peerId] = recvTransport;
            }
          }

          const recvTransport = consumerTransportsRef.current[peerId];

          for (const producer of producers) {
            const { id: producerId, kind } = producer;

            const consumerData = await new Promise<ConsumerData>(resolve =>
              socketRef.current?.emit('consume', { transportId: recvTransport.id, producerId, kind }, resolve)
            );

            const consumer = await recvTransport.consume({
              id: consumerData.id,
              producerId,
              kind: consumerData.kind,
              rtpParameters: consumerData.rtpParameters
            });

            setPeers(prev => {
              const existingStream = prev[peerId] || new MediaStream();
              existingStream.addTrack(consumer.track);
              return { ...prev, [peerId]: existingStream };
            });
          }
        }
      });

      // 1. 서버로부터 Router RTP Capabilities 받기
      const rtpCapabilities = await new Promise<types.RtpCapabilities>(resolve => {
        socketRef.current?.once('rtp-capabilities', resolve);
      });
      console.log('RTP Capabilities', rtpCapabilities);

      // 2. Mediasoup Device 생성
      const device = new mediasoupClient.Device();

      await device.load({ routerRtpCapabilities: rtpCapabilities });
      deviceRef.current = device;

      // 3. Send Transport 생성
      const sendTransportData = await new Promise<TransportData>(resolve => {
        socketRef.current?.emit('create-web-rtc-transport', {}, resolve);
      });

      const sendTransport = device.createSendTransport({
        ...sendTransportData,
        iceServers: ICE_SERVERS
      });
      sendTransportRef.current = sendTransport;

      sendTransport.on('connect', ({ dtlsParameters }, callback) => {
        socketRef.current?.emit('connect-transport', { transportId: sendTransport.id, dtlsParameters }, callback);
      });

      sendTransport.on('produce', async ({ kind, rtpParameters }, callback) => {
        const { id } = await new Promise<{ id: string }>(resolve =>
          socketRef.current?.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, resolve)
        );
        callback({ id });
      });

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      producerRef.current = {
        video: await sendTransport.produce({ track: videoTrack }),
        audio: await sendTransport.produce({ track: audioTrack }),
      };

      // 4. 서버로부터 다른 참여자 정보 받기
      socketRef.current.on('newConsumer', async ({ producerId, id, kind }) => {
        if (!consumerTransportsRef.current[id]) {
          const recvTransportData = await new Promise<TransportData>(resolve =>
            socketRef.current?.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
          );

          const recvTransport = device.createRecvTransport({
            ...recvTransportData,
            iceServers: ICE_SERVERS
          });

          recvTransport.on('connect', ({ dtlsParameters }, callback) => {
            socketRef.current?.emit('connect-transport', { transportId: recvTransport.id, dtlsParameters }, callback);
          });

          consumerTransportsRef.current[id] = recvTransport;

          const consumerData = await new Promise<ConsumerData>(resolve =>
            socketRef.current?.emit('consume', { transportId: recvTransport.id, producerId, kind }, resolve)
          );

          const consumer = await recvTransport.consume({
            id: consumerData.id,
            producerId,
            kind: consumerData.kind,
            rtpParameters: consumerData.rtpParameters,
          });

          const newStream = new MediaStream();
          newStream.addTrack(consumer.track);

          setPeers(prev => ({ ...prev, [id]: newStream }));
        }
      });

      socketRef.current.on('peer-disconnected', (peerId: string) => {
        console.log("disconnect?")
        setPeers(prev => {
          const stream = prev[peerId];
          if (stream) stream.getTracks().forEach(track => track.stop());
          const { [peerId]: _, ...rest } = prev;
          return rest;
        });
      });
    }
  };

  // 퇴장 처리
  const handleLeave = (): void => {
    if (producerRef.current) {
      producerRef.current.video?.close();
      producerRef.current.audio?.close();
    }

    sendTransportRef.current?.close();

    Object.values(consumerTransportsRef.current).forEach(t => t.close());
    consumerTransportsRef.current = {};

    const stream = localVideoRef.current?.srcObject as MediaStream | null;
    if (stream) {
      stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    setPeers({});
    setJoined(false);

    socketRef.current?.emit('leave-room', { roomId });

    socketRef.current?.disconnect();
    socketRef.current = null;
  };

  useEffect(() => {
    console.log("🛑🛑🛑 ~~~ :177 ~~~ App ~~~ peers:", peers);
  }, [peers])

  return (
    <div style={{ padding: 20 }}>
      {!joined && <button onClick={handleJoin}>입장</button>}
      {joined && <button onClick={handleLeave}>퇴장</button>}
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 20 }}>
        <div style={{ margin: 10 }}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: 200, height: 150, backgroundColor: '#000' }}
          />
          <p>나</p>
        </div>
        {Object.entries(peers).map(([id, stream]) => (
          <div key={id} style={{ margin: 10 }}>
            <video
              ref={el => {
                if (el) el.srcObject = stream;
              }}
              autoPlay
              playsInline
              style={{ width: 200, height: 150, backgroundColor: '#000' }}
            />
            <p>{id}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
