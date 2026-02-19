import { useState, useRef, FC } from 'react';
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
  User,
} from '../types';
import { styles } from "../styles/meetingPage";

interface MeetingPageProps {
  user: User;
  onLeaveApp: () => void;
}

const SIGNALING_SERVER: string = import.meta.env.VITE_SIGNALING_SERVER;
const ICE_SERVERS: IceServerConfig[] = [
  { urls: import.meta.env.VITE_STUN_SERVER },
  {
    urls: import.meta.env.VITE_TURN_SERVER,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  },
];


const MeetingPage: FC<MeetingPageProps> = ({ user, onLeaveApp }) => {
  
  const [meetingId, setMeetingId] = useState<string>('');
  const [joined, setJoined] = useState<boolean>(false);
  const [peers, setPeers] = useState<PeersState>({});
  const [activeTab, setActiveTab] = useState<'meeting' | 'guide'>('meeting');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<ProducerRefs | null>(null);
  const consumerTransportsRef = useRef<ConsumerTransportsRef>({});
  const currentMeetingIdRef = useRef<string | null>(null);
  const [resolution, setResolution] = useState<'360p' | '480p' | '720p'>('360p');

  const startLocalStream = async (): Promise<MediaStream> => {
    const getVideoConstraints = () => {
      switch (resolution) {
        case '360p':
          return { width: { ideal: 640 }, height: { ideal: 360 } };
        case '480p':
          return { width: { ideal: 640 }, height: { ideal: 480 } };
        case '720p':
        default:
          return { width: { ideal: 1280 }, height: { ideal: 720 } };
      }
    };

    console.log(getVideoConstraints())

    const stream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: true
    });

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  };

  const handleJoin = async (): Promise<void> => {
    if (socketRef.current === null) {
      if (!meetingId.trim()) {
        alert('미팅 ID를 입력해주세요.');
        return;
      }

      socketRef.current = io(SIGNALING_SERVER);
      setJoined(true);
      const stream = await startLocalStream();

      currentMeetingIdRef.current = meetingId;

      socketRef.current.emit(
        'join-room',
        { meetingId, userId: user.userId, userName: user.userName },
        async ({ existingProducers }) => {
          for (const peerInfo of existingProducers) {
            const { peerId, producers, userId: peerUserId, userName: peerUserName } = peerInfo;

            if (!consumerTransportsRef.current[peerId]) {
              const recvTransportData = await new Promise<TransportData>((resolve) =>
                socketRef.current?.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
              );

              const recvTransport = deviceRef.current?.createRecvTransport({
                ...recvTransportData,
                iceServers: ICE_SERVERS,
              });

              if (recvTransport) {
                recvTransport.on('connect', ({ dtlsParameters }, callback) => {
                  socketRef.current?.emit(
                    'connect-transport',
                    { transportId: recvTransport.id, dtlsParameters },
                    callback
                  );
                });

                consumerTransportsRef.current[peerId] = recvTransport;
              }
            }

            const recvTransport = consumerTransportsRef.current[peerId];

            for (const producer of producers) {
              const { id: producerId, kind } = producer;

              const consumerData = await new Promise<ConsumerData>((resolve) =>
                socketRef.current?.emit(
                  'consume',
                  { transportId: recvTransport.id, producerId, kind },
                  resolve
                )
              );

              const consumer = await recvTransport.consume({
                id: consumerData.id,
                producerId,
                kind: consumerData.kind,
                rtpParameters: consumerData.rtpParameters,
              });

              setPeers((prev) => {
                const existingStream = prev[peerId];
                const newStream = existingStream ? existingStream.stream : new MediaStream();
                newStream.addTrack(consumer.track);
                return {
                  ...prev,
                  [peerId]: {
                    stream: newStream,
                    userId: peerUserId,
                    userName: peerUserName,
                  },
                };
              });
            }
          }
        }
      );

      const rtpCapabilities = await new Promise<mediasoupClient.types.RtpCapabilities>((resolve) => {
        socketRef.current?.once('rtp-capabilities', resolve);
      });

      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });
      deviceRef.current = device;

      const sendTransportData = await new Promise<TransportData>((resolve) => {
        socketRef.current?.emit('create-web-rtc-transport', {}, resolve);
      });

      const sendTransport = device.createSendTransport({
        ...sendTransportData,
        iceServers: ICE_SERVERS,
      });
      sendTransportRef.current = sendTransport;

      sendTransport.on('connect', ({ dtlsParameters }, callback) => {
        socketRef.current?.emit('connect-transport', { transportId: sendTransport.id, dtlsParameters }, callback);
      });

      sendTransport.on('produce', async ({ kind, rtpParameters }, callback) => {
        const { id } = await new Promise<{ id: string }>((resolve) =>
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

      socketRef.current.on(
        'newConsumer',
        async ({ producerId, id, kind, userId: peerUserId, userName: peerUserName }) => {
          if (!consumerTransportsRef.current[id]) {
            const recvTransportData = await new Promise<TransportData>((resolve) =>
              socketRef.current?.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
            );

            const recvTransport = device.createRecvTransport({
              ...recvTransportData,
              iceServers: ICE_SERVERS,
            });

            recvTransport.on('connect', ({ dtlsParameters }, callback) => {
              socketRef.current?.emit(
                'connect-transport',
                { transportId: recvTransport.id, dtlsParameters },
                callback
              );
            });

            consumerTransportsRef.current[id] = recvTransport;

            const consumerData = await new Promise<ConsumerData>((resolve) =>
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

            setPeers((prev) => ({
              ...prev,
              [id]: {
                stream: newStream,
                userId: peerUserId,
                userName: peerUserName,
              },
            }));
          }
        }
      );

      socketRef.current.on('peer-disconnected', (peerId: string) => {
        setPeers((prev) => {
          const peerInfo = prev[peerId];
          if (peerInfo) peerInfo.stream.getTracks().forEach((track) => track.stop());
          const { [peerId]: _, ...rest } = prev;
          return rest;
        });
      });
    }
  };

  const handleLeave = (): void => {
    if (producerRef.current) {
      producerRef.current.video?.close();
      producerRef.current.audio?.close();
    }

    sendTransportRef.current?.close();

    Object.values(consumerTransportsRef.current).forEach((t) => t.close());
    consumerTransportsRef.current = {};

    const stream = localVideoRef.current?.srcObject as MediaStream | null;
    if (stream) {
      stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    setPeers({});
    setJoined(false);

    socketRef.current?.emit('leave-room', { meetingId: currentMeetingIdRef.current! });

    socketRef.current?.disconnect();
    socketRef.current = null;
    currentMeetingIdRef.current = null;
  };

  const handleLogout = (): void => {
    if (joined) {
      handleLeave();
    }
    onLeaveApp();
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div>
            <h1 style={styles.headerTitle}>MatchNow Meeting</h1>
            <p style={styles.headerSubtitle}>Welcome, {user.userName}</p>
          </div>
          <div style={styles.headerTabs}>
            <button
              onClick={() => setActiveTab('meeting')}
              style={{
                ...styles.tabButton,
                ...(activeTab === 'meeting' ? styles.tabButtonActive : styles.tabButtonInactive),
              }}
            >
              [MEETING]
            </button>
            <button
              onClick={() => setActiveTab('guide')}
              style={{
                ...styles.tabButton,
                ...(activeTab === 'guide' ? styles.tabButtonActive : styles.tabButtonInactive),
              }}
            >
              [WEBRTC GUIDE]
            </button>
          </div>
        </div>
      </header>

      <div style={styles.content}>
        <h2 style={styles.contentTitle}>MatchNow Meeting</h2>

        <div style={styles.fieldsetWrapper}>
          <label style={styles.fieldsetLabel}>Room ID</label>
          <input
            type="text"
            value={meetingId}
            onChange={(e) => setMeetingId(e.target.value)}
            placeholder="방 ID 입력"
            disabled={joined}
            style={{
              ...styles.roomIdInput,
              ...(joined ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
            }}
          />
        </div>

        <div style={styles.controlRow}>
          <select style={styles.resolutionSelect}
            value={resolution}
            onChange={(e) => setResolution(e.target.value as any)}>
            <option>360p</option>
            <option>480p</option>
            <option>720p</option>
          </select>

          <div style={styles.buttonGroup}>
            {!joined && (
              <button onClick={handleJoin} style={styles.joinButton}>
                JOIN
              </button>
            )}
            {joined && (
              <button onClick={handleLeave} style={styles.leaveButton}>
                LEAVE
              </button>
            )}
            <button disabled style={styles.controlButton}>
              MIC OFF
            </button>
            <button disabled style={styles.controlButton}>
              CAMERA OFF
            </button>
            <button disabled style={styles.controlButton}>
              START SCREEN SHARE
            </button>
            <button onClick={handleLogout} style={styles.logoutButton}>
              LOGOUT
            </button>
          </div>
        </div>

        {joined && (
          <div style={styles.videoGrid}>
            <div style={styles.videoTile}>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={styles.video}
              />
              <div style={styles.videoLabel}>나 ({user.userName})</div>
            </div>
            {Object.entries(peers).map(([id, peerInfo]) => (
              <div key={id} style={styles.videoTile}>
                <video
                  ref={(el) => {
                    if (el) el.srcObject = peerInfo.stream;
                  }}
                  autoPlay
                  playsInline
                  style={styles.video}
                />
                <div style={styles.videoLabel}>
                  {peerInfo.userName} ({peerInfo.userId})
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={styles.audioGainSection}>
          <div style={styles.sectionTitle}>Audio Gain</div>
          <div style={styles.gainRow}>
            <span style={styles.gainLabel}>Mic Boost: 1.00x</span>
            <input type="range" disabled style={styles.slider} min="0" max="100" defaultValue="50" />
          </div>
          <div style={styles.gainRow}>
            <span style={styles.gainLabel}>Speaker Boost: 1.00x</span>
            <input type="range" disabled style={styles.slider} min="0" max="100" defaultValue="50" />
          </div>
        </div>

        <div style={styles.networkSection}>
          <div style={styles.sectionTitle}>Network</div>
          <div style={styles.statRow}>
            <span>Status: -</span>
          </div>
        </div>

        <div style={styles.statsGrid}>
          <div style={styles.statsCard}>
            <div style={styles.sectionTitle}>Camera</div>
            <div style={styles.statRow}>
              <span>Send Bitrate: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Send RTT: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Send Loss: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Bitrate: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive RTT: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Loss: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Local: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Remote: -</span>
            </div>
          </div>

          <div style={styles.statsCard}>
            <div style={styles.sectionTitle}>Screen Share</div>
            <div style={styles.statRow}>
              <span>Send Bitrate: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Send RTT: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Send Loss: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Bitrate: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive RTT: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Loss: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Local: -</span>
            </div>
            <div style={styles.statRow}>
              <span>Remote: -</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


export default MeetingPage;
