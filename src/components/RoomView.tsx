'use client'

// The room surface a door opens into: live camera/mic tiles over the WebRTC
// mesh, a screen-share wall, and the way back out. Media is peer-to-peer —
// the server only relays signaling.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { PeerMesh } from '@/lib/mesh'
import type { ClientToServerEvents, PeerInfo, ServerToClientEvents, WebRTCPacket } from '@/lib/protocol'
import type { RoomKind } from '@/lib/rooms'
import type { StrokeData } from '@/lib/whiteboard'
import Whiteboard from './Whiteboard'

type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface ActiveRoom {
  id: string
  name: string
  kind: RoomKind
  capacity: number
  // Everyone else currently inside, kept fresh by room:peer events.
  peers: PeerInfo[]
  // Whiteboard history served with the join ack — the board is full from
  // the first frame. Live strokes arrive via the sink after mount.
  strokes: StrokeData[]
}

interface VideoTileProps {
  stream: MediaStream | null
  muted?: boolean
  label: string
  testId: string
}

function VideoTile({ stream, muted = false, label, testId }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !stream) return
    el.srcObject = stream
    // Muted autoplay is allowed everywhere; the catch only guards a stray
    // policy rejection so it never becomes an unhandled rejection.
    el.play().catch((err: unknown) => console.debug('video play rejected', err))
  }, [stream])

  return (
    <div
      data-testid={testId}
      className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-slate-950"
    >
      {stream ? (
        <video ref={ref} autoPlay playsInline muted={muted} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
          {label} · no camera
        </div>
      )}
      <span className="absolute bottom-1 left-2 rounded bg-slate-950/70 px-1.5 py-0.5 text-[10px] text-slate-200">
        {label}
      </span>
    </div>
  )
}

