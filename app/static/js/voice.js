// Voice chat between pilots on the same map (during a round on team maps: the same team): a WebRTC audio connection to every other pilot who
// has voice on (a full mesh, fine for a handful of players). The game's WebSocket carries the
// signalling ('rtc' messages relayed by the server); the pilot with the lower id makes the offer.
// STUN/TURN servers come from the game server (/ice: our coturn with short-lived credentials).
// The microphone starts muted and is toggled with talk().

const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_REFRESH = 3 * 3600 * 1000; // TURN credentials live 6 h; fetch new ones well before

export class Voice {
  constructor(net) {
    this.net = net;
    this.stream = null; // our microphone
    this.talking = false;
    this.peers = new Map(); // player id -> { pc, audio, pending ICE candidates }
    this.level = 1; // how loud the other pilots are, 0..1 (the menu's voice level)
    this.iceServers = FALLBACK_ICE;
    this.iceFetched = 0;
  }

  async refreshIce() {
    if (Date.now() - this.iceFetched < ICE_REFRESH) return;
    this.iceFetched = Date.now(); // also keeps sync() from piling up requests while this one runs
    try {
      this.iceServers = (await (await fetch('/ice')).json()).iceServers;
    } catch {
      this.iceFetched = Date.now() - ICE_REFRESH + 60_000; // retry in a minute
    }
  }

  get enabled() {
    return this.stream !== null;
  }

  // Asks for the microphone; must run from a user gesture (e.g. the Play button).
  async enable() {
    if (this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      return false;
    }
    this.talk(false);
    await this.refreshIce();
    return true;
  }

  disable() {
    this.closeAll();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.talking = false;
  }

  talk(on) {
    this.talking = on && this.enabled;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = this.talking));
  }

  // Called with the other pilots on the map who have voice on; opens and closes connections.
  sync(ids) {
    if (!this.enabled || this.net.id === null) return;
    this.refreshIce();
    for (const id of ids) {
      if (!this.peers.has(id) && this.net.id < id) this.call(id);
    }
    for (const id of [...this.peers.keys()]) if (!ids.includes(id)) this.close(id);
  }

  setVolume(level) {
    this.level = level;
    for (const p of this.peers.values()) p.audio.volume = level;
  }

  peer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = this.level;
    const p = { pc, audio, pendingIce: [] };
    this.peers.set(id, p);
    for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(id, { ice: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      // Dropped connections are closed here and re-offered by the next sync()
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close(id);
    };
    return p;
  }

  async call(id) {
    const { pc } = this.peer(id);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      this.signal(id, { sdp: pc.localDescription.toJSON() });
    } catch {
      this.close(id);
    }
  }

  signal(id, data) {
    this.net.send({ type: 'rtc', to: id, data });
  }

  async onSignal(from, data) {
    if (!this.enabled) return;
    let p = this.peers.get(from);
    try {
      if (data.sdp?.type === 'offer') {
        if (p) this.close(from); // the other side restarted
        p = this.peer(from);
        await p.pc.setRemoteDescription(data.sdp);
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        this.signal(from, { sdp: p.pc.localDescription.toJSON() });
        this.flushIce(p);
      } else if (data.sdp?.type === 'answer' && p) {
        await p.pc.setRemoteDescription(data.sdp);
        this.flushIce(p);
      } else if (data.ice && p) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice);
        else p.pendingIce.push(data.ice);
      }
    } catch {
      this.close(from);
    }
  }

  flushIce(p) {
    for (const c of p.pendingIce.splice(0)) p.pc.addIceCandidate(c).catch(() => {});
  }

  close(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    p.audio.srcObject = null;
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.close(id);
  }
}
