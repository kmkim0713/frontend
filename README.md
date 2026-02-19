# Frontend

mediasoup-client 기반의 다자간 화상회의 웹 클라이언트입니다.

## 기술 스택

| 항목 | 기술 |
|------|------|
| UI 프레임워크 | React 18 |
| WebRTC 클라이언트 | mediasoup-client ^3.18.0 |
| 실시간 통신 | Socket.IO Client ^4.7.2 |
| 빌드 도구 | Vite ^4.5.0 |

## 포트

- **5173** - Vite 개발 서버

## 주요 기능

- 로컬 카메라/마이크 캡처 (`getUserMedia`)
- Send Transport를 통한 미디어 송출 (video/audio)
- Recv Transport를 통한 원격 피어 미디어 수신
- 방 입장 시 기존 참여자 스트림 자동 구독
- 신규 참여자 입장 시 실시간 스트림 추가 (`newConsumer`)
- 참여자 퇴장 시 스트림 자동 제거 (`peer-disconnected`)
- 입장/퇴장 버튼으로 소켓 연결 생명주기 관리

## 프로젝트 구조

```
frontend/
├── src/
│   ├── main.jsx          # 엔트리 포인트
│   └── App.jsx           # 메인 컴포넌트 (모든 화상회의 로직)
├── index.html            # HTML 템플릿
├── vite.config.js        # Vite 설정
└── package.json
```

## 환경 설정

`App.jsx` 내 서버 주소 설정:

```javascript
const SIGNALING_SERVER = 'http://localhost:3000';  // 시그널링 서버
const ICE_SERVERS = [
  { urls: 'stun:127.0.0.1:3478' },                // STUN 서버
  { urls: 'turn:127.0.0.1:3478', username: 'user1', credential: 'pass1' }  // TURN 서버
];
```

## 실행 방법

```bash
npm install
npm run dev
```

## 동작 흐름

1. **입장** 클릭 → Socket.IO 연결 + 로컬 미디어 캡처
2. `join-room` 이벤트로 기존 Producer 목록 수신
3. Mediasoup Device 생성 및 RTP Capabilities 로드
4. Send Transport 생성 → DTLS 연결 → video/audio Produce
5. 기존 피어의 Recv Transport 생성 → Consume
6. `newConsumer` 이벤트로 신규 피어 자동 구독
7. **퇴장** 클릭 → Producer/Transport 정리 → 소켓 해제
