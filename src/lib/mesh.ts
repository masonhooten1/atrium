// Browser WebRTC mesh for room media. Signaling rides the room:webrtc relay;
// the deterministic offerer rule (lower socket id offers) keeps each pair on
// exactly one offer/answer exchange with no glare. Framework-free so the
// server and tests can reason about it without React.
import type { RTCSignal } from './protocol'

export interface PeerMeshHooks {
  send: (to: string, signal: RTCSignal) => void
  onStream: (peerId: string, stream: MediaStream) => void
}

export class PeerMesh {
  private pcs = new Map<string, RTCPeerConnection>()
  // ICE candidates that arrive before the remote description is set — the
  // queue flushes in order once it lands.
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private localStream: MediaStream | null = null

  constructor(private readonly hooks: PeerMeshHooks) {}

  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream
  }

  has(peerId: string): boolean {
    return this.pcs.has(peerId)
  }

  peerIds(): string[] {
    return [...this.pcs.keys()]
  }

  // `offer` is true when my socket id sorts before the peer's — each pair
  // agrees on exactly one offerer without any negotiation round.
  async addPeer(peerId: string, offer: boolean): Promise<void> {
    if (this.pcs.has(peerId)) return
    const pc = new RTCPeerConnection({ iceServers: [] })
    this.pcs.set(peerId, pc)
    this.pendingIce.set(peerId, [])

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream)
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (stream) this.hooks.onStream(peerId, stream)
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.hooks.send(peerId, { kind: 'ice', candidate: e.candidate.toJSON() })
    }

    if (offer) {
      const desc = await pc.createOffer()
      await pc.setLocalDescription(desc)
      if (pc.localDescription) this.hooks.send(peerId, { kind: 'desc', description: pc.localDescription.toJSON() })
    }
  }

  async onSignal(from: string, signal: RTCSignal): Promise<void> {
    let pc = this.pcs.get(from)
    if (!pc) {
      // An offer can outrun the membership sync — stand up the receiving side.
      await this.addPeer(from, false)
      pc = this.pcs.get(from)
      if (!pc) return
    }
    if (signal.kind === 'desc') {
      await pc.setRemoteDescription(signal.description)
      const queued = this.pendingIce.get(from) ?? []
      for (const candidate of queued) {
        await pc.addIceCandidate(candidate).catch((err: unknown) => {
          console.debug('ice candidate rejected', err)
        })
      }
      this.pendingIce.set(from, [])
      if (signal.description.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        if (pc.localDescription) this.hooks.send(from, { kind: 'desc', description: pc.localDescription.toJSON() })
      }
      return
    }
    if (!pc.remoteDescription) {
      this.pendingIce.get(from)?.push(signal.candidate)
      return
    }
    await pc.addIceCandidate(signal.candidate).catch((err: unknown) => {
      console.debug('ice candidate rejected', err)
    })
  }

  // Screen share: swap the outgoing video track in place on every sender —
  // the audio track and the connection itself stay up.
  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    for (const pc of this.pcs.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') await sender.replaceTrack(track)
      }
    }
  }

  close(peerId: string): void {
    this.pcs.get(peerId)?.close()
    this.pcs.delete(peerId)
    this.pendingIce.delete(peerId)
  }

  closeAll(): void {
    for (const peerId of [...this.pcs.keys()]) this.close(peerId)
  }
}
