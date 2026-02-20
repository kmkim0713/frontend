# CLAUDE.md

## 0. Overview

This project is a React-based frontend application for a WebRTC video conferencing service.

The frontend is responsible for:

- Capturing local media (camera / microphone)
- Managing RTCPeerConnection
- Handling signaling communication
- Rendering local and remote video streams
- Managing UI state for rooms and participants

It MUST NOT:

- Implement signaling server logic
- Implement SFU media routing logic
- Contain backend-specific business logic


---

## 1. TypeScript Rules (MANDATORY)

All code MUST be written in TypeScript.

### 1.1 Strict TypeScript Configuration

The project must enable:

- "strict": true
- "noImplicitAny": true
- "strictNullChecks": true
- "noUnusedLocals": true
- "noUnusedParameters": true

Never use:

- any
- @ts-ignore
- @ts-nocheck

All props, hooks, and message payloads must have explicit types.


### 1.2 Type Definitions

- Define types for signaling messages.
- Define types for PeerConnection state.
- Strongly type all component props.
- Strongly type context values.

Example:

```ts
interface SignalingMessage {
  type: "offer" | "answer" | "ice-candidate" | "join" | "leave";
  payload: unknown;
}
```

Avoid using `unknown` without proper narrowing.


---

## 2. React Development Rules

### 2.1 Functional Components Only

- Use only Functional Components.
- Do NOT use class components.
- Use React Hooks exclusively.

Allowed Hooks:
- useState
- useEffect
- useRef
- useCallback
- useMemo
- useContext

No deprecated lifecycle methods.


### 2.2 State Management

- Avoid deeply nested state objects.
- Separate UI state from WebRTC state.
- Do not store large MediaStream objects in unnecessary global state.

Use:

- useRef for RTCPeerConnection
- useRef for MediaStream
- useState for UI state only

RTCPeerConnection should not be recreated unnecessarily.


### 2.3 useEffect Rules

- Always clean up side effects.
- Close RTCPeerConnection on unmount.
- Stop all media tracks on leave.
- Remove event listeners properly.

Example cleanup:

```ts
return () => {
  peerConnection.close();
  localStream.getTracks().forEach(track => track.stop());
};
```


### 2.4 Performance Considerations

- Avoid unnecessary re-renders.
- Memoize callbacks when passing to children.
- Avoid inline object literals in JSX props.
- Do not recreate PeerConnection inside render.


---

## 3. WebRTC Frontend Rules

### 3.1 PeerConnection Handling

- Only one RTCPeerConnection per remote peer.
- ICE candidates must be added safely.
- Handle signaling state changes carefully.
- Check connectionState and iceConnectionState events.

Never ignore connection state transitions.


### 3.2 Media Handling

- Always request permissions explicitly.
- Handle permission denial gracefully.
- Stop tracks when user leaves the room.
- Avoid memory leaks from MediaStreams.

Never assume media devices are available.


### 3.3 Error Handling

- Wrap getUserMedia in try/catch.
- Show user-friendly error messages.
- Do not expose raw error stack traces in UI.


---

## 4. Project Structure

Recommended structure:

- src/
  - components/
  - hooks/
  - context/
  - services/
  - types/
  - utils/

Separate:

- UI components
- WebRTC logic
- Signaling communication
- State logic


---

## 5. Code Quality Rules

- Keep components small and single-purpose.
- Avoid business logic inside JSX.
- Extract complex WebRTC logic into hooks.
- No console.log in production.
- Use early returns to reduce nesting.
- Prefer async/await over Promise chains.


---

## 6. Security & Stability

- Never trust signaling data blindly.
- Validate incoming message shape.
- Handle unexpected peer disconnect.
- Clean up on page refresh or navigation.


---

## 7. What CLAUDE Must Do

When modifying this project, Claude must:

1. Maintain strict TypeScript compliance.
2. Avoid introducing any `any`.
3. Properly clean up all WebRTC resources.
4. Not mix UI logic with WebRTC core logic.
5. Refactor if components grow too large.
6. Ensure no memory leaks.
7. Keep PeerConnection lifecycle deterministic.


---

## 8. Repository Safety Rule

Claude MUST NOT perform git commits, pushes, rebases, or any repository-modifying VCS operations autonomously.

Specifically:

- Do NOT run `git commit`
- Do NOT run `git push`
- Do NOT run `git rebase`
- Do NOT run `git reset`
- Do NOT create branches
- Do NOT modify git history in any way

Claude may suggest commit messages or version control strategies,  
but must never execute repository write operations.

All commit actions must be explicitly performed by a human developer.


Always review this CLAUDE.md before making changes.