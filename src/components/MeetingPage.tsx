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

interface MediaStats {
  sendBitrate: string;
  sendRTT: string;
  sendLoss: string;
  receiveBitrate: string;
  receiveRTT: string;
  receiveLoss: string;
  local: string;
}

interface PeerMediaStats {
  video: MediaStats;
  audio: MediaStats;
}

interface PeerStatsDomRefs {
  videoBitrate: HTMLSpanElement | null;
  videoRTT: HTMLSpanElement | null;
  videoLoss: HTMLSpanElement | null;
  audioBitrate: HTMLSpanElement | null;
  audioRTT: HTMLSpanElement | null;
  audioLoss: HTMLSpanElement | null;
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
  const [micInputVolume, setMicInputVolume] = useState<number>(1.0);
  const [speakerVolume, setSpeakerVolume] = useState<number>(1.0);
  const [availableDevices, setAvailableDevices] = useState<{
    cameras: MediaDeviceInfo[];
    microphones: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
  }>({ cameras: [], microphones: [], speakers: [] });
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('');
  const [supportedResolutions, setSupportedResolutions] = useState<string[]>(['360p', '480p', '720p']);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.types.Device | null>(null);
  const sendTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const producerRef = useRef<ProducerRefs | null>(null);
  const consumerTransportsRef = useRef<ConsumerTransportsRef>({});
  const currentMeetingIdRef = useRef<string | null>(null);
  const [resolution, setResolution] = useState<'180p' | '360p' | '480p' | '720p'>('360p');

  // Web Audio API for microphone gain control
  const audioContextRef = useRef<AudioContext | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Web Audio API for speaker gain control
  const speakerAudioContextRef = useRef<AudioContext | null>(null);
  const speakerGainNodesRef = useRef<WeakMap<MediaStream, GainNode>>(new WeakMap());

  const videoStatsRef = useRef<MediaStats>({
    sendBitrate: '-',
    sendRTT: '-',
    sendLoss: '-',
    receiveBitrate: '-',
    receiveRTT: '-',
    receiveLoss: '-',
    local: '-',
  });

  const audioStatsRef = useRef<MediaStats>({
    sendBitrate: '-',
    sendRTT: '-',
    sendLoss: '-',
    receiveBitrate: '-',
    receiveRTT: '-',
    receiveLoss: '-',
    local: '-',
  });

