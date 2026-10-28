import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MiraScene from './MiraScene.jsx';
import VideoStage from '../media/VideoStage.jsx';

window.__videoEvents = [];

function CaptureEntry() {
  const [clip, setClip] = useState(new URLSearchParams(location.search).get('video'));
  useEffect(() => { window.__setClip = setClip; }, []);
  return <><MiraScene status="idle" emotion="warm" />{clip && <VideoStage clip={clip} onClose={() => setClip(null)} onCue={(cue) => window.__videoEvents.push({ type: 'cue', cue })} onState={(state) => window.__videoEvents.push({ type: 'state', state })} />}</>;
}

createRoot(document.getElementById('capture-root')).render(React.createElement(CaptureEntry));
