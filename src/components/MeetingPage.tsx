import { useState, useRef, FC, useEffect } from 'react';
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

interface CameraStats {
  sendBitrate: string;
  sendRTT: string;
  sendLoss: string;
  receiveBitrate: string;
  receiveRTT: string;
  receiveLoss: string;
  local: string;
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
  
  const [meetingId, setMeetingId] = useState<string>('test-room');
  const [joined, setJoined] = useState<boolean>(false);
  const [peers, setPeers] = useState<PeersState>({});
  const [activeTab, setActiveTab] = useState<'meeting' | 'guide'>('meeting');
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);
  const [micInputEnabled, setMicInputEnabled] = useState<boolean>(true);
  const [speakerEnabled, setSpeakerEnabled] = useState<boolean>(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<ProducerRefs | null>(null);
  const consumerTransportsRef = useRef<ConsumerTransportsRef>({});
  const currentMeetingIdRef = useRef<string | null>(null);
  const [resolution, setResolution] = useState<'360p' | '480p' | '720p'>('360p');

  const cameraStatsRef = useRef<CameraStats>({
    sendBitrate: '-',
    sendRTT: '-',
    sendLoss: '-',
    receiveBitrate: '-',
    receiveRTT: '-',
    receiveLoss: '-',
    local: '-',
  });
  const lastSendRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const lastRecvRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const sendBitrateRef = useRef<HTMLSpanElement>(null);
  const sendRTTRef = useRef<HTMLSpanElement>(null);
  const sendLossRef = useRef<HTMLSpanElement>(null);
  const receiveBitrateRef = useRef<HTMLSpanElement>(null);
  const receiveRTTRef = useRef<HTMLSpanElement>(null);
  const receiveLossRef = useRef<HTMLSpanElement>(null);
  const localResolutionRef = useRef<HTMLSpanElement>(null);

  const collectStats = async () => {
    let sendBitrate = '-';
    let sendRTT = '-';
    let sendLoss = '-';
    let receiveBitrate = '-';
    let receiveRTT = '-';
    let receiveLoss = '-';
    let localResolution = '-';

    // Get stats from send transport
    if (sendTransportRef.current) {
      const sendStats = await sendTransportRef.current.getStats();

      sendStats.forEach((report: any) => {
        // ---------- SEND ----------
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          if (lastSendRef.current) {
            const bitrate =
              ((report.bytesSent - lastSendRef.current.bytes) * 8) /
              ((report.timestamp - lastSendRef.current.timestamp) / 1000);

            sendBitrate = `${Math.floor(bitrate / 1000)} kbps`;
          }

          lastSendRef.current = {
            bytes: report.bytesSent,
            timestamp: report.timestamp,
          };

          // Calculate packet loss - handle case where packetsLost might be 0
          if (report.packetsSent !== undefined) {
            const packetsLost = report.packetsLost || 0;
            const total = report.packetsSent + packetsLost;
            const loss = total > 0 ? (packetsLost / total) * 100 : 0;
            sendLoss = `${loss.toFixed(2)} %`;
          }

          // Get local resolution from outbound-rtp stats
          if (report.frameWidth && report.frameHeight) {
            localResolution = `${report.frameWidth}x${report.frameHeight}`;
          }
        }

        // ---------- RTT (from candidate-pair stats) ----------
        // RTT is available in active candidate-pair stats
        if (report.type === 'candidate-pair') {
          // Check for RTT in either currentRoundTripTime or roundTripTime property
          const rttSeconds = report.currentRoundTripTime ?? report.roundTripTime;

          // RTT should be available when state is 'succeeded' or connection is active
          // Also check that RTT is a valid positive number
          if (rttSeconds !== undefined && rttSeconds !== null && typeof rttSeconds === 'number' && rttSeconds > 0) {
            const rttMs = rttSeconds * 1000;
            sendRTT = `${rttMs.toFixed(1)} ms`;
            receiveRTT = `${rttMs.toFixed(1)} ms`;
          }
        }
      });
    }

    // Get stats from receive transports to calculate receive bitrate and loss
    const receiveTransports = Object.values(consumerTransportsRef.current);
    if (receiveTransports.length > 0) {
      // Aggregate stats from all receive transports
      let totalBytesReceived = 0;
      let totalPacketsReceived = 0;
      let totalPacketsLost = 0;
      let latestTimestamp = 0;

      for (const recvTransport of receiveTransports) {
        const recvStats = await recvTransport.getStats();

        recvStats.forEach((report: any) => {
          // ---------- RECEIVE ----------
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            totalBytesReceived += report.bytesReceived || 0;
            totalPacketsReceived += report.packetsReceived || 0;
            totalPacketsLost += report.packetsLost || 0;
            latestTimestamp = Math.max(latestTimestamp, report.timestamp || 0);
          }
        });
      }

      // Calculate receive bitrate from aggregated data
      if (totalBytesReceived > 0 && lastRecvRef.current) {
        const timeDiffMs = latestTimestamp - lastRecvRef.current.timestamp;
        if (timeDiffMs > 0) {
          const bitrate = ((totalBytesReceived - lastRecvRef.current.bytes) * 8) / (timeDiffMs / 1000);
          if (isFinite(bitrate) && bitrate >= 0) {
            receiveBitrate = `${Math.floor(bitrate / 1000)} kbps`;
          }
        }
      }

      // Update last receive stats
      if (totalBytesReceived > 0) {
        lastRecvRef.current = {
          bytes: totalBytesReceived,
          timestamp: latestTimestamp,
        };
      }

      // Calculate aggregated packet loss
      if (totalPacketsReceived > 0) {
        const total = totalPacketsReceived + totalPacketsLost;
        const loss = total > 0 ? (totalPacketsLost / total) * 100 : 0;
        receiveLoss = `${loss.toFixed(2)} %`;
      }
    }

    // Update refs directly to avoid triggering a component re-render that causes video flicker
    // Refs allow us to update the DOM without re-rendering the video elements
    cameraStatsRef.current = {
      sendBitrate,
      sendRTT,
      sendLoss,
      receiveBitrate,
      receiveRTT,
      receiveLoss,
      local: localResolution,
    };

    if (sendBitrateRef.current) sendBitrateRef.current.textContent = sendBitrate;
    if (sendRTTRef.current) sendRTTRef.current.textContent = sendRTT;
    if (sendLossRef.current) sendLossRef.current.textContent = sendLoss;
    if (receiveBitrateRef.current) receiveBitrateRef.current.textContent = receiveBitrate;
    if (receiveRTTRef.current) receiveRTTRef.current.textContent = receiveRTT;
    if (receiveLossRef.current) receiveLossRef.current.textContent = receiveLoss;
    if (localResolutionRef.current) localResolutionRef.current.textContent = localResolution;
  };

  useEffect(() => {
    if (!joined) return;

    const interval = setInterval(() => {
      collectStats();
    }, 2000);

    return () => clearInterval(interval);
  }, [joined]);


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

    const stream = await navigator.mediaDevices.getUserMedia({
      video: getVideoConstraints(),
      audio: true
    });

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    localStreamRef.current = stream;
    return stream;
  };

  const handleMicInputToggle = (): void => {
    // MICROPHONE INPUT = whether this user's microphone audio is being sent to other users
    // This controls the audio producer that sends audio to other users
    const newState = !micInputEnabled;

    console.log(`[Mic Input] Toggling from ${micInputEnabled} to ${newState}`);

    if (producerRef.current?.audio) {
      if (newState) {
        // Resume sending audio to other users
        console.log('[Mic Input] Resuming audio producer');
        producerRef.current.audio.resume();
      } else {
        // Pause sending audio to other users
        console.log('[Mic Input] Pausing audio producer');
        producerRef.current.audio.pause();
      }
    } else {
      console.warn('[Mic Input] Audio producer not found');
    }

    setMicInputEnabled(newState);
  };

  const handleSpeakerToggle = (): void => {
    // SPEAKER = whether this user can hear audio from other users
    // This controls whether remote audio tracks are playing
    const newState = !speakerEnabled;

    console.log(`[Speaker] Toggling from ${speakerEnabled} to ${newState}, peers count: ${Object.keys(peers).length}`);

    Object.entries(peers).forEach(([peerId, peerInfo]) => {
      const audioTracks = peerInfo.stream.getAudioTracks();
      console.log(`[Speaker] Peer ${peerId}: ${audioTracks.length} audio track(s)`);
      audioTracks.forEach((track) => {
        console.log(`[Speaker] Setting audio track enabled: ${newState}`);
        track.enabled = newState;
      });
    });

    setSpeakerEnabled(newState);
  };



  const handleCameraToggle = (): void => {
    if (!localStreamRef.current) return;

    const videoTracks = localStreamRef.current.getVideoTracks();
    const newState = !cameraEnabled;

    videoTracks.forEach((track) => {
      track.enabled = newState;
    });

    setCameraEnabled(newState);
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
          console.log(`[newConsumer] Received ${kind} consumer from peer ${id}`);

          // Step 1: Create transport if it doesn't exist
          if (!consumerTransportsRef.current[id]) {
            console.log(`[newConsumer] Creating new receive transport for peer ${id}`);
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
          }

          // Step 2: Create and consume the track (happens for every consumer, not just the first)
          const recvTransport = consumerTransportsRef.current[id];
          const consumerData = await new Promise<ConsumerData>((resolve) =>
            socketRef.current?.emit('consume', { transportId: recvTransport.id, producerId, kind }, resolve)
          );

          const consumer = await recvTransport.consume({
            id: consumerData.id,
            producerId,
            kind: consumerData.kind,
            rtpParameters: consumerData.rtpParameters,
          });

          console.log(`[newConsumer] Consumer created for ${kind}, adding track to peer ${id}`);

          // Step 3: Add track to peer's stream (or create new stream if first consumer)
          setPeers((prev) => {
            const existingPeer = prev[id];
            if (existingPeer) {
              // Add track to existing stream
              existingPeer.stream.addTrack(consumer.track);
              console.log(`[newConsumer] Added ${kind} track to existing stream`);
              return prev;
            } else {
              // Create new stream with first track
              const newStream = new MediaStream();
              newStream.addTrack(consumer.track);
              console.log(`[newConsumer] Created new stream with ${kind} track`);
              return {
                ...prev,
                [id]: {
                  stream: newStream,
                  userId: peerUserId,
                  userName: peerUserName,
                },
              };
            }
          });
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

    localStreamRef.current = null;
    setMicInputEnabled(true);
    setSpeakerEnabled(true);

    setCameraEnabled(true);
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

            <button
              onClick={handleMicInputToggle}
              disabled={!joined}
              style={{
                ...styles.controlButton,
                cursor: joined ? 'pointer' : 'not-allowed',
                opacity: micInputEnabled ? 1 : 0.6,
                borderColor: !micInputEnabled && joined ? '#ff6b6b' : undefined,
                borderWidth: !micInputEnabled && joined ? '2px' : undefined,
              }}
            >
              {micInputEnabled ? 'MICROPHONE ON' : 'MICROPHONE OFF'}
            </button>

            <button
              onClick={handleSpeakerToggle}
              disabled={!joined}
              style={{
                ...styles.controlButton,
                cursor: joined ? 'pointer' : 'not-allowed',
                opacity: speakerEnabled ? 1 : 0.6,
                borderColor: !speakerEnabled && joined ? '#ff6b6b' : undefined,
                borderWidth: !speakerEnabled && joined ? '2px' : undefined,
              }}
            >
              {speakerEnabled ? 'SPEAKER ON' : 'SPEAKER OFF'}
            </button>

            <button
              onClick={handleCameraToggle}
              disabled={!joined}
              style={{
                ...styles.controlButton,
                cursor: joined ? 'pointer' : 'not-allowed',
                opacity: cameraEnabled ? 1 : 0.6,
                borderColor: !cameraEnabled && joined ? '#ff6b6b' : undefined,
                borderWidth: !cameraEnabled && joined ? '2px' : undefined,
              }}
            >
              {cameraEnabled ? 'CAMERA ON' : 'CAMERA OFF'}
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
              <span>Send Bitrate: <span ref={sendBitrateRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Send RTT: <span ref={sendRTTRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Send Loss: <span ref={sendLossRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Bitrate: <span ref={receiveBitrateRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Receive RTT: <span ref={receiveRTTRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Receive Loss: <span ref={receiveLossRef}>-</span></span>
            </div>
            <div style={styles.statRow}>
              <span>Local: <span ref={localResolutionRef}>-</span></span>
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
