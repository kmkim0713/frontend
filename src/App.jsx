import React, { useState, useRef, useEffect } from 'react';
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const SIGNALING_SERVER = 'http://localhost:3000'; // 시그널링 서버 주소
const ICE_SERVERS = [
  { urls: 'stun:127.0.0.1:3478' }, // STUN 서버
  { urls: 'turn:127.0.0.1:3478', username: 'user1', credential: 'pass1' } // TURN 서버
];

export default function App() {
  const [joined, setJoined] = useState(false);
  const [peers, setPeers] = useState({});
  const localVideoRef = useRef();
  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const producerRef = useRef(null);
  const consumerTransportsRef = useRef({});
  const roomId = 'default';

  // useEffect(() => {
  //   console.log('화면 load')
  //   socketRef.current = io(SIGNALING_SERVER);
  // }, []);

  const startLocalStream = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideoRef.current.srcObject = stream;
    return stream;
  };

  const handleJoin = async () => {
    console.log("🛑🛑🛑 ~~~ :35 ~~~ handleJoin ~~~ socketRef.current:", socketRef.current);

    if (socketRef.current === null) {
      socketRef.current = io(SIGNALING_SERVER);
      setJoined(true);
      const stream = await startLocalStream(); // 로컬 스트림 가져옴

      socketRef.current.emit('join-room', { roomId }, async ({ existingProducers }) => {
        console.log('기존 프로듀서들:', existingProducers);

        for (const peerInfo of existingProducers) {
          const { peerId, producers } = peerInfo;

          if (!consumerTransportsRef.current[peerId]) {
            const recvTransportData = await new Promise(resolve =>
              socketRef.current.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
            );

            const recvTransport = deviceRef.current.createRecvTransport({
              ...recvTransportData,
              iceServers: ICE_SERVERS
            });

            recvTransport.on('connect', ({ dtlsParameters }, callback) => {
              socketRef.current.emit('connect-transport', { transportId: recvTransport.id, dtlsParameters }, callback);
            });

            consumerTransportsRef.current[peerId] = recvTransport;
          }

          const recvTransport = consumerTransportsRef.current[peerId];

          // peer 안의 각 프로듀서 반복
          for (const producer of producers) {
            const { id: producerId, kind } = producer;

            const consumerData = await new Promise(resolve =>
              socketRef.current.emit('consume', { transportId: recvTransport.id, producerId, kind }, resolve)
            );

            const consumer = await recvTransport.consume({
              id: consumerData.id,
              producerId,
              kind: consumerData.kind,
              rtpParameters: consumerData.rtpParameters
            });

            // 기존 stream 있으면 트랙 추가, 없으면 새로 생성
            setPeers(prev => {
              const existingStream = prev[peerId] || new MediaStream();
              existingStream.addTrack(consumer.track);
              return { ...prev, [peerId]: existingStream };
            });
          }




        }
      });



      // 1. 서버로부터 Router RTP Capabilities 받기 
      // (클라이언트(브라우저)가 어떤 RTP 코덱/포맷을 처리할 수 있는지에 대한 서버의 정보)
      const rtpCapabilities = await new Promise(resolve => {
        socketRef.current.once('rtp-capabilities', resolve);
      });
      console.log('RTP Capabilities', rtpCapabilities);

      // 2. Mediasoup Device 생성
      // SFU는 단순히 "스트림 교환"만 하는 게 아니라, 어떤 코덱/암호화/네트워크 설정을 쓸지 협상(Negotiation)해야 함.
      // mediasoupClient.Device()는 브라우저의 WebRTC 엔진을 SFU와 호환되게 제어하기 위한 미들웨어(추상화 계층).
      // 처음 생성 시점에서는 아직 코덱 정보가 없으며, 단순히 빈 컨트롤 객체 상태임.
      const device = new mediasoupClient.Device();

      // SFU가 지원하는 RTP Capabilities(routerRtpCapabilities)를 로드하여
      // 브라우저(WebRTC)와 SFU 간에 공통으로 사용할 수 있는 코덱/포맷 세트를 계산함.
      // 이를 통해 내부적으로 SDP 생성 로직과 트랜스포트 초기화 로직이 준비됨.
      await device.load({ routerRtpCapabilities: rtpCapabilities });
      deviceRef.current = device;

      // 3. Send Transport 생성
      // send용 WebRTC transport 생성 요청
      // SFU가 WebRtcTransport 생성
      // ICE/DTLS 관련 정보를 반환(transport id, iceParameters, iceCandidates, dtlsParameters)
      const sendTransportData = await new Promise(resolve => {
        socketRef.current.emit('create-web-rtc-transport', {}, resolve);
      });

      // 브라우저가 Transport 객체 생성 (sendTransport가 SFU로 보낼 미디어 스트림을 담당)
      const sendTransport = device.createSendTransport({
        ...sendTransportData,
        iceServers: ICE_SERVERS
      });

      // 브라우저에서 DTLS 파라미터를 서버에 보내 SFU 쪽 Transport와 연결(브라우저 ↔ SFU 간 암호화된 미디어 전송 경로가 열림)
      // sendTransport 내부 이벤트 connect는 sendTransport가 SFU와 DTLS 연결을 맺어야 할 때 내부적으로 트리거됨
      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        socketRef.current.emit('connect-transport', { transportId: sendTransport.id, dtlsParameters }, callback);
      });

      // 브라우저에서 새 MediaTrack(producer)을 Send Transport에 등록하려고 할 때 호출 (sendTransport.produce 수행시 호출되는 이벤트)
      sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        const { id } = await new Promise(resolve =>
          socketRef.current.emit('produce', { transportId: sendTransport.id, kind, rtpParameters }, resolve));
        callback({ id });
      });

      // 미디어 스트림 추출
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      // track 정보를 내부적으로 produce 이벤트로 SFU에 전송
      producerRef.current = {
        video: await sendTransport.produce({ track: videoTrack }),
        audio: await sendTransport.produce({ track: audioTrack }),
      };

      // 4. 서버로부터 다른 참여자 정보 받기
      socketRef.current.on('newConsumer', async ({ producerId, id, kind }) => {
        if (!consumerTransportsRef.current[id]) {
          // receive transport 생성
          const recvTransportData = await new Promise(resolve =>
            socketRef.current.emit('create-web-rtc-transport', { direction: 'recv' }, resolve)
          );

          const recvTransport = device.createRecvTransport({
            ...recvTransportData,
            iceServers: ICE_SERVERS
          });

          recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socketRef.current.emit('connect-transport', { transportId: recvTransport.id, dtlsParameters }, callback);
          });

          consumerTransportsRef.current[id] = recvTransport;

          // consume
          const consumerData = await new Promise(resolve =>
            socketRef.current.emit('consume', { transportId: recvTransport.id, producerId, kind }, resolve)
          );

          const consumer = await recvTransport.consume({
            id: consumerData.id,
            producerId,
            kind: consumerData.kind,
            rtpParameters: consumerData.rtpParameters,
          });

          const stream = new MediaStream();
          stream.addTrack(consumer.track);

          setPeers(prev => ({ ...prev, [id]: stream }));
        }
      });


      socketRef.current.on('peer-disconnected', (peerId) => {
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

  const handleLeave = () => {
    // 1. Producer 정리
    if (producerRef.current) {
      producerRef.current.video?.close();
      producerRef.current.audio?.close();
    }

    // 2. Send Transport 정리
    deviceRef.current?.sendTransport?.close();

    // 3. Receive Transport 정리
    Object.values(consumerTransportsRef.current).forEach(t => t.close());
    consumerTransportsRef.current = {};

    // 4. MediaStream 정리
    localVideoRef.current?.srcObject?.getTracks().forEach(track => track.stop());
    setPeers({});
    setJoined(false);

    // 5. Signaling 서버에 leave 알림
    socketRef.current?.emit('leave-room', { roomId });

    // 6. 소켈 disconnect
    socketRef.current.disconnect();
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