  const peerStatsRef = useRef<Record<string, PeerMediaStats>>({});
  const peerStatsDomRefsRef = useRef<Record<string, PeerStatsDomRefs>>({});
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set());
  const lastSendVideoRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const lastSendAudioRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const lastRecvVideoRef = useRef<Record<string, { bytes: number; timestamp: number }>>({});
  const lastRecvAudioRef = useRef<Record<string, { bytes: number; timestamp: number }>>({});

  // Video send refs
  const videoSendBitrateRef = useRef<HTMLSpanElement>(null);
  const videoSendRTTRef = useRef<HTMLSpanElement>(null);
  const videoSendLossRef = useRef<HTMLSpanElement>(null);
  const videoLocalResolutionRef = useRef<HTMLSpanElement>(null);

  // Audio send refs
  const audioSendBitrateRef = useRef<HTMLSpanElement>(null);
  const audioSendRTTRef = useRef<HTMLSpanElement>(null);
  const audioSendLossRef = useRef<HTMLSpanElement>(null);

  const detectSupportedResolutions = async (cameraId: string): Promise<string[]> => {
    const resolutionTests = [
      { name: '180p', width: 320, height: 180 },
      { name: '360p', width: 640, height: 360 },
      { name: '480p', width: 640, height: 480 },
      { name: '720p', width: 1280, height: 720 },
    ];

    const supported: string[] = [];

    for (const res of resolutionTests) {
      try {
        const constraints: MediaStreamConstraints = {
          video: {
            deviceId: { exact: cameraId },
            width: { ideal: res.width },
            height: { ideal: res.height },
          },
          audio: false,
        };

        const testStream = await navigator.mediaDevices.getUserMedia(constraints);
        const videoTrack = testStream.getVideoTracks()[0];

        if (videoTrack) {
          const settings = videoTrack.getSettings();
          // Validate that camera actually returns the requested resolution (with 10% tolerance)
          if (settings.width !== undefined && settings.height !== undefined) {
            const widthMatch = Math.abs(settings.width - res.width) <= res.width * 0.1;
            const heightMatch = Math.abs(settings.height - res.height) <= res.height * 0.1;

            if (widthMatch && heightMatch) {
              console.log(`[detectSupportedResolutions] ${res.name}: ${settings.width}x${settings.height} ✓ (Supported)`);
              supported.push(res.name);
            } else {
              console.log(`[detectSupportedResolutions] ${res.name}: Requested ${res.width}x${res.height}, got ${settings.width}x${settings.height} ✗ (Not supported)`);
            }
          }
        }

        testStream.getTracks().forEach(track => track.stop());
      } catch (error) {
        console.log(`[detectSupportedResolutions] ${res.name}: Not supported`);
      }
    }

    console.log(`[detectSupportedResolutions] Supported resolutions for camera ${cameraId}:`, supported);
    const finalSupported = supported.length > 0 ? supported : ['360p'];
    setSupportedResolutions(finalSupported);

    // Set resolution to first supported one (always)
    console.log(`[detectSupportedResolutions] Setting default resolution to: ${finalSupported[0]}`);
    setResolution(finalSupported[0] as any);

    // Return supported resolutions for immediate use in switchCameraDevice
    return finalSupported;
  };

  const enumerateDevices = async (): Promise<void> => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      const microphones = devices.filter(d => d.kind === 'audioinput');
      const speakers = devices.filter(d => d.kind === 'audiooutput');

      setAvailableDevices({ cameras, microphones, speakers });

      // Set initial device selections to first available device
      if (cameras.length > 0 && !selectedCameraId) {
        setSelectedCameraId(cameras[0].deviceId);
      }
      if (microphones.length > 0 && !selectedMicId) {
        setSelectedMicId(microphones[0].deviceId);
      }
      if (speakers.length > 0 && !selectedSpeakerId) {
        setSelectedSpeakerId(speakers[0].deviceId);
      }
    } catch (error) {
      console.error('[enumerateDevices] Failed to enumerate devices:', error);
    }
  };

  // Detect supported resolutions when camera is selected
  useEffect(() => {
    if (selectedCameraId) {
      detectSupportedResolutions(selectedCameraId);
    }
  }, [selectedCameraId]);

  // Enumerate devices on mount
  useEffect(() => {
    enumerateDevices();

    // Listen for device changes
    const handleDeviceChange = (): void => {
      enumerateDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  const collectStats = async () => {
    // ===== VIDEO SEND STATS =====
    let videoSendBitrate = '-';
    let videoSendRTT = '-';
    let videoSendLoss = '-';
    let videoLocalResolution = '-';

    // ===== AUDIO SEND STATS =====
    let audioSendBitrate = '-';
    let audioSendRTT = '-';
    let audioSendLoss = '-';

    // Get stats from send transport
    if (sendTransportRef.current) {
      const sendStats = await sendTransportRef.current.getStats();

      sendStats.forEach((report: any) => {
        // ---------- VIDEO SEND ----------
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          if (lastSendVideoRef.current) {
            const bitrate =
              ((report.bytesSent - lastSendVideoRef.current.bytes) * 8) /
              ((report.timestamp - lastSendVideoRef.current.timestamp) / 1000);
            videoSendBitrate = `${Math.floor(bitrate / 1000)} kbps`;
          }

          lastSendVideoRef.current = {
            bytes: report.bytesSent,
            timestamp: report.timestamp,
          };

          if (report.packetsSent !== undefined) {
            const packetsLost = report.packetsLost || 0;
            const total = report.packetsSent + packetsLost;
            const loss = total > 0 ? (packetsLost / total) * 100 : 0;
            videoSendLoss = `${loss.toFixed(2)} %`;
          }

          if (report.frameWidth && report.frameHeight) {
            videoLocalResolution = `${report.frameWidth}x${report.frameHeight}`;
          }
        }

        // ---------- AUDIO SEND ----------
        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          if (lastSendAudioRef.current) {
            const bitrate =
              ((report.bytesSent - lastSendAudioRef.current.bytes) * 8) /
              ((report.timestamp - lastSendAudioRef.current.timestamp) / 1000);
            audioSendBitrate = `${Math.floor(bitrate / 1000)} kbps`;
          }

          lastSendAudioRef.current = {
            bytes: report.bytesSent,
            timestamp: report.timestamp,
          };

          if (report.packetsSent !== undefined) {
            const packetsLost = report.packetsLost || 0;
            const total = report.packetsSent + packetsLost;
            const loss = total > 0 ? (packetsLost / total) * 100 : 0;
            audioSendLoss = `${loss.toFixed(2)} %`;
          }
        }

        // ---------- RTT (from candidate-pair stats) ----------
        if (report.type === 'candidate-pair') {
          const rttSeconds = report.currentRoundTripTime ?? report.roundTripTime;
          if (rttSeconds !== undefined && rttSeconds !== null && typeof rttSeconds === 'number' && rttSeconds > 0) {
            const rttMs = rttSeconds * 1000;
            videoSendRTT = `${rttMs.toFixed(1)} ms`;
            audioSendRTT = `${rttMs.toFixed(1)} ms`;
          }
        }
      });
    }

    // ===== PER-PEER RECEIVE STATS =====
    Object.entries(consumerTransportsRef.current).forEach(([peerId, recvTransport]) => {
      // Initialize peer stats if not exists
      if (!peerStatsRef.current[peerId]) {
        peerStatsRef.current[peerId] = {
          video: { sendBitrate: '-', sendRTT: '-', sendLoss: '-', receiveBitrate: '-', receiveRTT: '-', receiveLoss: '-', local: '-' },
          audio: { sendBitrate: '-', sendRTT: '-', sendLoss: '-', receiveBitrate: '-', receiveRTT: '-', receiveLoss: '-', local: '-' },
        };
      }

      recvTransport.getStats().then((recvStats: any) => {
        let videoReceiveBitrate = '-';
        let videoReceiveRTT = '-';
        let videoReceiveLoss = '-';
        let audioReceiveBitrate = '-';
        let audioReceiveRTT = '-';
        let audioReceiveLoss = '-';

        // Aggregate all VIDEO inbound-rtp reports (handles multiple SSRCs/codecs)
        let totalVideoBytes = 0;
        let videoTimestamp = 0;
        let videoPacketsReceived = 0;
        let videoPacketsLost = 0;

        // Aggregate all AUDIO inbound-rtp reports (handles multiple SSRCs/codecs)
        let totalAudioBytes = 0;
        let audioTimestamp = 0;
        let audioPacketsReceived = 0;
        let audioPacketsLost = 0;

        // console.log(`[collectStats] Peer ${peerId} - Processing ${recvStats.length} stat reports`);

        recvStats.forEach((report: any) => {
          // ---------- VIDEO RECEIVE ----------
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            console.log(`[collectStats] Peer ${peerId} VIDEO - bytesReceived: ${report.bytesReceived}, timestamp: ${report.timestamp}`);
            // Aggregate all video inbound-rtp reports
            totalVideoBytes += report.bytesReceived || 0;
            videoTimestamp = report.timestamp || 0;
            videoPacketsReceived += report.packetsReceived || 0;
            videoPacketsLost += report.packetsLost || 0;
          }

          // ---------- AUDIO RECEIVE ----------
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            console.log(`[collectStats] Peer ${peerId} AUDIO - bytesReceived: ${report.bytesReceived}, timestamp: ${report.timestamp}`);
            // Aggregate all audio inbound-rtp reports
            totalAudioBytes += report.bytesReceived || 0;
            audioTimestamp = report.timestamp || 0;
            audioPacketsReceived += report.packetsReceived || 0;
            audioPacketsLost += report.packetsLost || 0;
          }

          // ---------- RTT ----------
          if (report.type === 'candidate-pair') {
            const rttSeconds = report.currentRoundTripTime ?? report.roundTripTime;
            if (rttSeconds !== undefined && rttSeconds !== null && typeof rttSeconds === 'number' && rttSeconds > 0) {
              const rttMs = rttSeconds * 1000;
              videoReceiveRTT = `${rttMs.toFixed(1)} ms`;
              audioReceiveRTT = `${rttMs.toFixed(1)} ms`;
            }
          }
        });

        // Calculate bitrate from aggregated video data
        if (videoTimestamp > 0) {
          const lastVideoRecv = lastRecvVideoRef.current[peerId];
          console.log(`[collectStats] Peer ${peerId} VIDEO AGGREGATED - totalBytes: ${totalVideoBytes}, timestamp: ${videoTimestamp}, lastRecv:`, lastVideoRecv);
          if (lastVideoRecv && lastVideoRecv.timestamp > 0) {
            const timeDiffMs = videoTimestamp - lastVideoRecv.timestamp;
            console.log(`  timeDiffMs: ${timeDiffMs}, bytesDiff: ${totalVideoBytes - lastVideoRecv.bytes}`);
            if (timeDiffMs > 0) {
              const bitrate = ((totalVideoBytes - lastVideoRecv.bytes) * 8) / (timeDiffMs / 1000);
              console.log(`  bitrate: ${bitrate}, isFinite: ${isFinite(bitrate)}, >= 0: ${bitrate >= 0}`);
              if (isFinite(bitrate) && bitrate >= 0) {
                videoReceiveBitrate = `${Math.floor(bitrate / 1000)} kbps`;
                console.log(`🟢 VIDEO bitrate calculated: ${videoReceiveBitrate}`);
              }
            } else {
              console.log(`  ⚠️ timeDiffMs <= 0, skipping bitrate calculation`);
            }
          } else {
            console.log(`  ⚠️ First video measurement for this peer`);
          }
          // Store aggregated bytes for next cycle
          lastRecvVideoRef.current[peerId] = {
            bytes: totalVideoBytes,
            timestamp: videoTimestamp,
          };
          // Calculate packet loss from aggregated data
          if (videoPacketsReceived > 0 || videoPacketsLost > 0) {
            const total = videoPacketsReceived + videoPacketsLost;
            const loss = total > 0 ? (videoPacketsLost / total) * 100 : 0;
            videoReceiveLoss = `${loss.toFixed(2)} %`;
          }
        }

        // Calculate bitrate from aggregated audio data
        if (audioTimestamp > 0) {
          const lastAudioRecv = lastRecvAudioRef.current[peerId];
          console.log(`[collectStats] Peer ${peerId} AUDIO AGGREGATED - totalBytes: ${totalAudioBytes}, timestamp: ${audioTimestamp}, lastRecv:`, lastAudioRecv);
          if (lastAudioRecv && lastAudioRecv.timestamp > 0) {
            const timeDiffMs = audioTimestamp - lastAudioRecv.timestamp;
            console.log(`  timeDiffMs: ${timeDiffMs}, bytesDiff: ${totalAudioBytes - lastAudioRecv.bytes}`);
            if (timeDiffMs > 0) {
              const bitrate = ((totalAudioBytes - lastAudioRecv.bytes) * 8) / (timeDiffMs / 1000);
              console.log(`  bitrate: ${bitrate}, isFinite: ${isFinite(bitrate)}, >= 0: ${bitrate >= 0}`);
              if (isFinite(bitrate) && bitrate >= 0) {
                audioReceiveBitrate = `${Math.floor(bitrate / 1000)} kbps`;
                console.log(`🟢 AUDIO bitrate calculated: ${audioReceiveBitrate}`);
              }
            } else {
              console.log(`  ⚠️ timeDiffMs <= 0, skipping bitrate calculation`);
            }
          } else {
            console.log(`  ⚠️ First audio measurement for this peer`);
          }
          // Store aggregated bytes for next cycle
          lastRecvAudioRef.current[peerId] = {
            bytes: totalAudioBytes,
            timestamp: audioTimestamp,
          };
          // Calculate packet loss from aggregated data
          if (audioPacketsReceived > 0 || audioPacketsLost > 0) {
            const total = audioPacketsReceived + audioPacketsLost;
            const loss = total > 0 ? (audioPacketsLost / total) * 100 : 0;
            audioReceiveLoss = `${loss.toFixed(2)} %`;
          }
        }

        // Update peer stats
        peerStatsRef.current[peerId].video.receiveBitrate = videoReceiveBitrate;
        peerStatsRef.current[peerId].video.receiveRTT = videoReceiveRTT;
        peerStatsRef.current[peerId].video.receiveLoss = videoReceiveLoss;
        peerStatsRef.current[peerId].audio.receiveBitrate = audioReceiveBitrate;
        peerStatsRef.current[peerId].audio.receiveRTT = audioReceiveRTT;
        peerStatsRef.current[peerId].audio.receiveLoss = audioReceiveLoss;

        // Update DOM refs directly to avoid triggering re-renders
        const domRefs = peerStatsDomRefsRef.current[peerId];
        console.log("🛑🛑🛑 ~~~ :349 ~~~ collectStats ~~~ domRefs:", domRefs);
        
        if (domRefs) {
          if (domRefs.videoBitrate) domRefs.videoBitrate.textContent = videoReceiveBitrate;
          if (domRefs.videoRTT) domRefs.videoRTT.textContent = videoReceiveRTT;
          if (domRefs.videoLoss) domRefs.videoLoss.textContent = videoReceiveLoss;
          if (domRefs.audioBitrate) domRefs.audioBitrate.textContent = audioReceiveBitrate;
          if (domRefs.audioRTT) domRefs.audioRTT.textContent = audioReceiveRTT;
          if (domRefs.audioLoss) domRefs.audioLoss.textContent = audioReceiveLoss;
        }

        // console.log(`[collectStats] Peer ${peerId} stats updated - Video Bitrate: ${videoReceiveBitrate}, Audio Bitrate: ${audioReceiveBitrate}`);
      });
    });

    // Update video send stats refs
    videoStatsRef.current.sendBitrate = videoSendBitrate;
    videoStatsRef.current.sendRTT = videoSendRTT;
    videoStatsRef.current.sendLoss = videoSendLoss;
    videoStatsRef.current.local = videoLocalResolution;

    if (videoSendBitrateRef.current) videoSendBitrateRef.current.textContent = videoSendBitrate;
    if (videoSendRTTRef.current) videoSendRTTRef.current.textContent = videoSendRTT;
    if (videoSendLossRef.current) videoSendLossRef.current.textContent = videoSendLoss;
    if (videoLocalResolutionRef.current) videoLocalResolutionRef.current.textContent = videoLocalResolution;

    // Update audio send stats refs
    audioStatsRef.current.sendBitrate = audioSendBitrate;
    audioStatsRef.current.sendRTT = audioSendRTT;
    audioStatsRef.current.sendLoss = audioSendLoss;

    if (audioSendBitrateRef.current) audioSendBitrateRef.current.textContent = audioSendBitrate;
    if (audioSendRTTRef.current) audioSendRTTRef.current.textContent = audioSendRTT;
    if (audioSendLossRef.current) audioSendLossRef.current.textContent = audioSendLoss;

  };

  useEffect(() => {
    if (!joined) return;

    const interval = setInterval(() => {
      collectStats();
    }, 2000);

    return () => clearInterval(interval);
  }, [joined]);



  const startLocalStream = async (cameraId?: string, micId?: string): Promise<MediaStream> => {
    const getVideoConstraints = () => {
      let baseConstraints;
      switch (resolution) {
        case '180p':
          baseConstraints = { width: { ideal: 320 }, height: { ideal: 180 } };
          break;
        case '360p':
          baseConstraints = { width: { ideal: 640 }, height: { ideal: 360 } };
          break;
        case '480p':
          baseConstraints = { width: { ideal: 640 }, height: { ideal: 480 } };
          break;
        case '720p':
        default:
          baseConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
          break;
      }
      if (cameraId) {
        return { ...baseConstraints, deviceId: { exact: cameraId } };
      }
      return baseConstraints;
    };

    console.log(`[startLocalStream] Using resolution: ${resolution}`);

    const audioConstraints: any = {};
    if (micId) {
      audioConstraints.deviceId = { exact: micId };
    }

    const videoConstraints = getVideoConstraints();
    console.log(`[startLocalStream] Video constraints:`, videoConstraints);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints
    });

    console.log(`[startLocalStream] Got stream with video dimensions: ${stream.getVideoTracks()[0]?.getSettings().width}x${stream.getVideoTracks()[0]?.getSettings().height}`);

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    localStreamRef.current = stream;

    // Set up Web Audio API for microphone gain control
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Create audio source from the original stream
      const source = audioContext.createMediaStreamSource(stream);

      // Create gain node for controlling microphone volume
      const gainNode = audioContext.createGain();
      gainNode.gain.value = micInputVolume;

      // Create a destination to capture processed audio
      const destination = audioContext.createMediaStreamDestination();

      // Connect: source -> gainNode -> destination
      source.connect(gainNode);
      gainNode.connect(destination);

      // Store references for later control
      audioContextRef.current = audioContext;
      micGainNodeRef.current = gainNode;
      micSourceRef.current = source;

      console.log('[startLocalStream] Web Audio API setup completed for microphone');

      // Return the processed stream with gain control applied
      const processedStream = destination.stream;
      const videoTracks = stream.getVideoTracks();
      const audioTracks = processedStream.getAudioTracks();

      if (audioTracks.length > 0 && videoTracks.length > 0) {
        const finalStream = new MediaStream();
        finalStream.addTrack(videoTracks[0]);
        finalStream.addTrack(audioTracks[0]);
        return finalStream;
      }
    } catch (error) {
      console.warn('[startLocalStream] Web Audio API not available:', error);
    }

    return stream;
  };

  const handleMicInputToggle = (): void => {
    // MICROPHONE INPUT = whether this user's microphone audio is being sent to other users
    // This controls the gain of the microphone audio through Web Audio API
    const newState = !micInputEnabled;

    console.log(`[Mic Input] Toggling from ${micInputEnabled} to ${newState}`);

    if (micGainNodeRef.current) {
      // Use GainNode to control microphone audio
      // When OFF (newState=false): set gain to 0 (mute)
      // When ON (newState=true): set gain to current volume level
      if (newState) {
        micGainNodeRef.current.gain.value = micInputVolume;
        console.log(`[Mic Input] Enabled with volume: ${micInputVolume}`);
      } else {
        micGainNodeRef.current.gain.value = 0;
        console.log('[Mic Input] Disabled (gain = 0)');
      }
    } else {
      console.warn('[Mic Input] Mic GainNode not found');
    }

    setMicInputEnabled(newState);
  };

  const handleMicInputVolumeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const volume = parseFloat(e.target.value);
    setMicInputVolume(volume);

    // Apply the volume to the GainNode
    if (micGainNodeRef.current && micInputEnabled) {
      micGainNodeRef.current.gain.value = volume;
      console.log(`[Mic Volume] Changed to ${volume.toFixed(2)}`);
    }
  };

  const setupRemoteAudioGain = (stream: MediaStream, peerId?: string): void => {
    try {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        console.warn('[setupRemoteAudioGain] No audio tracks in stream');
        return;
      }

      // Initialize audio context if needed
      if (!speakerAudioContextRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        speakerAudioContextRef.current = new AudioContextClass();
      }

      const audioContext = speakerAudioContextRef.current;

      // Handle suspended context
      const setupGainNode = (): void => {
        try {
          // Create source from the stream
          const source = audioContext.createMediaStreamSource(stream);

          // Create gain node for controlling speaker volume
          const gainNode = audioContext.createGain();
          gainNode.gain.setValueAtTime(speakerEnabled ? speakerVolume : 0, audioContext.currentTime);

          // Connect: source -> gainNode -> destination (speakers)
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);

          // Store the gain node reference
          speakerGainNodesRef.current.set(stream, gainNode);

          // CRITICAL: Mute the video element since audio is now routed through Web Audio API
          // This prevents double audio (both from video element and from gain node)
          const videoElements = document.querySelectorAll('[data-remote-video]');
          let mutedElement = false;
          videoElements.forEach((el) => {
            const video = el as HTMLVideoElement;
            if (video.srcObject === stream) {
              video.volume = 0;
              mutedElement = true;
              console.log(
                `[setupRemoteAudioGain] 🔇 Muted video element for peer ${peerId || 'unknown'}`
              );
            }
          });

          console.log(
            `[setupRemoteAudioGain] ✅ Setup complete | gain: ${gainNode.gain.value}x | state: ${audioContext.state} | tracks: ${audioTracks.length} | muted: ${mutedElement}`
          );
        } catch (error) {
          console.warn('[setupRemoteAudioGain] Failed to setup gain node:', error);
        }
      };

      if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
          if (audioContext.state === 'running') {
            setupGainNode();
          }
        });
      } else {
        setupGainNode();
      }
    } catch (error) {
      console.warn('[setupRemoteAudioGain] Failed to initialize audio context:', error);
    }
  };

  const handleSpeakerToggle = (): void => {
    // SPEAKER = whether this user can hear audio from other users
    // This controls the gain of remote audio through Web Audio API
    const newState = !speakerEnabled;

    console.log(`[Speaker] Toggling from ${speakerEnabled} to ${newState}, peers count: ${Object.keys(peers).length}`);

    // Update gain nodes for all remote streams
    const audioContext = speakerAudioContextRef.current;
    Object.entries(peers).forEach(([peerId, peerInfo]) => {
      const gainNode = speakerGainNodesRef.current.get(peerInfo.stream);
      if (gainNode && audioContext && audioContext.state === 'running') {
        const targetGain = newState ? speakerVolume : 0;
        gainNode.gain.setValueAtTime(targetGain, audioContext.currentTime);
        console.log(`[Speaker] 🔊 Updated gain for peer ${peerId}: ${targetGain.toFixed(2)}x`);
      }

      // Also disable/enable audio tracks at the MediaStream level as fallback
      const audioTracks = peerInfo.stream.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = newState;
      });
    });

    setSpeakerEnabled(newState);
  };

  const handleSpeakerVolumeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const volume = parseFloat(e.target.value);
    setSpeakerVolume(volume);

    console.log(`[Speaker Volume] Changed to ${volume.toFixed(2)}`);

    // Apply the volume to all gain nodes
    if (speakerEnabled) {
      const audioContext = speakerAudioContextRef.current;
      Object.entries(peers).forEach(([, peerInfo]) => {
        const gainNode = speakerGainNodesRef.current.get(peerInfo.stream);
        if (gainNode && audioContext && audioContext.state === 'running') {
          gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        }
      });
    }
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

  const switchCameraDevice = async (deviceId: string): Promise<void> => {
    try {
      if (!localStreamRef.current) {
        setSelectedCameraId(deviceId);
        return;
      }

      console.log(`[switchCameraDevice] Switching camera to device: ${deviceId}`);

      // Stop old video track first
      const oldVideoTracks = localStreamRef.current.getVideoTracks();
      oldVideoTracks.forEach((track) => {
        track.stop();
      });

      // Wait 500ms for old track to fully release
      await new Promise(resolve => setTimeout(resolve, 500));

      // Detect supported resolutions for the new camera
      console.log(`[switchCameraDevice] Detecting supported resolutions for camera: ${deviceId}`);
      const supportedResolutions = await detectSupportedResolutions(deviceId);
      const lowestResolution = supportedResolutions[0];

      console.log(`[switchCameraDevice] Camera ${deviceId} supports: ${supportedResolutions.join(', ')}`);
      console.log(`[switchCameraDevice] Using lowest resolution: ${lowestResolution}`);

      // Update selected camera ID
      setSelectedCameraId(deviceId);
      setResolution(lowestResolution as any);
      setSupportedResolutions(supportedResolutions);

      // Get new stream with the lowest supported resolution
      // Build video constraints directly with the detected lowest resolution
      let videoConstraints: any;
      switch (lowestResolution) {
        case '180p':
          videoConstraints = { width: { ideal: 320 }, height: { ideal: 180 } };
          break;
        case '360p':
          videoConstraints = { width: { ideal: 640 }, height: { ideal: 360 } };
          break;
        case '480p':
          videoConstraints = { width: { ideal: 640 }, height: { ideal: 480 } };
          break;
        case '720p':
        default:
          videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
          break;
      }

      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      }

      const audioConstraints: any = {};
      if (selectedMicId) {
        audioConstraints.deviceId = { exact: selectedMicId };
      }

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints,
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      if (!newVideoTrack) {
        console.error('[switchCameraDevice] No video track in new stream');
        return;
      }

      // Remove old tracks from stream
      oldVideoTracks.forEach((track) => {
        localStreamRef.current!.removeTrack(track);
      });

      // Add new video track
      localStreamRef.current.addTrack(newVideoTrack);

      // Update the video element
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }

      // If we've already joined, replace the producer track
      if (joined && producerRef.current?.video) {
        try {
          await producerRef.current.video.replaceTrack({
            track: newVideoTrack,
          });
          console.log('[switchCameraDevice] Successfully replaced video track in producer');
        } catch (error) {
          console.error('[switchCameraDevice] Failed to replace video track:', error);
        }
      }

      // Clean up extra audio track if it was added
      const audioTracks = newStream.getAudioTracks();
      audioTracks.forEach((track) => {
        newStream.removeTrack(track);
        track.stop();
      });

      console.log(`[switchCameraDevice] Camera switched successfully to ${lowestResolution}`);
    } catch (error) {
      console.error('[switchCameraDevice] Failed to switch camera:', error);
    }
  };

  const switchMicDevice = async (deviceId: string): Promise<void> => {
    try {
      if (!localStreamRef.current) {
        setSelectedMicId(deviceId);
        return;
      }

      console.log(`[switchMicDevice] Switching microphone to device: ${deviceId}`);
      setSelectedMicId(deviceId);

      // Get new stream with the selected microphone
      const newStream = await startLocalStream(selectedCameraId, deviceId);
      const newAudioTrack = newStream.getAudioTracks()[0];

      if (!newAudioTrack) {
        console.error('[switchMicDevice] No audio track in new stream');
        return;
      }

      // Replace the audio track in the local stream
      const oldAudioTracks = localStreamRef.current.getAudioTracks();
      oldAudioTracks.forEach((track) => {
        localStreamRef.current!.removeTrack(track);
        track.stop();
      });

      localStreamRef.current.addTrack(newAudioTrack);

      // CRITICAL: Update the video element with the new stream
      // This prevents the camera screen from turning off
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }

      // If we've already joined, replace the producer track
      if (joined && producerRef.current?.audio) {
        try {
          await producerRef.current.audio.replaceTrack({
            track: newAudioTrack,
          });
          console.log('[switchMicDevice] Successfully replaced audio track in producer');
        } catch (error) {
          console.error('[switchMicDevice] Failed to replace audio track:', error);
        }
      }

      // Clean up extra video track if it was added
      const videoTracks = newStream.getVideoTracks();
      videoTracks.forEach((track) => {
        newStream.removeTrack(track);
        track.stop();
      });

      // Re-setup Web Audio API for microphone gain control
      if (audioContextRef.current && micGainNodeRef.current && micSourceRef.current) {
        try {
          // Disconnect old source
          micSourceRef.current.disconnect();

          // Create new source from the new audio track
          const newSource = audioContextRef.current.createMediaStreamSource(
            new MediaStream([newAudioTrack])
          );

          // Reconnect with existing gain node
          newSource.connect(micGainNodeRef.current);

          micSourceRef.current = newSource;
          console.log('[switchMicDevice] Re-setup Web Audio API for new microphone');
        } catch (error) {
          console.warn('[switchMicDevice] Failed to re-setup Web Audio API:', error);
        }
      }
    } catch (error) {
      console.error('[switchMicDevice] Failed to switch microphone:', error);
    }
  };

  const switchSpeakerDevice = async (deviceId: string): Promise<void> => {
    try {
      console.log(`[switchSpeakerDevice] Switching speaker to device: ${deviceId}`);
      setSelectedSpeakerId(deviceId);

      // Apply speaker device to all remote video elements
      const remoteVideos = document.querySelectorAll('[data-remote-video]');
      remoteVideos.forEach((videoEl) => {
        const video = videoEl as HTMLVideoElement;
        if (deviceId && deviceId !== '' && 'setSinkId' in video) {
          (video.setSinkId as (id: string) => Promise<void>)(deviceId)
            .then(() => {
              console.log(`[switchSpeakerDevice] Successfully set speaker device for video element`);
            })
            .catch((error) => {
              console.error('[switchSpeakerDevice] Failed to set speaker device:', error);
            });
        }
      });
    } catch (error) {
      console.error('[switchSpeakerDevice] Failed to switch speaker:', error);
    }
  };

  const handleResolutionChange = async (newResolution: '180p' | '360p' | '480p' | '720p'): Promise<void> => {
    console.log(`[handleResolutionChange] Selected resolution: ${newResolution}, Currently joined: ${joined}`);
    setResolution(newResolution);

    // If not joined, just update the state
    if (!joined || !producerRef.current?.video) {
      console.log(`[handleResolutionChange] Not joined yet or no producer, state will be used on join`);
      return;
    }

    // If joined, restart camera with new resolution
    try {
      console.log(`[handleResolutionChange] Changing resolution to ${newResolution}`);

      // Build video constraints directly (don't depend on async state update)
      let videoConstraints: any;
      switch (newResolution) {
        case '180p':
          videoConstraints = { width: { ideal: 320 }, height: { ideal: 180 } };
          break;
        case '360p':
          videoConstraints = { width: { ideal: 640 }, height: { ideal: 360 } };
          break;
        case '480p':
          videoConstraints = { width: { ideal: 640 }, height: { ideal: 480 } };
          break;
        case '720p':
        default:
          videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
          break;
      }

      // Add current camera device ID to constraints
      if (selectedCameraId) {
        videoConstraints.deviceId = { exact: selectedCameraId };
      }

      // Get audio constraints
      const audioConstraints: any = {};
      if (selectedMicId) {
        audioConstraints.deviceId = { exact: selectedMicId };
      }

      // Get new stream with new resolution
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints,
      });

      const newVideoTrack = newStream.getVideoTracks()[0];

      if (!newVideoTrack) {
        console.error('[handleResolutionChange] No video track in new stream');
        return;
      }

      // Replace the video track in the producer
      await producerRef.current.video.replaceTrack({
        track: newVideoTrack,
      });

      // Update local video ref with new stream
      const oldVideoTracks = localStreamRef.current?.getVideoTracks() || [];
      oldVideoTracks.forEach((track) => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });

      localStreamRef.current?.addTrack(newVideoTrack);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }

      console.log(`[handleResolutionChange] Successfully changed resolution to ${newResolution}`);
    } catch (error) {
      console.error('[handleResolutionChange] Failed to change resolution:', error);
    }
  };

  const handleJoin = async (): Promise<void> => {
    if (socketRef.current === null) {
      if (!meetingId.trim()) {
        alert('미팅 ID를 입력해주세요.');
        return;
      }

      console.log(`[handleJoin] Starting join with resolution state: ${resolution}`);
      socketRef.current = io(SIGNALING_SERVER);
      setJoined(true);
      const stream = await startLocalStream(selectedCameraId, selectedMicId);

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

                // Setup remote audio gain if audio track was added
                if (kind === 'audio') {
                  setupRemoteAudioGain(newStream, peerId);
                }

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

              // Setup remote audio gain if audio track was just added
              if (kind === 'audio') {
                setupRemoteAudioGain(existingPeer.stream, id);
              }

              return prev;
            } else {
              // Create new stream with first track
              const newStream = new MediaStream();
              newStream.addTrack(consumer.track);
              console.log(`[newConsumer] Created new stream with ${kind} track`);

              // Setup remote audio gain if this is an audio track
              if (kind === 'audio') {
                setupRemoteAudioGain(newStream, id);
              }

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
        // Clean up DOM refs for this peer
        delete peerStatsDomRefsRef.current[peerId];

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

    // Clean up Web Audio API contexts
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    micGainNodeRef.current = null;
    micSourceRef.current = null;

    if (speakerAudioContextRef.current) {
      speakerAudioContextRef.current.close();
      speakerAudioContextRef.current = null;
    }
    speakerGainNodesRef.current = new WeakMap();

    localStreamRef.current = null;
    setMicInputEnabled(true);
    setSpeakerEnabled(true);
    setMicInputVolume(1.0);
    setSpeakerVolume(1.0);

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
            onChange={(e) => handleResolutionChange(e.target.value as any)}>
            {supportedResolutions.map((res) => (
              <option key={res} value={res}>{res}</option>
            ))}
          </select>

          <select
            style={styles.deviceSelect}
            value={selectedCameraId}
            onChange={(e) => switchCameraDevice(e.target.value)}
          >
            <option value="">카메라 선택</option>
            {availableDevices.cameras.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
              </option>
            ))}
          </select>

          <select
            style={styles.deviceSelect}
            value={selectedMicId}
            onChange={(e) => switchMicDevice(e.target.value)}
          >
            <option value="">마이크 선택</option>
            {availableDevices.microphones.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${device.deviceId.slice(0, 5)}`}
              </option>
            ))}
          </select>

          <select
            style={styles.deviceSelect}
            value={selectedSpeakerId}
            onChange={(e) => switchSpeakerDevice(e.target.value)}
          >
            <option value="">스피커 선택</option>
            {availableDevices.speakers.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Speaker ${device.deviceId.slice(0, 5)}`}
              </option>
            ))}
          </select>

          
        </div>
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

        {joined && (
          <div style={styles.videoGrid}>
            <div style={{
              ...styles.videoTile,
              display: 'flex',
              flexDirection: 'column',
            }}>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={styles.video}
              />
              <button
                onClick={() => {
                  setExpandedPeers(prev => {
                    const newSet = new Set(prev);
                    if (newSet.has('local')) {
                      newSet.delete('local');
                    } else {
                      newSet.add('local');
                    }
                    return newSet;
                  });
                }}
                style={{
                  padding: '8px 12px',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  fontWeight: '600',
                  color: 'var(--text-muted)',
                  borderTop: '1px solid var(--border-subtle)',
                  background: 'var(--bg-input)',
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-surface)';
                  e.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--bg-input)';
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                <span>나 ({user.userName})</span>
                <span style={{ fontSize: '10px' }}>{expandedPeers.has('local') ? '▼' : '▶'}</span>
              </button>

              {expandedPeers.has('local') && (
                <div style={{ padding: '12px', fontSize: '11px', background: 'var(--bg-input)', borderTop: '1px solid var(--border-subtle)' }}>
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: '600',
                      color: 'var(--text-primary)',
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}>
                      Video
                    </div>
                    <div style={{
                      fontSize: '10px',
                      fontWeight: '600',
                      color: 'var(--text-muted)',
                      marginBottom: '4px',
                    }}>
                      Tx (Send)
                    </div>
                    <div style={{ color: 'var(--text-muted)', lineHeight: '1.4', fontSize: '10px' }}>
                      <div>Bitrate: <span ref={videoSendBitrateRef}>-</span></div>
                      <div>RTT: <span ref={videoSendRTTRef}>-</span></div>
                      <div>Packet Loss: <span ref={videoSendLossRef}>-</span></div>
                      <div>Resolution: <span ref={videoLocalResolutionRef}>-</span></div>
                    </div>
                  </div>

                  <div>
                    <div style={{
                      fontSize: '11px',
                      fontWeight: '600',
                      color: 'var(--text-primary)',
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}>
                      Audio
                    </div>
                    <div style={{
                      fontSize: '10px',
                      fontWeight: '600',
                      color: 'var(--text-muted)',
                      marginBottom: '4px',
                    }}>
                      Tx (Send)
                    </div>
                    <div style={{ color: 'var(--text-muted)', lineHeight: '1.4', fontSize: '10px' }}>
                      <div>Bitrate: <span ref={audioSendBitrateRef}>-</span></div>
                      <div>RTT: <span ref={audioSendRTTRef}>-</span></div>
                      <div>Packet Loss: <span ref={audioSendLossRef}>-</span></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            {Object.entries(peers).map(([id, peerInfo]) => {
              const isExpanded = expandedPeers.has(id);
              const peerStats = peerStatsRef.current[id];

              return (
                <div key={id} style={{
                  ...styles.videoTile,
                  display: 'flex',
                  flexDirection: 'column',
                }}>
                  <video
                    ref={(el) => {
                      if (el) {
                        el.srcObject = peerInfo.stream;
                        // Apply current speaker device if available
                        if (selectedSpeakerId && selectedSpeakerId !== '' && 'setSinkId' in el) {
                          (el.setSinkId as (id: string) => Promise<void>)(selectedSpeakerId).catch(() => {
                            // Silently handle errors
                          });
                        }
                      }
                    }}
                    autoPlay
                    playsInline
                    data-remote-video
                    data-remote-video-id={id}
                    style={styles.video}
                  />
                  <button
                    onClick={() => {
                      setExpandedPeers(prev => {
                        const newSet = new Set(prev);
                        if (newSet.has(id)) {
                          newSet.delete(id);
                        } else {
                          newSet.add(id);
                        }
                        return newSet;
                      });
                    }}
                    style={{
                      padding: '8px 12px',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '12px',
                      fontWeight: '600',
                      color: 'var(--text-muted)',
                      borderTop: '1px solid var(--border-subtle)',
                      background: 'var(--bg-input)',
                      transition: 'all 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--bg-surface)';
                      e.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'var(--bg-input)';
                      e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                  >
                    <span>{peerInfo.userName} ({peerInfo.userId})</span>
                    <span style={{ fontSize: '10px' }}>{isExpanded ? '▼' : '▶'}</span>
                  </button>

                  {isExpanded && peerStats && (
                    <div style={{ padding: '12px', fontSize: '11px', background: 'var(--bg-input)', borderTop: '1px solid var(--border-subtle)' }}>
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{
                          fontSize: '11px',
                          fontWeight: '600',
                          color: 'var(--text-primary)',
                          marginBottom: '8px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}>
                          Video
                        </div>
                        <div style={{
                          fontSize: '10px',
                          fontWeight: '600',
                          color: 'var(--text-muted)',
                          marginBottom: '4px',
                        }}>
                          Rx (Receive)
                        </div>
                        <div style={{ color: 'var(--text-muted)', lineHeight: '1.4', fontSize: '10px' }}>
                          <div>Bitrate: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].videoBitrate = el;
                            }
                          }}>-</span></div>
                          <div>RTT: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].videoRTT = el;
                            }
                          }}>-</span></div>
                          <div>Packet Loss: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].videoLoss = el;
                            }
                          }}>-</span></div>
                        </div>
                      </div>

                      <div>
                        <div style={{
                          fontSize: '11px',
                          fontWeight: '600',
                          color: 'var(--text-primary)',
                          marginBottom: '8px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px',
                        }}>
                          Audio
                        </div>
                        <div style={{
                          fontSize: '10px',
                          fontWeight: '600',
                          color: 'var(--text-muted)',
                          marginBottom: '4px',
                        }}>
                          Rx (Receive)
                        </div>
                        <div style={{ color: 'var(--text-muted)', lineHeight: '1.4', fontSize: '10px' }}>
                          <div>Bitrate: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].audioBitrate = el;
                            }
                          }}>-</span></div>
                          <div>RTT: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].audioRTT = el;
                            }
                          }}>-</span></div>
                          <div>Packet Loss: <span ref={el => {
                            if (el) {
                              if (!peerStatsDomRefsRef.current[id]) {
                                peerStatsDomRefsRef.current[id] = { videoBitrate: null, videoRTT: null, videoLoss: null, audioBitrate: null, audioRTT: null, audioLoss: null };
                              }
                              peerStatsDomRefsRef.current[id].audioLoss = el;
                            }
                          }}>-</span></div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={styles.audioGainSection}>
          <div style={styles.sectionTitle}>Audio Gain</div>
          <div style={styles.gainRow}>
            <span style={styles.gainLabel}>Mic Boost: {micInputVolume.toFixed(2)}x</span>
            <input
              type="range"
              style={styles.slider}
              min="0"
              max="2.5"
              step="0.1"
              value={micInputVolume}
              onChange={handleMicInputVolumeChange}
              disabled={!joined}
            />
          </div>
          <div style={styles.gainRow}>
            <span style={styles.gainLabel}>Speaker Boost: {speakerVolume.toFixed(2)}x</span>
            <input
              type="range"
              style={styles.slider}
              min="0"
              max="2.5"
              step="0.1"
              value={speakerVolume}
              onChange={handleSpeakerVolumeChange}
              disabled={!joined}
            />
          </div>
        </div>


      </div>
    </div>
  );
};


export default MeetingPage;
