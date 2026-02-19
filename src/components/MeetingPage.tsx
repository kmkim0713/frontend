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

  const startLocalStream = async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
          <select disabled style={styles.resolutionSelect}>
            <option>720p</option>
            <option>1080p</option>
            <option>480p</option>
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

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: 'var(--bg-primary)',
  } as React.CSSProperties,
  header: {
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
    padding: '20px 24px',
  } as React.CSSProperties,
  headerContent: {
    maxWidth: '1200px',
    margin: '0 auto',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as React.CSSProperties,
  headerTitle: {
    fontSize: '18px',
    fontWeight: '700',
    color: 'var(--text-primary)',
    margin: '0 0 4px 0',
  } as React.CSSProperties,
  headerSubtitle: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    margin: 0,
  } as React.CSSProperties,
  headerTabs: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  tabButton: {
    border: '1px solid var(--border-subtle)',
    borderRadius: '6px',
    padding: '8px 16px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    background: 'transparent',
    color: 'var(--text-primary)',
  } as React.CSSProperties,
  tabButtonActive: {
    background: 'var(--btn-primary)',
    border: '1px solid var(--btn-primary)',
    color: 'white',
  } as React.CSSProperties,
  tabButtonInactive: {
    background: 'transparent',
    border: '1px solid var(--border-subtle)',
  } as React.CSSProperties,
  content: {
    flex: 1,
    maxWidth: '1200px',
    margin: '0 auto',
    width: '100%',
    padding: '24px',
  } as React.CSSProperties,
  contentTitle: {
    fontSize: '20px',
    fontWeight: '700',
    color: 'var(--text-primary)',
    marginBottom: '24px',
  } as React.CSSProperties,
  fieldsetWrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '16px',
  } as React.CSSProperties,
  fieldsetLabel: {
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-primary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  roomIdInput: {
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-input)',
    borderRadius: '6px',
    padding: '12px 14px',
    fontSize: '14px',
    outline: 'none',
    width: '100%',
  } as React.CSSProperties,
  controlRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    marginBottom: '24px',
    flexWrap: 'wrap',
  } as React.CSSProperties,
  resolutionSelect: {
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-input)',
    borderRadius: '6px',
    padding: '10px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    minWidth: '100px',
  } as React.CSSProperties,
  buttonGroup: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    flex: 1,
  } as React.CSSProperties,
  joinButton: {
    background: 'var(--btn-primary)',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    padding: '10px 16px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    minWidth: '80px',
    transition: 'background 0.2s ease',
  } as React.CSSProperties,
  leaveButton: {
    background: 'transparent',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '6px',
    padding: '10px 16px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    minWidth: '80px',
    transition: 'all 0.2s ease',
  } as React.CSSProperties,
  controlButton: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '6px',
    padding: '10px 16px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'not-allowed',
    opacity: 0.5,
  } as React.CSSProperties,
  logoutButton: {
    background: 'rgba(239, 68, 68, 0.1)',
    color: '#ef4444',
    border: '1px solid #ef4444',
    borderRadius: '6px',
    padding: '10px 16px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    minWidth: '80px',
    transition: 'all 0.2s ease',
  } as React.CSSProperties,
  videoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  } as React.CSSProperties,
  videoTile: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '8px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
  video: {
    width: '100%',
    aspectRatio: '16 / 9',
    background: '#000',
    display: 'block',
  } as React.CSSProperties,
  videoLabel: {
    padding: '12px',
    fontSize: '12px',
    color: 'var(--text-muted)',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-input)',
  } as React.CSSProperties,
  audioGainSection: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: 'var(--text-primary)',
    marginBottom: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  gainRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 0',
    fontSize: '12px',
  } as React.CSSProperties,
  gainLabel: {
    color: 'var(--text-muted)',
    minWidth: '150px',
  } as React.CSSProperties,
  slider: {
    flex: 1,
    height: '4px',
    cursor: 'pointer',
    background: 'var(--bg-input)',
    border: 'none',
    borderRadius: '2px',
  } as React.CSSProperties,
  networkSection: {
    background: 'var(--network-bg)',
    borderLeft: '4px solid var(--network-border)',
    borderRadius: '4px',
    padding: '12px',
    marginBottom: '16px',
  } as React.CSSProperties,
  statRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    fontSize: '12px',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border-subtle)',
  } as React.CSSProperties,
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: '16px',
  } as React.CSSProperties,
  statsCard: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '8px',
    padding: '16px',
  } as React.CSSProperties,
};

export default MeetingPage;