export default function RoomView({
  socket,
  selfName,
  selfColor,
  room,
  onLeave,
  // Signals are captured by WorldCanvas from the moment the socket exists —
  // before this view mounts, so nothing is lost to the mount race — and
  // dispatched here through the sink once we subscribe.
  signalSink,
  pendingSignals,
  whiteboardSink,
  pendingWhiteboard,
}: {
  socket: RoomSocket
  selfName: string
  selfColor: string
  room: ActiveRoom
  onLeave: () => void
  signalSink: MutableRefObject<((p: WebRTCPacket) => void) | null>
  pendingSignals: MutableRefObject<WebRTCPacket[]>
  whiteboardSink: MutableRefObject<((stroke: StrokeData) => void) | null>
  pendingWhiteboard: MutableRefObject<StrokeData[]>
}) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [mediaReady, setMediaReady] = useState(false)
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map())
  const [sharingPeers, setSharingPeers] = useState<Set<string>>(new Set())
  const [selfSharing, setSelfSharing] = useState(false)
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [meshVersion, setMeshVersion] = useState(0)
  const meshRef = useRef<PeerMesh | null>(null)
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null)

  // Acquire camera + mic once per room visit. A refused or missing device
  // still gets the person into the room — tiles degrade to name cards.
  useEffect(() => {
    let cancelled = false
    const acquire = async (): Promise<void> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        setLocalStream(stream)
        cameraTrackRef.current = stream.getVideoTracks()[0] ?? null
      } catch (err) {
        console.warn('camera/mic unavailable — joining without media', err)
      } finally {
        if (!cancelled) setMediaReady(true)
      }
    }
    void acquire()
    return () => {
      cancelled = true
    }
  }, [])

  // Offers can outrun getUserMedia: buffer signals until the mesh exists and
  // replay them then, so early signaling is never dropped.
  const pendingSignalsRef = useRef<WebRTCPacket[]>([])

  // Subscribe to the canvas-level capture: packets buffered before this view
  // mounted are drained first, then live ones flow through the sink.
  useEffect(() => {
    pendingSignalsRef.current.push(...pendingSignals.current)
    pendingSignals.current = []
    signalSink.current = (p: WebRTCPacket): void => {
      const mesh = meshRef.current
      if (mesh) void mesh.onSignal(p.from, p.signal)
      else pendingSignalsRef.current.push(p)
    }
    return () => {
      signalSink.current = null
    }
  }, [signalSink, pendingSignals])

  // Build the mesh once media readiness is known, then keep it fed: negotiation
  // with new room-mates, teardown for the departed, and a replay of any signal
  // that arrived before the mesh existed.
  useEffect(() => {
    if (!mediaReady) return
    const mesh = new PeerMesh({
      send: (to, signal) => socket.emit('room:webrtc', { signal, to }),
      onStream: (peerId, stream) =>
        setRemoteStreams((prev) => {
          const next = new Map(prev)
          next.set(peerId, stream)
          return next
        }),
    })
    mesh.setLocalStream(localStream)
    meshRef.current = mesh
    setMeshVersion((v) => v + 1)
    for (const p of pendingSignalsRef.current.splice(0)) void mesh.onSignal(p.from, p.signal)
    return () => {
      mesh.closeAll()
      meshRef.current = null
    }
  }, [mediaReady, localStream, socket])

  // Membership sync: connect to arrivals, close the connections of whoever
  // left. Re-runs when the mesh exists or the roster changes.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    const myId = socket.id ?? ''
    for (const peer of room.peers) {
      if (!mesh.has(peer.id)) void mesh.addPeer(peer.id, myId < peer.id)
    }
    for (const peerId of mesh.peerIds()) {
      if (!room.peers.some((p) => p.id === peerId)) mesh.close(peerId)
    }
  }, [meshVersion, room.peers, socket])

  // Screen-share state of room-mates ("the wall").
  useEffect(() => {
    const onShare = ({ roomId, peerId, sharing }: { roomId: string; peerId: string; sharing: boolean }): void => {
      if (roomId !== room.id || peerId === socket.id) return
      setSharingPeers((prev) => {
        const next = new Set(prev)
        if (sharing) next.add(peerId)
        else next.delete(peerId)
        return next
      })
    }
    socket.on('room:share', onShare)
    return () => {
      socket.off('room:share', onShare)
    }
  }, [socket, room.id])

  const stopShare = useCallback(async (): Promise<void> => {
    setSelfSharing(false)
    setScreenStream(null)
    const camera = cameraTrackRef.current
    if (camera) await meshRef.current?.replaceVideoTrack(camera)
    socket.emit('room:share', { roomId: room.id, sharing: false })
  }, [room.id, socket])

  const shareScreen = useCallback(async (): Promise<void> => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const track = screen.getVideoTracks()[0]
      if (!track) return
      // Sharing replaces our outgoing video feed; the camera track is kept
      // aside so leaving the share restores it without renegotiating.
      track.addEventListener('ended', () => {
        void stopShare()
      })
      setScreenStream(screen)
      setSelfSharing(true)
      await meshRef.current?.replaceVideoTrack(track)
      socket.emit('room:share', { roomId: room.id, sharing: true })
    } catch (err) {
      // A refused picker is the user cancelling, not a failure.
      console.debug('screen share not started', err)
    }
  }, [room.id, socket, stopShare])

  // Stop local devices when the room view goes away.
  useEffect(() => {
    return () => {
      localStream?.getTracks().forEach((t) => t.stop())
      screenStream?.getTracks().forEach((t) => t.stop())
    }
  }, [localStream, screenStream])

  const nameOf = useCallback(
    (peerId: string): string => room.peers.find((p) => p.id === peerId)?.name ?? 'Peer',
    [room.peers],
  )

  // The wall: whoever is sharing — a room-mate first, our own screen second.
  const wall = useMemo(() => {
    for (const peerId of sharingPeers) {
      const stream = remoteStreams.get(peerId)
      if (stream) return { stream, label: `${nameOf(peerId)} · screen` }
    }
    if (selfSharing && screenStream) return { stream: screenStream, label: `${selfName} · screen` }
    return null
  }, [sharingPeers, remoteStreams, selfSharing, screenStream, selfName, nameOf])

  return (
    <div
      data-testid="room-view"
      data-room={room.id}
      className="absolute inset-0 z-30 flex flex-col bg-slate-950/90 p-4 backdrop-blur-md"
    >
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{room.name}</h2>
          <p className="text-xs text-slate-400">
            {room.peers.length + 1}/{room.capacity} seats · live media
          </p>
        </div>
        <div className="flex gap-2">
          {selfSharing ? (
            <button
              type="button"
              data-testid="stop-share"
              onClick={() => void stopShare()}
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-400/20"
            >
              Stop sharing
            </button>
          ) : (
            <button
              type="button"
              data-testid="share-screen"
              onClick={() => void shareScreen()}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 hover:bg-white/10"
            >
              Share screen
            </button>
          )}
          <button
            type="button"
            data-testid="leave-room"
            onClick={onLeave}
            className="rounded-lg bg-rose-500/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-rose-400"
          >
            Leave
          </button>
        </div>
      </header>

      {wall ? (
        <div className="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black">
          <video
            data-testid="room-wall"
            autoPlay
            playsInline
            muted
            ref={(el) => {
              if (el && el.srcObject !== wall.stream) el.srcObject = wall.stream
            }}
            className="h-full w-full object-contain"
          />
          <span className="absolute right-3 top-3 rounded bg-slate-950/70 px-2 py-1 text-xs text-slate-200">
            Room wall · {wall.label}
          </span>
        </div>
      ) : null}

      {/* The whiteboard surface lives in huddle zones and the boardroom —
          rooms people meet in to make something. Pods are tight booths. */}
      {room.kind === 'huddle' || room.kind === 'boardroom' ? (
        <div className="mt-3">
          <Whiteboard
            socket={socket}
            roomId={room.id}
            selfColor={selfColor}
            initialStrokes={room.strokes}
            whiteboardSink={whiteboardSink}
            pendingWhiteboard={pendingWhiteboard}
          />
        </div>
      ) : null}

      <div className="mt-3 grid max-h-56 grid-cols-2 content-start gap-3 overflow-auto md:grid-cols-4">
        <VideoTile stream={localStream} muted label={selfName} testId="tile-self" />
        {room.peers.map((peer) => (
          <VideoTile
            key={peer.id}
            stream={remoteStreams.get(peer.id) ?? null}
            label={peer.name}
            testId={`tile-${peer.name}`}
          />
        ))}
      </div>
    </div>
  )
}
