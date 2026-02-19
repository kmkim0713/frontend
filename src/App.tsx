import { useState, useRef, useEffect, FC } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import type {
  TypedSocket,
  TransportData,
  ConsumerData,
  ProducerRefs,
  PeersState,
  ConsumerTransportsRef,
  IceServerConfig,
} from './types';

// 환경 변수에서 서버 주소 로드
const SIGNALING_SERVER: string = import.meta.env.VITE_SIGNALING_SERVER;
const ICE_SERVERS: IceServerConfig[] = [
  { urls: import.meta.env.VITE_STUN_SERVER },
  {
    urls: import.meta.env.VITE_TURN_SERVER,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  },
];

const App: FC = () => {
  // form 입력: useState
  const [meetingId, setMeetingId] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [userName, setUserName] = useState<string>('');

  // 상태
  const [joined, setJoined] = useState<boolean>(false);
  const [peers, setPeers] = useState<PeersState>({});

  // 참조
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<ProducerRefs | null>(null);
  const consumerTransportsRef = useRef<ConsumerTransportsRef>({});
  const currentMeetingIdRef = useRef<string | null>(null);

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
      // 1. 검증
      if (!meetingId.trim() || !userId.trim() || !userName.trim()) {
        alert('미팅 ID, 사용자 ID, 이름을 모두 입력해주세요.');
        return;
      }

      // 2. 소켓 연결
      socketRef.current = io(SIGNALING_SERVER);
      setJoined(true);
      const stream = await startLocalStream();

      // 3. 세션 ref에 저장 (leave 시 input 재참조 방지)
      currentMeetingIdRef.current = meetingId;

      // 4. join-room emit
      socketRef.current.emit('join-room', { meetingId, userId, userName }, async ({ existingProducers }) => {
        console.log('기존 프로듀서들:', existingProducers);

        for (const peerInfo of existingProducers) {
          const { peerId, producers, userId: peerUserId, userName: peerUserName } = peerInfo;

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
              const existingStream = prev[peerId];
              const newStream = existingStream ? existingStream.stream : new MediaStream();
              newStream.addTrack(consumer.track);
              return {
                ...prev,
                [peerId]: {
                  stream: newStream,
                  userId: peerUserId,
                  userName: peerUserName,
                }
              };
            });
          }
        }
      });

      // 1. 서버로부터 Router RTP Capabilities 받기
      const rtpCapabilities = await new Promise<mediasoupClient.types.RtpCapabilities>(resolve => {
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
      socketRef.current.on('newConsumer', async ({ producerId, id, kind, userId: peerUserId, userName: peerUserName }) => {
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

          setPeers(prev => ({
            ...prev,
            [id]: {
              stream: newStream,
              userId: peerUserId,
              userName: peerUserName,
            }
          }));
        }
      });

      socketRef.current.on('peer-disconnected', (peerId: string) => {
        console.log("disconnect?")
        setPeers(prev => {
          const peerInfo = prev[peerId];
          if (peerInfo) peerInfo.stream.getTracks().forEach(track => track.stop());
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

    // 입력 DOM 재참조 없이 세션 ref 사용
    socketRef.current?.emit('leave-room', { meetingId: currentMeetingIdRef.current! });

    socketRef.current?.disconnect();
    socketRef.current = null;
    currentMeetingIdRef.current = null;
  };

  useEffect(() => {
    console.log("🛑🛑🛑 ~~~ :177 ~~~ App ~~~ peers:", peers);
  }, [peers])

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 20, display: 'flex', gap: 10, flexDirection: 'column' }}>
        <div>
          <label style={{ display: 'block', marginBottom: 5 }}>미팅 ID</label>
          <input
            value={meetingId}
            onChange={e => setMeetingId(e.target.value)}
            placeholder="미팅 ID 입력"
            disabled={joined}
            style={{ padding: 8, width: '100%', maxWidth: 300 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 5 }}>사용자 ID</label>
          <input
            value={userId}
            onChange={e => setUserId(e.target.value)}
            placeholder="사용자 ID 입력"
            disabled={joined}
            style={{ padding: 8, width: '100%', maxWidth: 300 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 5 }}>이름</label>
          <input
            value={userName}
            onChange={e => setUserName(e.target.value)}
            placeholder="이름 입력"
            disabled={joined}
            style={{ padding: 8, width: '100%', maxWidth: 300 }}
          />
        </div>
      </div>

      {!joined && <button onClick={handleJoin} style={{ padding: '10px 20px', cursor: 'pointer' }}>입장</button>}
      {joined && <button onClick={handleLeave} style={{ padding: '10px 20px', cursor: 'pointer', backgroundColor: '#ff6b6b', color: 'white' }}>퇴장</button>}

      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 20 }}>
        <div style={{ margin: 10 }}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ width: 200, height: 150, backgroundColor: '#000' }}
          />
          <p>나 ({userName})</p>
        </div>
        {Object.entries(peers).map(([id, peerInfo]) => (
          <div key={id} style={{ margin: 10 }}>
            <video
              ref={el => {
                if (el) el.srcObject = peerInfo.stream;
              }}
              autoPlay
              playsInline
              style={{ width: 200, height: 150, backgroundColor: '#000' }}
            />
            <p>{peerInfo.userName} ({peerInfo.userId})</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
