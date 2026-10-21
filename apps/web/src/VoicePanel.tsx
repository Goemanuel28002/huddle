import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, RemoteTrack, Room } from 'livekit-client';

type VoiceChannel = { id: string; name: string };
type Props = { channel: VoiceChannel };
type VoiceMember = { id: string; name: string; speaking: boolean; microphone: boolean; local: boolean };
type JoinResponse = { url: string; token: string; canPublish: boolean };

const getErrorMessage = (error: unknown) => {
  const value = error as { name?: string; message?: string };
  if (value.name === 'NotAllowedError' || value.name === 'PermissionDeniedError') return 'Mikrofonzugriff verweigert. Erlaube den Zugriff in den Browser- oder Systemeinstellungen.';
  if (value.name === 'NotFoundError') return 'Es wurde kein Mikrofon gefunden. Du kannst dem Kanal trotzdem zunächst nur zum Zuhören beitreten.';
  return value.message || 'Die Voice-Verbindung konnte nicht hergestellt werden.';
};

export default function VoicePanel({ channel }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<VoiceMember[]>([]);
  const [microphone, setMicrophone] = useState(false);
  const [canPublish, setCanPublish] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState('Getrennt');
  const [error, setError] = useState('');
  const [pushToTalk, setPushToTalk] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sdk, setSdk] = useState<typeof import('livekit-client') | null>(null);
  const audioRoot = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);

  const updateMembers = useCallback((activeRoom: Room) => {
    const people: Participant[] = [activeRoom.localParticipant, ...activeRoom.remoteParticipants.values()];
    setMembers(people.map((person) => ({
      id: person.identity,
      name: person.name || person.identity,
      speaking: person.isSpeaking,
      microphone: person.isMicrophoneEnabled,
      local: person.identity === activeRoom.localParticipant.identity,
    })));
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      if (!sdk) return;
      const [inputs, outputs] = await Promise.all([sdk.Room.getLocalDevices('audioinput'), sdk.Room.getLocalDevices('audiooutput')]);
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
    } catch { /* Device lists are optional on unsupported browsers. */ }
  }, [sdk]);

  const leave = useCallback(() => {
    roomRef.current?.disconnect();
    roomRef.current = null;
    setRoom(null);
    setMembers([]);
    setMicrophone(false);
    setConnection('Getrennt');
  }, []);

  useEffect(() => () => {
    roomRef.current?.disconnect();
    roomRef.current = null;
  }, [channel.id]);

  useEffect(() => {
    if (!room || !sdk) return;
    const activeRoom = room;
    const refresh = () => updateMembers(activeRoom);
    const subscribed = (track: RemoteTrack) => {
      if (track.kind !== 'audio' || !audioRoot.current) return;
      if (track.sid && Array.from(audioRoot.current.children).some((element) => element.getAttribute('data-track-sid') === track.sid)) return;
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute('playsinline', 'true');
      if (track.sid) element.setAttribute('data-track-sid', track.sid);
      audioRoot.current.appendChild(element);
      void refreshDevices();
    };
    const unsubscribed = (track: RemoteTrack) => track.detach().forEach((element) => element.remove());
    activeRoom.on(sdk.RoomEvent.ParticipantConnected, refresh);
    activeRoom.on(sdk.RoomEvent.ParticipantDisconnected, refresh);
    activeRoom.on(sdk.RoomEvent.ActiveSpeakersChanged, refresh);
    activeRoom.on(sdk.RoomEvent.TrackSubscribed, subscribed);
    activeRoom.on(sdk.RoomEvent.TrackUnsubscribed, unsubscribed);
    activeRoom.on(sdk.RoomEvent.LocalTrackPublished, refresh);
    activeRoom.on(sdk.RoomEvent.LocalTrackUnpublished, refresh);
    activeRoom.on(sdk.RoomEvent.ConnectionStateChanged, (state) => {
      setConnection(state === 'connected' ? 'Verbunden' : state === 'reconnecting' ? 'Verbindung wird wiederhergestellt …' : 'Getrennt');
    });
    // A participant can publish before React attaches the event listeners above.
    // Attach tracks that were already subscribed when the join completed.
    activeRoom.remoteParticipants.forEach((participant) => participant.trackPublications.forEach((publication) => {
      if (publication.track?.kind === 'audio') subscribed(publication.track as RemoteTrack);
    }));
    updateMembers(activeRoom);
    return () => {
      activeRoom.off(sdk.RoomEvent.ParticipantConnected, refresh);
      activeRoom.off(sdk.RoomEvent.ParticipantDisconnected, refresh);
      activeRoom.off(sdk.RoomEvent.ActiveSpeakersChanged, refresh);
      activeRoom.off(sdk.RoomEvent.TrackSubscribed, subscribed);
      activeRoom.off(sdk.RoomEvent.TrackUnsubscribed, unsubscribed);
      activeRoom.off(sdk.RoomEvent.LocalTrackPublished, refresh);
      activeRoom.off(sdk.RoomEvent.LocalTrackUnpublished, refresh);
      activeRoom.disconnect();
    };
  }, [room, sdk, refreshDevices, updateMembers]);

  useEffect(() => {
    if (!room || !pushToTalk || !canPublish) return;
    const press = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      void room.localParticipant.setMicrophoneEnabled(true).then(() => setMicrophone(true)).catch((e) => setError(getErrorMessage(e)));
    };
    const release = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      void room.localParticipant.setMicrophoneEnabled(false).then(() => setMicrophone(false)).catch((e) => setError(getErrorMessage(e)));
    };
    window.addEventListener('keydown', press);
    window.addEventListener('keyup', release);
    return () => { window.removeEventListener('keydown', press); window.removeEventListener('keyup', release); };
  }, [canPublish, pushToTalk, room]);

  async function join() {
    setConnecting(true); setError('');
    try {
      const response = await fetch(`/api/voice/${channel.id}/token`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      const credentials = await response.json() as JoinResponse & { error?: string };
      if (!response.ok) throw new Error(credentials.error || 'Voice-Zugang verweigert.');
      const livekitSdk = await import('livekit-client');
      setSdk(livekitSdk);
      const activeRoom = new livekitSdk.Room({ adaptiveStream: true, dynacast: true });
      await activeRoom.connect(credentials.url, credentials.token, { autoSubscribe: true });
      roomRef.current = activeRoom;
      setRoom(activeRoom);
      setCanPublish(credentials.canPublish);
      setConnection('Verbunden');
      if (credentials.canPublish && !pushToTalk) {
        try {
          await activeRoom.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
          setMicrophone(true);
        } catch (microphoneError) {
          setError(getErrorMessage(microphoneError));
        }
      }
      const [inputs, outputs] = await Promise.all([livekitSdk.Room.getLocalDevices('audioinput'), livekitSdk.Room.getLocalDevices('audiooutput')]);
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
    } catch (joinError) { setError(getErrorMessage(joinError)); }
    finally { setConnecting(false); }
  }

  async function toggleMicrophone() {
    if (!room || !canPublish || pushToTalk) return;
    const next = !microphone;
    try {
      await room.localParticipant.setMicrophoneEnabled(next, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      setMicrophone(next);
      if (next) await refreshDevices();
    } catch (microphoneError) { setError(getErrorMessage(microphoneError)); }
  }

  async function switchDevice(kind: 'audioinput' | 'audiooutput', deviceId: string) {
    if (!room || !deviceId) return;
    try { await room.switchActiveDevice(kind, deviceId); }
    catch (deviceError) { setError(getErrorMessage(deviceError)); }
  }

  return <section className="voice-stage">
    <div className="voice-orbit"><span>◖</span><i /><i /><i /></div>
    <span className="eyebrow">SPRACHKANAL</span>
    <h1>{channel.name}</h1>
    <p className="voice-status"><i className={connection === 'Verbunden' ? 'online' : ''} />{connection} · echte WebRTC-Audioverbindung</p>
    <div className="voice-participants">
      {members.length === 0 ? <span className="voice-empty">Noch niemand ist hier. Tritt bei und sag Hallo.</span> : members.map((person) => <div className={`voice-person ${person.speaking ? 'speaking' : ''}`} key={person.id}><span className="voice-avatar">{person.name.slice(0, 1).toUpperCase()}</span><span>{person.name}{person.local ? ' (Du)' : ''}</span><small>{person.microphone ? 'Mikrofon an' : 'stumm'}</small></div>)}
    </div>
    <div className="voice-controls">
      {!room ? <button className="primary-button compact" onClick={() => void join()} disabled={connecting}>{connecting ? 'Verbindung …' : 'Voice beitreten'}<span>↗</span></button> : <>
        <button className={`voice-control ${microphone ? '' : 'muted'}`} onClick={() => void toggleMicrophone()} disabled={!canPublish || pushToTalk} title={canPublish ? 'Mikrofon umschalten' : 'Du bist während einer Auszeit stummgeschaltet.'}>{microphone ? '🎙' : '🔇'}<span>{microphone ? 'Stumm' : 'Mikrofon an'}</span></button>
        <label className="push-toggle"><input type="checkbox" checked={pushToTalk} onChange={(event) => { setPushToTalk(event.target.checked); if (event.target.checked) { void room.localParticipant.setMicrophoneEnabled(false); setMicrophone(false); } }} />Push-to-Talk <kbd>Leertaste</kbd></label>
        <button className="voice-control leave" onClick={leave}>Verlassen</button>
      </>}
    </div>
    {room && <div className="device-controls"><label>Mikrofon<select aria-label="Mikrofon auswählen" onChange={(event) => void switchDevice('audioinput', event.target.value)}>{audioInputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Mikrofon'}</option>)}</select></label><label>Ausgabe<select aria-label="Audioausgabe auswählen" onChange={(event) => void switchDevice('audiooutput', event.target.value)}>{audioOutputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Lautsprecher'}</option>)}</select></label></div>}
    {error && <div role="alert" className="voice-error">{error}</div>}
    <div className="voice-audio-root" ref={audioRoot} />
  </section>;
}
