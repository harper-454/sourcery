// web-app/src/App.jsx
import React, { useState, useEffect, useRef } from 'react';
import workletUrl from './audio/processor.js?url';

const CONNECTION_STATES = {
  DISCONNECTED: 'Disconnected',
  CONNECTING: 'Connecting',
  CONNECTED: 'Connected (Waiting for Stream)',
  STREAMING: 'Streaming Live',
  ERROR: 'Connection Error',
};

const VOCAL_PROFILES = {
  BYPASS: 'Bypass (Raw Audio)',
  STUDIO: 'Studio Vocal (Subtle leveler)',
  WHISPER: 'Voice Maximizer (Aggressive AGC)',
  TUNNEL: 'Tunnel Mode (Wind Cut & Gate)',
  EXTREME: 'Extreme Clear (Max Intelligibility)',
  SECURITY: 'Security Monitor & Sneak Detector',
};

export default function App() {
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.DISCONNECTED);
  const [room, setRoom] = useState('demo-room');
  const [relayHost, setRelayHost] = useState('');
  const [vocalProfile, setVocalProfile] = useState('STUDIO');
  const [hasTappedStart, setHasTappedStart] = useState(false);
  const [forceFullSuite, setForceFullSuite] = useState(() => {
    // Detect mobile device (phone/tablet) via User Agent
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    return !isMobile;
  });
  
  // Custom manual DSP overrides
  const [gateEnabled, setGateEnabled] = useState(true);
  const [gateThreshold, setGateThreshold] = useState(0.005);
  const [vocalRecoveryEnabled, setVocalRecoveryEnabled] = useState(true);
  const [vocalRecoveryMaxGain, setVocalRecoveryMaxGain] = useState(6.0);
  const [compressorEnabled, setCompressorEnabled] = useState(true);
  const [clarityEqEnabled, setClarityEqEnabled] = useState(true);
  const [windCutEnabled, setWindCutEnabled] = useState(true);
  const [rnnoiseEnabled, setRnnoiseEnabled] = useState(true);
  const [rnnoiseLoaded, setRnnoiseLoaded] = useState(false);

  // AI-Assisted System States
  const [aiAutoPilot, setAiAutoPilot] = useState(true);
  const [aiAutoLogs, setAiAutoLogs] = useState(['AI: System initialized. Standing by.']);
  const [aiDecipherActive, setAiDecipherActive] = useState(false);
  const [aiTranscript, setAiTranscript] = useState('');

  // Audio Session Recording States
  const [isRecording, setIsRecording] = useState(false);

  // Security Monitoring States
  const [securitySensitivity, setSecuritySensitivity] = useState(5);
  const [ambientNoiseFloor, setAmbientNoiseFloor] = useState(0.0015);
  const [securityAlertState, setSecurityAlertState] = useState('SECURE');
  const [securityEvents, setSecurityEvents] = useState([
    { id: '1', timestamp: new Date().toLocaleTimeString(), type: 'system', details: 'Security system online. Standing by.' }
  ]);
  const [isAlarmMuted, setIsAlarmMuted] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);

  // Microphone Profile & Calibration States
  const [micType, setMicType] = useState('BUILTIN');
  const [micCalibrationMode, setMicCalibrationMode] = useState('MANUAL'); 
  const [preampGainDb, setPreampGainDb] = useState(0.0); 
  const [isMicCalibrating, setIsMicCalibrating] = useState(false);
  const [micCalibrationLogs, setMicCalibrationLogs] = useState([
    'Mic Profile: System active. Ready for hardware configuration.'
  ]);

  // Live telemetry
  const [diagnostics, setDiagnostics] = useState({
    packetsReceived: 0,
    bufferSamples: 0,
    volumeRms: 0,
    rawRms: 0,
    appliedGain: 1.0,
    isGated: false,
    catchups: 0,
    streamActive: false,
    hardwareSampleRate: 44100
  });

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamSampleRateRef = useRef(48000); // Track incoming stream sample rate dynamically
  const workletNodeRef = useRef(null);
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const lastAiLogTimeRef = useRef(0);
  const pingIntervalRef = useRef(null);
  
  // Web Worker Ref for local Whisper transcription
  const whisperWorkerRef = useRef(null);
  const isWhisperReadyRef = useRef(false);

  // Recording references to prevent re-renders on every audio block
  const recordedChunksRef = useRef([]);
  const isRecordingRef = useRef(false);

  // Web Audio Node Refs for real-time DSP tweaking
  const highPass1Ref = useRef(null);
  const highPass2Ref = useRef(null);
  const eqSpeechRef = useRef(null);
  const eqWhisperRef = useRef(null);
  const compressorRef = useRef(null);

  // RNNoise references
  const rnnoiseQueueRef = useRef(new Float32Array(0));
  const denoiseStateRef = useRef(null);

  // Security references
  const lastSneakTriggerRef = useRef(0);
  const lastIntrusionTriggerRef = useRef(0);
  const calibrationSumRef = useRef(0);
  const calibrationCountRef = useRef(0);

  // *** BUG FIX: mirror micType into a ref so updateDspGraph never captures a stale closure ***
  const micTypeRef = useRef('BUILTIN');

  // Diagnostic / self-test state
  const [diagResults, setDiagResults] = useState(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [showDiagPanel, setShowDiagPanel] = useState(false);

  const playAlarmBeep = () => {
    if (isAlarmMuted) return;
    let ctx = audioContextRef.current;
    let ownCtx = false;
    if (!ctx) {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioContext();
        ownCtx = true;
      } catch (e) {
        return;
      }
    }
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(980, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.35);
      
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start(now);
      osc.stop(now + 0.35);
      
      if (ownCtx) {
        setTimeout(() => {
          try { ctx.close(); } catch (e) {}
        }, 500);
      }
    } catch (e) {
      console.error('Failed to play synthesized alarm beep:', e);
    }
  };

  const startRoomCalibration = () => {
    if (connectionState !== CONNECTION_STATES.STREAMING) {
      setAiAutoLogs(prev => [...prev, 'AI Warning: Cannot calibrate room. Stream is not connected.']);
      return;
    }
    setIsCalibrating(true);
    calibrationSumRef.current = 0;
    calibrationCountRef.current = 0;
    setAiAutoLogs(prev => [...prev, 'AI: Calibrating room noise floor... Remain perfectly silent.']);

    setTimeout(() => {
      setIsCalibrating(false);
      const avgRms = calibrationCountRef.current > 0 
        ? calibrationSumRef.current / calibrationCountRef.current 
        : 0.0015;
      const floor = Math.max(0.0003, Math.min(0.015, avgRms));
      setAmbientNoiseFloor(floor);
      const dbVal = (20 * Math.log10(floor)).toFixed(0);
      setSecurityEvents(prev => [
        {
          id: String(Date.now()),
          timestamp: new Date().toLocaleTimeString(),
          type: 'calibrated',
          details: `⚙️ ROOM CALIBRATED: Base ambient noise floor locked at ${dbVal} dB (${(floor * 1000).toFixed(2)}m-RMS)`
        },
        ...prev
      ]);
      setAiAutoLogs(prev => [...prev, `AI: Calibration complete. Noise floor locked at ${dbVal} dB.`]);
    }, 3000);
  };

  // Active Microphone Calibration refs
  const calibNoiseSumRef = useRef(0);
  const calibNoiseCountRef = useRef(0);
  const calibVoiceMaxRef = useRef(0);
  const calibPhaseRef = useRef('NONE'); // NONE, SILENCE, SPEAKING

  // Telemetry Accumulator for Active Hardware Calibration
  useEffect(() => {
    if (!isMicCalibrating || connectionState !== CONNECTION_STATES.STREAMING) return;

    const rawRms = diagnostics.rawRms;
    
    if (calibPhaseRef.current === 'SILENCE') {
      calibNoiseSumRef.current += rawRms;
      calibNoiseCountRef.current += 1;
    } else if (calibPhaseRef.current === 'SPEAKING') {
      if (rawRms > calibVoiceMaxRef.current) {
        calibVoiceMaxRef.current = rawRms;
      }
    }
  }, [diagnostics.rawRms, isMicCalibrating, connectionState]);

  const startActiveMicCalibration = () => {
    if (connectionState !== CONNECTION_STATES.STREAMING) {
      setMicCalibrationLogs(prev => [...prev, 'Mic Profile Warning: Connect microphone stream first.']);
      return;
    }

    setIsMicCalibrating(true);
    calibNoiseSumRef.current = 0;
    calibNoiseCountRef.current = 0;
    calibVoiceMaxRef.current = 0;
    
    setMicCalibrationLogs([
      '⚙️ CALIBRATION INITIATED: Locking in target levels.',
      '🔇 PHASE 1: Room noise floor scan active. Remain completely silent now...'
    ]);
    calibPhaseRef.current = 'SILENCE';

    // Step 1: After 2 seconds, lock noise floor and start voice scanning
    setTimeout(() => {
      const avgNoise = calibNoiseCountRef.current > 0 
        ? calibNoiseSumRef.current / calibNoiseCountRef.current 
        : 0.0015;
      
      const lockedFloor = Math.max(0.0002, Math.min(0.02, avgNoise));
      const floorDb = (20 * Math.log10(lockedFloor)).toFixed(0);
      
      setMicCalibrationLogs(prev => [
        ...prev,
        `✅ PHASE 1 COMPLETE: Ambient noise floor locked at ${floorDb} dB.`,
        '🗣️ PHASE 2: Vocal peak sensitivity scan active. Speak or whisper naturally now...'
      ]);
      calibPhaseRef.current = 'SPEAKING';

      // Step 2: After another 3 seconds (5 seconds total), finish calibration
      setTimeout(() => {
        calibPhaseRef.current = 'NONE';
        
        const finalNoise = lockedFloor;
        const finalPeak = Math.max(0.001, calibVoiceMaxRef.current);
        const peakDb = (20 * Math.log10(finalPeak)).toFixed(1);

        // Preamp gain calculation: Target -16dB RMS peak (0.158)
        const targetLinear = 0.158;
        const requiredGain = targetLinear / finalPeak;
        let gainDb = 20 * Math.log10(requiredGain);
        gainDb = Math.max(-12.0, Math.min(24.0, gainDb)); // Clamp to standard preamps

        // Optimized Gate: Set to exactly 4dB (1.58x) above noise floor
        const gateVal = Math.max(0.0006, Math.min(0.025, finalNoise * 1.58));
        const gateDb = (20 * Math.log10(gateVal)).toFixed(0);

        // Hardware classification & EQ configs based on noise levels
        let classifiedType = 'CONDENSER';
        let classificationText = '';
        
        if (finalNoise > 0.006) { // > -44dB: Built-in Mic
          classifiedType = 'BUILTIN';
          setWindCutEnabled(true);
          setClarityEqEnabled(true);
          setRnnoiseEnabled(true);
          classificationText = '💻 BUILT-IN CAPSULE (High self-noise, desk rumbling detected. Aggressive rumble filters engaged.)';
        } else if (finalNoise < 0.001) { // < -60dB: Dynamic Mic
          classifiedType = 'DYNAMIC';
          setWindCutEnabled(true);
          setClarityEqEnabled(true);
          setRnnoiseEnabled(false);
          classificationText = '🎚️ DYNAMIC BROADCAST (Ultra-low self-noise, excellent isolation. Flat analog path configured.)';
        } else { // USB Condenser
          classifiedType = 'CONDENSER';
          setWindCutEnabled(true);
          setClarityEqEnabled(true);
          setRnnoiseEnabled(true);
          classificationText = '🎙️ STUDIO CONDENSER (Balanced flat-response capture. Mild neural noise gate engaged.)';
        }

        // Apply calibrated coefficients to active board
        setMicType(classifiedType);
        setPreampGainDb(parseFloat(gainDb.toFixed(1)));
        setGateEnabled(true);
        setGateThreshold(gateVal);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(Math.max(2.5, Math.min(12.0, 16.0 - gainDb))); // Dynamic AGC limits

        setMicCalibrationLogs(prev => [
          ...prev,
          `✅ PHASE 2 COMPLETE: Vocal peak scanned at ${peakDb} dB.`,
          `🔍 CLASSIFIED DEVICE: ${classificationText}`,
          `🎛️ PREAMP OPTIMIZED: Dialed to ${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB gain.`,
          `🔒 NOISE GATE LOCKED: Threshold adjusted to ${gateDb} dB (+4dB above noise floor).`,
          '🎉 CALIBRATION COMPLETE: DSP studio board optimized!'
        ]);

        setIsMicCalibrating(false);
      }, 3000);

    }, 2000);
  };

  // Real-Time Security Detection Engine
  useEffect(() => {
    if (vocalProfile !== 'SECURITY' || connectionState !== CONNECTION_STATES.STREAMING) {
      if (securityAlertState !== 'SECURE') {
        setSecurityAlertState('SECURE');
      }
      return;
    }

    if (isCalibrating) {
      calibrationSumRef.current += diagnostics.rawRms;
      calibrationCountRef.current += 1;
      return;
    }

    const rawRms = diagnostics.rawRms;
    const now = Date.now();
    const sneakMultiplier = 6.5 - (securitySensitivity * 0.5);
    const intrusionMultiplier = 13.0 - (securitySensitivity * 0.9);

    const sneakThreshold = ambientNoiseFloor * sneakMultiplier;
    const intrusionThreshold = ambientNoiseFloor * intrusionMultiplier;

    let targetState = 'SECURE';

    if (rawRms >= intrusionThreshold) {
      targetState = 'INTRUSION';
      if (now - lastIntrusionTriggerRef.current > 2500) {
        const peakDb = (20 * Math.log10(rawRms)).toFixed(1);
        setSecurityEvents(prev => [
          {
            id: String(Date.now()),
            timestamp: new Date().toLocaleTimeString(),
            type: 'intrusion',
            details: `🔴 INTRUSION DETECTED! Spike level: ${peakDb} dB`
          },
          ...prev
        ]);
        lastIntrusionTriggerRef.current = now;
        playAlarmBeep();
      }
    } else if (rawRms >= sneakThreshold) {
      targetState = 'SNEAK';
      if (now - lastSneakTriggerRef.current > 2000 && now - lastIntrusionTriggerRef.current > 1500) {
        const peakDb = (20 * Math.log10(rawRms)).toFixed(1);
        setSecurityEvents(prev => [
          {
            id: String(Date.now()),
            timestamp: new Date().toLocaleTimeString(),
            type: 'sneak',
            details: `🟡 SNEAK DETECTION: Quiet movement/rustle at ${peakDb} dB`
          },
          ...prev
        ]);
        lastSneakTriggerRef.current = now;
      }
    }

    if (targetState === 'INTRUSION') {
      setSecurityAlertState('INTRUSION');
    } else if (targetState === 'SNEAK') {
      if (securityAlertState !== 'INTRUSION' || now - lastIntrusionTriggerRef.current > 1200) {
        setSecurityAlertState('SNEAK');
      }
    } else {
      if (now - lastIntrusionTriggerRef.current > 1500 && now - lastSneakTriggerRef.current > 1200) {
        setSecurityAlertState('SECURE');
      }
    }
  }, [diagnostics.rawRms, vocalProfile, connectionState, isCalibrating, securitySensitivity, ambientNoiseFloor]);

  // Auto-detect WebSocket URL on mount with URL Query Param support for zero-click live sharing!
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryRelay = params.get('relay');
    const queryRoom = params.get('room');

    const activeRoom = queryRoom || 'demo-room';
    if (queryRoom) {
      setRoom(queryRoom);
    }

    if (queryRelay) {
      const cleanRelay = queryRelay.replace(/^(ws|wss):\/\//, '');
      const protocol = cleanRelay.includes('localhost:') ? 'ws:' : 'wss:';
      setRelayHost(`${protocol}//${cleanRelay}/stream`);
    } else {
      const isHttps = window.location.protocol === 'https:';
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.match(/^\d+\.\d+\.\d+\.\d+$/);
      
      if (!isLocal) {
        // PRODUCTION LIVE VERSION: Use ntfy.sh Service Discovery to find the dynamic Cloudflare Tunnel!
        console.log(`Sourcery Receiver: Looking up tunnel for room ${activeRoom}...`);
        fetch(`https://ntfy.sh/${activeRoom}/json?poll=1`)
          .then(res => res.text())
          .then(text => {
            const lines = text.trim().split('\n');
            const lastLine = lines[lines.length - 1];
            if (lastLine) {
              const data = JSON.parse(lastLine);
              if (data && data.message && data.message.startsWith('wss://')) {
                console.log(`Sourcery Receiver: Service Discovery found tunnel: ${data.message}`);
                setRelayHost(data.message);
              } else {
                console.warn('Invalid service discovery payload:', data);
              }
            }
          })
          .catch(err => {
            console.error('Service Discovery failed:', err);
          });
      } else {
        const protocol = isHttps ? 'wss:' : 'ws:';
        const host = window.location.host.includes('localhost:') ? 'localhost:5173' : window.location.host;
        setRelayHost(`${protocol}//${host}/stream`);
      }
    }
  }, []);

  // Load RNNoise model on mount
  useEffect(() => {
    let active = true;
    async function loadModel() {
      try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        
        console.log('Sourcery AI: Initializing RNNoise neural network...');
        
        const rnnoise = await Rnnoise.load();
        
        if (active) {
          denoiseStateRef.current = rnnoise.createDenoiseState();
          setRnnoiseLoaded(true);
          setAiAutoLogs(prev => [...prev, 'AI: Neural background removal model loaded.']);
          console.log('Sourcery AI: RNNoise neural background suppression loaded successfully.');
        }
      } catch (err) {
        console.error('Sourcery AI: Failed to load RNNoise:', err);
        if (active) {
          setAiAutoLogs(prev => [...prev, 'AI Warning: Neural noise model failed: ' + err.message]);
        }
      }
    }
    loadModel();
    return () => {
      active = false;
    };
  }, []);

  // Sync vocal profiles with manual settings on profile selection
  useEffect(() => {
    if (aiAutoPilot && connectionState === CONNECTION_STATES.STREAMING) return;

    switch (vocalProfile) {
      case 'BYPASS':
        setGateEnabled(false);
        setVocalRecoveryEnabled(false);
        setCompressorEnabled(false);
        setClarityEqEnabled(false);
        setWindCutEnabled(false);
        break;
      case 'STUDIO':
        setGateEnabled(true);
        setGateThreshold(0.004);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(3.0);
        setCompressorEnabled(true);
        setClarityEqEnabled(true);
        setWindCutEnabled(true);
        break;
      case 'WHISPER':
        setGateEnabled(true);
        setGateThreshold(0.003);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(8.0);
        setCompressorEnabled(true);
        setClarityEqEnabled(true);
        setWindCutEnabled(true);
        break;
      case 'TUNNEL':
        setGateEnabled(true);
        setGateThreshold(0.008);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(5.0);
        setCompressorEnabled(true);
        setClarityEqEnabled(true);
        setWindCutEnabled(true);
        break;
      case 'EXTREME':
        setGateEnabled(true);
        setGateThreshold(0.005);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(12.0);
        setCompressorEnabled(true);
        setClarityEqEnabled(true);
        setWindCutEnabled(true);
        break;
      case 'SECURITY':
        setGateEnabled(true);
        setGateThreshold(0.002);
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(16.0); // Extremely sensitive +24dB boost limit!
        setCompressorEnabled(true);
        setClarityEqEnabled(true);
        setWindCutEnabled(true);
        setAiDecipherActive(true); // Automatically engage speech decipherer (Whisper) to transcribe whispering intruders!
        break;
      default:
        break;
    }
  }, [vocalProfile, aiAutoPilot]);

  // *** BUG FIX: Keep micTypeRef in sync whenever micType state changes ***
  useEffect(() => {
    micTypeRef.current = micType;
  }, [micType]);

  // Synchronize Microphone hardware presets on manual selection
  useEffect(() => {
    if (micCalibrationMode === 'AUTO') return;

    let logMsg = '';
    switch (micType) {
      case 'BUILTIN':
        setGateEnabled(true);
        setGateThreshold(0.006); // tuned for MacBook Pro 2023 studio mic array
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(6.0); // +15.5dB dynamic boost for whispers
        setPreampGainDb(6.0); // +6dB preamp boost to raise level
        setWindCutEnabled(true);
        setClarityEqEnabled(true);
        setRnnoiseEnabled(true);
        logMsg = 'Mic Profile: Applied MacBook Pro 2023 Studio Mic preset. Cut desk rumble (120Hz), gate threshold 0.006, +6dB preamp gain, active RNNoise.';
        break;
      case 'CONDENSER':
        setGateEnabled(true);
        setGateThreshold(0.0025); // -52dB
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(3.0); // +9.5dB
        setPreampGainDb(-2.0); // slight attenuation to prevent hot signals from clipping
        setWindCutEnabled(true);
        setClarityEqEnabled(true);
        setRnnoiseEnabled(true);
        logMsg = 'Mic Profile: Applied standard STUDIO CONDENSER preset. Attenuated hot signal (-2dB), mild noise gate.';
        break;
      case 'DYNAMIC':
        setGateEnabled(true);
        setGateThreshold(0.0008); // -62dB
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(8.0); // +18dB dynamic recovery
        setPreampGainDb(18.0); // massive broadcast preamp gain boost!
        setWindCutEnabled(true);
        setClarityEqEnabled(true);
        setRnnoiseEnabled(false); // SM7B typically doesn't need aggressive RNNoise in standard setups
        logMsg = 'Mic Profile: Applied standard DYNAMIC BROADCAST preset. Massive pre-amp gain boost (+18dB), ultra-low gate.';
        break;
      case 'LAVALIER':
        setGateEnabled(true);
        setGateThreshold(0.005); // -46dB
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(4.5); // +13dB
        setPreampGainDb(4.0); // moderate lav boost
        setWindCutEnabled(true);
        setClarityEqEnabled(true);
        setRnnoiseEnabled(true);
        logMsg = 'Mic Profile: Applied standard LAVALIER / HEADSET preset. High wind cut, clothes rustle gate.';
        break;
      default:
        break;
    }

    if (logMsg) {
      setMicCalibrationLogs(prev => {
        const next = [...prev, logMsg];
        if (next.length > 5) next.shift();
        return next;
      });
    }
  }, [micType, micCalibrationMode]);

  // Apply manual audio node parameters on settings change in real-time
  // *** BUG FIX: micType added to deps so HPF frequency updates immediately on mic change ***
  useEffect(() => {
    updateDspGraph();
  }, [gateEnabled, gateThreshold, vocalRecoveryEnabled, vocalRecoveryMaxGain, compressorEnabled, clarityEqEnabled, windCutEnabled, vocalProfile, preampGainDb, micType]);

  // Closed-Loop AI Auto-Pilot control logic triggered by real-time audio telemetry
  useEffect(() => {
    if (!aiAutoPilot || connectionState !== CONNECTION_STATES.STREAMING) return;

    const now = Date.now();
    if (now - lastAiLogTimeRef.current < 1200) return;

    const rawRms = diagnostics.rawRms;
    let logMessage = '';

    if (rawRms < 0.0008) {
      if (!gateEnabled || gateThreshold !== 0.006) {
        setGateEnabled(true);
        setGateThreshold(0.006);
        logMessage = 'AI: Silence detected. Locked Noise Gate at -44dB to block background static.';
      }
    } else if (rawRms > 0.0008 && rawRms < 0.012) {
      if (!vocalRecoveryEnabled || vocalRecoveryMaxGain < 8.0 || gateThreshold > 0.0035) {
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(10.0); 
        setGateEnabled(true);
        setGateThreshold(0.003);       
        setClarityEqEnabled(true);      
        setCompressorEnabled(true);
        logMessage = 'AI: Faint speech / Whisper detected. Enabled Upward AGC (+20dB recovery boost) and optimized Speech Clarity EQs.';
      }
    } else if (rawRms >= 0.012 && rawRms < 0.06) {
      if (vocalRecoveryMaxGain > 4.0 || gateThreshold < 0.004) {
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(3.5); 
        setGateEnabled(true);
        setGateThreshold(0.0045);
        setCompressorEnabled(true);
        logMessage = 'AI: Clear speech detected. Normalizing levels to clean studio parameters.';
      }
    } else if (rawRms >= 0.06) {
      if (vocalRecoveryMaxGain > 1.5 || !compressorEnabled) {
        setVocalRecoveryEnabled(true);
        setVocalRecoveryMaxGain(1.5);
        setCompressorEnabled(true);
        logMessage = 'AI: High-level voice spike. Studio Compressor engaged aggressively to protect listener hearing.';
      }
    }

    if (logMessage) {
      setAiAutoLogs(prev => {
        const next = [...prev, logMessage];
        if (next.length > 5) next.shift();
        return next;
      });
      lastAiLogTimeRef.current = now;
    }
  }, [diagnostics.rawRms, diagnostics.isGated, aiAutoPilot, connectionState]);

  // AI Speech Decipherer (Web Worker Binder)
  useEffect(() => {
    if (!aiDecipherActive) {
      if (whisperWorkerRef.current) {
        // Post clear message to wipe buffers
        whisperWorkerRef.current.postMessage({ type: 'clear' });
      }
      setAiTranscript('');
      return;
    }

    // Instantiation of Whisper Web Worker
    if (!whisperWorkerRef.current) {
      try {
        const worker = new Worker(new URL('./audio/whisper.worker.js', import.meta.url), { type: 'module' });
        whisperWorkerRef.current = worker;

        worker.onmessage = (event) => {
          const data = event.data;
          
          if (data.type === 'status') {
            setAiAutoLogs(prev => [...prev, data.message]);
          } else if (data.type === 'progress') {
            // Live file download progress log renderer
            setAiAutoLogs(prev => {
              const lastLog = prev[prev.length - 1];
              const newLog = `AI: Fetching ${data.file}... [${data.progress}%]`;
              
              if (lastLog && lastLog.startsWith(`AI: Fetching ${data.file}`)) {
                const next = [...prev];
                next[next.length - 1] = newLog;
                return next;
              } else {
                return [...prev, newLog];
              }
            });
          } else if (data.type === 'ready') {
            isWhisperReadyRef.current = true;
          } else if (data.type === 'transcript') {
            // Append incoming deciphered text log
            setAiTranscript(data.text);
          }
        };
      } catch (err) {
        setAiAutoLogs(prev => [...prev, 'AI Warning: Could not instantiate local speech decipherer worker: ' + err.message]);
        setAiDecipherActive(false);
      }
    } else {
      // Re-enable in-memory model
      isWhisperReadyRef.current = true;
      setAiAutoLogs(prev => [...prev, 'AI: Local Whisper Speech Decipherer activated.']);
    }

    return () => {
      // We keep worker loaded in memory to prevent reloading 75MB weights on toggle
      isWhisperReadyRef.current = false;
    };
  }, [aiDecipherActive, connectionState]);

  const updateDspGraph = () => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;

    // *** BUG FIX: read from ref (always current) instead of closure-captured state ***
    const currentMicType = micTypeRef.current;
    let hpFreq = 80;
    if (vocalProfile === 'TUNNEL' || vocalProfile === 'EXTREME') {
      hpFreq = 180;
    } else {
      if (currentMicType === 'BUILTIN') hpFreq = 120;
      else if (currentMicType === 'CONDENSER') hpFreq = 75;
      else if (currentMicType === 'DYNAMIC') hpFreq = 50;
      else hpFreq = 150; // default / lavalier
    }
    
    if (highPass1Ref.current && highPass2Ref.current) {
      if (windCutEnabled) {
        highPass1Ref.current.frequency.setValueAtTime(hpFreq, now);
        highPass1Ref.current.Q.setValueAtTime(0.707, now);
        highPass2Ref.current.frequency.setValueAtTime(hpFreq, now);
        highPass2Ref.current.Q.setValueAtTime(0.707, now);
      } else {
        highPass1Ref.current.frequency.setValueAtTime(10, now);
        highPass2Ref.current.frequency.setValueAtTime(10, now);
      }
    }

    if (eqSpeechRef.current && eqWhisperRef.current) {
      if (clarityEqEnabled) {
        const speechGain = vocalProfile === 'EXTREME' ? 12 : (vocalProfile === 'WHISPER' ? 9 : 4);
        const whisperGain = vocalProfile === 'EXTREME' ? 9 : (vocalProfile === 'WHISPER' ? 8 : 2);
        
        eqSpeechRef.current.gain.setValueAtTime(speechGain, now);
        eqWhisperRef.current.gain.setValueAtTime(whisperGain, now);
      } else {
        eqSpeechRef.current.gain.setValueAtTime(0, now);
        eqWhisperRef.current.gain.setValueAtTime(0, now);
      }
    }

    if (compressorRef.current) {
      if (compressorEnabled) {
        const ratio = (vocalProfile === 'EXTREME' || vocalProfile === 'WHISPER') ? 8.0 : 4.0;
        const threshold = (vocalProfile === 'EXTREME' || vocalProfile === 'WHISPER') ? -32 : -22;
        
        compressorRef.current.threshold.setValueAtTime(threshold, now);
        compressorRef.current.ratio.setValueAtTime(ratio, now);
        compressorRef.current.knee.setValueAtTime(24, now);
        compressorRef.current.attack.setValueAtTime(0.008, now);
        compressorRef.current.release.setValueAtTime(0.200, now);
      } else {
        compressorRef.current.threshold.setValueAtTime(0, now);
        compressorRef.current.ratio.setValueAtTime(1.0, now);
      }
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'control',
        gateEnabled: gateEnabled,
        gateThreshold: gateThreshold,
        vocalRecoveryEnabled: vocalRecoveryEnabled,
        vocalRecoveryMaxGain: vocalRecoveryMaxGain,
        preampGain: Math.pow(10, preampGainDb / 20)
      });
    }
  };

  // High-performance 16kHz linear downsampler
  const resampleTo16k = (audioBuffer, originalSampleRate) => {
    if (originalSampleRate === 16000) return audioBuffer;
    const ratio = originalSampleRate / 16000;
    const newLength = Math.round(audioBuffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      result[i] = audioBuffer[Math.round(i * ratio)];
    }
    return result;
  };

  // General linear resampler to bridge native stream and browser hardware rates
  const resampleBuffer = (audioBuffer, fromRate, toRate) => {
    if (fromRate === toRate) return audioBuffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(audioBuffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      result[i] = audioBuffer[Math.round(i * ratio)];
    }
    return result;
  };

  // Canvas visualizer loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let phase = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      const height = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      
      const logicWidth = canvas.offsetWidth;
      const logicHeight = canvas.offsetHeight;

      const rms = diagnostics.volumeRms;
      const amp = diagnostics.streamActive ? Math.min(rms * 160, logicHeight / 2 - 10) : 2;

      if (diagnostics.streamActive) {
        const glowGrad = ctx.createRadialGradient(
          logicWidth / 2, logicHeight / 2, 5,
          logicWidth / 2, logicHeight / 2, 160
        );
        const glowHue = diagnostics.appliedGain > 1.5 ? 320 : 185; 
        const glowIntensity = Math.min(rms * 0.5, 0.2);
        glowGrad.addColorStop(0, `hsla(${glowHue}, 85%, 65%, ${glowIntensity})`);
        glowGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = glowGrad;
        ctx.fillRect(0, 0, logicWidth, logicHeight);
      }

      ctx.strokeStyle = diagnostics.streamActive 
        ? (diagnostics.appliedGain > 1.5 ? 'hsl(320, 85%, 60%)' : 'hsl(185, 90%, 50%)') 
        : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();

      const centerY = logicHeight / 2;
      
      for (let x = 0; x < logicWidth; x++) {
        const angle = (x / logicWidth) * Math.PI * 2.8 + phase;
        const envelope = Math.sin((x / logicWidth) * Math.PI);
        const y = centerY + Math.sin(angle) * amp * envelope;
        
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (diagnostics.streamActive) {
        ctx.strokeStyle = diagnostics.appliedGain > 1.5 ? 'rgba(185, 90%, 50%, 0.4)' : 'rgba(236, 72, 153, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x < logicWidth; x++) {
          const angle = (x / logicWidth) * Math.PI * 3.8 - phase * 1.3;
          const envelope = Math.sin((x / logicWidth) * Math.PI);
          const y = centerY + Math.cos(angle) * (amp * 0.6) * envelope;
          
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      phase += diagnostics.streamActive ? 0.07 + rms * 0.25 : 0.015;
      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [diagnostics.volumeRms, diagnostics.streamActive, diagnostics.appliedGain]);

  const initAudio = async () => {
    // Attempt to set audio session category to playback to bypass physical mute switch on iOS
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'playback';
        console.log('Sourcery Audio: Set audio session to playback mode (bypasses silent switch).');
      } catch (err) {
        console.warn('Could not set audio session category:', err);
      }
    }

    // Play a silent audio node to "kick" iOS Webkit audio category transition
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=');
      silentAudio.volume = 0.05;
      await silentAudio.play();
      console.log('Sourcery Audio: Silent audio session kick successful.');
    } catch (err) {
      console.warn('Sourcery Audio: Silent audio session kick failed:', err);
    }

    let ctx = audioContextRef.current;
    
    if (!ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioContext(); // Let browser choose default native hardware rate
      audioContextRef.current = ctx;
    } else {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (workletNodeRef.current) {
        setDiagnostics(prev => ({ ...prev, hardwareSampleRate: ctx.sampleRate }));
        return;
      }
    }

    setDiagnostics(prev => ({ ...prev, hardwareSampleRate: ctx.sampleRate }));

    await ctx.audioWorklet.addModule(workletUrl);
    const workletNode = new AudioWorkletNode(ctx, 'audio-stream-processor');
    workletNodeRef.current = workletNode;

    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass';
    const hp2 = ctx.createBiquadFilter();
    hp2.type = 'highpass';

    const eqSpeech = ctx.createBiquadFilter();
    eqSpeech.type = 'peaking';
    eqSpeech.frequency.value = 3200; 
    eqSpeech.Q.value = 1.0;
    
    const eqWhisper = ctx.createBiquadFilter();
    eqWhisper.type = 'peaking';
    eqWhisper.frequency.value = 6000; 
    eqWhisper.Q.value = 1.2;

    const comp = ctx.createDynamicsCompressor();

    highPass1Ref.current = hp1;
    highPass2Ref.current = hp2;
    eqSpeechRef.current = eqSpeech;
    eqWhisperRef.current = eqWhisper;
    compressorRef.current = comp;

    workletNode.connect(hp1);
    hp1.connect(hp2);
    hp2.connect(eqSpeech);
    eqSpeech.connect(eqWhisper);
    eqWhisper.connect(comp);
    comp.connect(ctx.destination);

    updateDspGraph();

    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'volume') {
        setDiagnostics(prev => ({
          ...prev,
          volumeRms: msg.rms,
          rawRms: msg.rawRms,
          bufferSamples: msg.bufferSize,
          appliedGain: msg.appliedGain,
          isGated: msg.isGated,
          streamActive: msg.rms > 0.001
        }));
      } else if (msg.type === 'diagnostic' && msg.event === 'catchup_triggered') {
        setDiagnostics(prev => ({ ...prev, catchups: prev.catchups + 1 }));
      } else if (msg.type === 'status' && msg.event === 'playing') {
        setConnectionState(CONNECTION_STATES.STREAMING);
      } else if (msg.type === 'status' && msg.event === 'underflow') {
        setConnectionState(CONNECTION_STATES.CONNECTED);
        setDiagnostics(prev => ({ ...prev, volumeRms: 0, rawRms: 0, streamActive: false, isGated: false }));
      }
    };
  };

  const handleStart = async () => {
    if (connectionState !== CONNECTION_STATES.DISCONNECTED && connectionState !== CONNECTION_STATES.ERROR) return;

    // PRE-CREATE AUDIOCONTEXT & DSP CHAIN SYNCHRONOUSLY IN USER GESTURE FOR AUTOPLAY BYPASS!
    try {
      console.log('Sourcery Receiver: Pre-initializing audio engine...');
      await initAudio();
      if (workletNodeRef.current) {
        workletNodeRef.current.port.postMessage({ type: 'control', reset: true });
      }
      updateDspGraph();
    } catch (e) {
      console.warn('Could not initialize AudioContext in user gesture:', e);
    }
    
    setConnectionState(CONNECTION_STATES.CONNECTING);
    setDiagnostics({
      packetsReceived: 0,
      bufferSamples: 0,
      volumeRms: 0,
      rawRms: 0,
      appliedGain: 1.0,
      isGated: false,
      catchups: 0,
      streamActive: false,
      hardwareSampleRate: audioContextRef.current ? audioContextRef.current.sampleRate : 44100
    });

    if (!relayHost) {
      console.error("Relay host not set yet!");
      setConnectionState(CONNECTION_STATES.ERROR);
      alert("Service discovery is still locating your MacBook's tunnel. Please make sure the Mac app is running, wait a few seconds, and try again.");
      return;
    }

    try {
      const separator = relayHost.includes('?') ? '&' : '?';
      const socketUrl = `${relayHost}${separator}room=${encodeURIComponent(room)}&role=client`;
      const socket = new WebSocket(socketUrl);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      // Generate a stable client ID for this browser session
      if (!window.__sourceryClientId) {
        window.__sourceryClientId = 'client-' + Math.random().toString(36).slice(2, 10);
      }
      const myClientId = window.__sourceryClientId;

      socket.onopen = () => {
        setConnectionState(CONNECTION_STATES.CONNECTED);

        // Tell the host we joined (triggers lazy mic tap on Mac)
        const announce = () => {
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: 'client_connected', clientId: myClientId }));
          }
        };
        announce();

        // Heartbeat: re-announce every 5s so host keeps the mic tap alive
        if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = setInterval(() => {
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ type: 'client_heartbeat', clientId: myClientId }));
          }
        }, 5000);
      };

      socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          setDiagnostics(prev => ({ ...prev, packetsReceived: prev.packetsReceived + 1 }));
          
          const float32Data = new Float32Array(event.data);
          let processedData = float32Data;

          // Engage RNNoise Neural Background Noise Suppression
          if (rnnoiseEnabled && denoiseStateRef.current) {
            const currentQueue = rnnoiseQueueRef.current;
            const newQueue = new Float32Array(currentQueue.length + float32Data.length);
            newQueue.set(currentQueue, 0);
            newQueue.set(float32Data, currentQueue.length);
            rnnoiseQueueRef.current = newQueue;

            const frameSize = 480;
            const denoisedChunks = [];
            let offset = 0;

            while (rnnoiseQueueRef.current.length - offset >= frameSize) {
              const frameCopy = new Float32Array(rnnoiseQueueRef.current.subarray(offset, offset + frameSize));
              denoiseStateRef.current.processFrame(frameCopy);
              denoisedChunks.push(frameCopy);
              offset += frameSize;
            }

            if (offset > 0) {
              rnnoiseQueueRef.current = rnnoiseQueueRef.current.slice(offset);
            }

            if (denoisedChunks.length > 0) {
              let totalLength = 0;
              for (const chunk of denoisedChunks) totalLength += chunk.length;
              processedData = new Float32Array(totalLength);
              let mergeOffset = 0;
              for (const chunk of denoisedChunks) {
                processedData.set(chunk, mergeOffset);
                mergeOffset += chunk.length;
              }
            } else {
              processedData = null;
            }
          }

          if (processedData) {
            const fromRate = streamSampleRateRef.current || 44100;
            const toRate = audioContextRef.current ? audioContextRef.current.sampleRate : 44100;
            if (fromRate !== toRate) processedData = resampleBuffer(processedData, fromRate, toRate);
            if (isRecordingRef.current) recordedChunksRef.current.push(processedData);
            if (aiDecipherActive && whisperWorkerRef.current && isWhisperReadyRef.current) {
              const resampled = resampleTo16k(processedData, diagnostics.hardwareSampleRate);
              whisperWorkerRef.current.postMessage({ type: 'audio', data: resampled });
            }
            if (workletNodeRef.current) workletNodeRef.current.port.postMessage(processedData);
          }
        } else {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'config' && data.sampleRate) {
              console.log(`Received Native Hardware Sample Rate: ${data.sampleRate} Hz`);
              streamSampleRateRef.current = data.sampleRate;
              setDiagnostics(prev => ({ ...prev, nativeStreamSampleRate: data.sampleRate }));
            } else if (data.type === 'status' && data.event === 'stream_stopped') {
              setConnectionState(CONNECTION_STATES.CONNECTED);
              setDiagnostics(prev => ({ ...prev, volumeRms: 0, rawRms: 0, streamActive: false, isGated: false }));
            } else if (data.type === 'host_announce') {
              // Mac just came online — re-send our client_connected so it starts the mic
              console.log('Sourcery: Host announced. Re-sending client_connected.');
              if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ type: 'client_connected', clientId: myClientId }));
              }
            }
          } catch (e) {}
        }
      };

      socket.onerror = (err) => {
        console.error('Socket error:', err);
        setConnectionState(CONNECTION_STATES.ERROR);
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
      };

      socket.onclose = () => {
        // Notify host that this client left
        // (socket is already closed here, so this is best-effort via beforeunload)
        setConnectionState(CONNECTION_STATES.DISCONNECTED);
        setDiagnostics(prev => ({ ...prev, streamActive: false, volumeRms: 0, rawRms: 0, isGated: false }));
        setAiDecipherActive(false);
        stopRecordingSession(false);
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }
      };

    } catch (err) {
      console.error('E2E init failed:', err);
      setConnectionState(CONNECTION_STATES.ERROR);
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    }
  };

  // NOTE: Auto-connect is intentionally disabled. iOS Safari requires a direct user gesture 
  // to start the Web Audio API AudioContext. Auto-connecting causes the stream to silently 
  // hang in a 'suspended' state on iPhones.


  // Send client_disconnected to host before the tab/window closes
  useEffect(() => {
    const onBeforeUnload = () => {
      const myClientId = window.__sourceryClientId || 'unknown';
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        try { socketRef.current.send(JSON.stringify({ type: 'client_disconnected', clientId: myClientId })); } catch (e) {}
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const handleStop = () => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    // Tell host we're leaving before closing the socket
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const myClientId = window.__sourceryClientId || 'unknown';
      try { socketRef.current.send(JSON.stringify({ type: 'client_disconnected', clientId: myClientId })); } catch (e) {}
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'control', reset: true });
    }
    setConnectionState(CONNECTION_STATES.DISCONNECTED);
    setDiagnostics(prev => ({ ...prev, streamActive: false, volumeRms: 0, rawRms: 0, isGated: false }));
    setAiDecipherActive(false);
    stopRecordingSession(false);
    rnnoiseQueueRef.current = new Float32Array(0);
  };

  // ─── BUILT-IN DIAGNOSTICS & SELF-REPAIR ENGINE ───────────────────────────
  const runDiagnostics = async () => {
    setDiagRunning(true);
    setShowDiagPanel(true);
    const results = [];

    const pass = (label, detail = '') => results.push({ status: 'pass', label, detail });
    const fail = (label, detail = '', repair = null) => results.push({ status: 'fail', label, detail, repair });
    const warn = (label, detail = '', repair = null) => results.push({ status: 'warn', label, detail, repair });

    // ── 1. Relay host configured? ──────────────────────────────────────────
    if (relayHost) {
      pass('Relay Host', relayHost);
    } else {
      fail('Relay Host', 'No relay URL is configured. The share link may be missing ?relay= parameter.', 'relay');
    }

    // ── 2. WebSocket reachability ──────────────────────────────────────────
    if (relayHost) {
      try {
        await new Promise((resolve, reject) => {
          const separator = relayHost.includes('?') ? '&' : '?';
          const testUrl = `${relayHost}${separator}room=__diag_probe__&role=client`;
          const probe = new WebSocket(testUrl);
          const timer = setTimeout(() => { probe.close(); reject(new Error('timeout')); }, 5000);
          probe.onopen  = () => { clearTimeout(timer); probe.close(); resolve(); };
          probe.onerror = () => { clearTimeout(timer); reject(new Error('refused')); };
        });
        pass('WebSocket Connectivity', 'Relay is reachable and accepting connections.');
      } catch (e) {
        fail('WebSocket Connectivity',
          `Cannot reach relay WebSocket: ${e.message}. The Cloudflare tunnel may have expired.`,
          'reconnect');
      }
    } else {
      warn('WebSocket Connectivity', 'Skipped – no relay host configured.');
    }

    // ── 3. AudioContext state ──────────────────────────────────────────────
    const ctx = audioContextRef.current;
    if (ctx) {
      if (ctx.state === 'running') {
        pass('AudioContext', `Running at ${ctx.sampleRate} Hz`);
      } else {
        fail('AudioContext', `State is "${ctx.state}" – autoplay may still be blocked.`, 'reinit-audio');
      }
    } else {
      warn('AudioContext', 'Not yet created. Click "Connect & Listen" first to initialize it.');
    }

    // ── 4. DSP chain nodes attached ────────────────────────────────────────
    const nodesOk = highPass1Ref.current && highPass2Ref.current &&
                    eqSpeechRef.current && eqWhisperRef.current &&
                    compressorRef.current && workletNodeRef.current;
    if (nodesOk) {
      pass('DSP Filter Chain', `HPF1, HPF2, EQ×2, Compressor, Worklet – all connected.`);
    } else {
      const missing = [
        !highPass1Ref.current && 'HPF-1',
        !highPass2Ref.current && 'HPF-2',
        !eqSpeechRef.current  && 'EQ-Speech',
        !eqWhisperRef.current && 'EQ-Whisper',
        !compressorRef.current && 'Compressor',
        !workletNodeRef.current && 'Worklet',
      ].filter(Boolean).join(', ');
      fail('DSP Filter Chain', `Missing nodes: ${missing}. Connect & Listen to rebuild the chain.`, 'reinit-audio');
    }

    // ── 5. Mic type ref vs state coherence ────────────────────────────────
    if (micTypeRef.current === micType) {
      pass('Mic Type Ref Sync', `micTypeRef="${micTypeRef.current}" matches state "${micType}".`);
    } else {
      fail('Mic Type Ref Sync',
        `Mismatch! Ref="${micTypeRef.current}" vs state="${micType}". DSP may use wrong HPF frequency.`,
        'sync-mictype');
    }

    // ── 6. HPF frequency sanity ────────────────────────────────────────────
    if (highPass1Ref.current) {
      const hpVal = highPass1Ref.current.frequency.value;
      const expectedBase = micType === 'BUILTIN' ? 120 : micType === 'CONDENSER' ? 75 : micType === 'DYNAMIC' ? 50 : 150;
      const expected = (vocalProfile === 'TUNNEL' || vocalProfile === 'EXTREME') ? 180 : expectedBase;
      if (Math.abs(hpVal - expected) < 2) {
        pass('High-Pass Filter Freq', `${hpVal.toFixed(0)} Hz (correct for ${micType} / ${vocalProfile})`);
      } else {
        warn('High-Pass Filter Freq',
          `HPF reads ${hpVal.toFixed(0)} Hz but expected ~${expected} Hz for mic="${micType}" profile="${vocalProfile}".`,
          'reapply-dsp');
      }
    } else {
      warn('High-Pass Filter Freq', 'HPF node not yet created.');
    }

    // ── 7. RNNoise loaded ──────────────────────────────────────────────────
    if (!rnnoiseEnabled) {
      warn('RNNoise Neural Suppressor', 'Disabled by current mic profile. Enable manually for better clarity.');
    } else if (denoiseStateRef.current) {
      pass('RNNoise Neural Suppressor', 'Loaded and active.');
    } else {
      fail('RNNoise Neural Suppressor',
        'Enabled in settings but Wasm model not yet loaded. Page may still be initializing or failed silently.', null);
    }

    // ── 8. Worklet node receiving data ────────────────────────────────────
    if (connectionState === CONNECTION_STATES.STREAMING) {
      pass('Live Packet Flow', `${diagnostics.packetsReceived} packets received, ${diagnostics.catchups} catchups.`);
    } else if (connectionState === CONNECTION_STATES.CONNECTED) {
      warn('Live Packet Flow', 'Connected but no stream yet. Host may not be broadcasting.');
    } else {
      warn('Live Packet Flow', `Connection state: ${connectionState}. Not yet streaming.`);
    }

    setDiagResults(results);
    setDiagRunning(false);
  };

  const repairAction = async (action) => {
    if (action === 'relay') {
      // Try to re-parse relay from current URL
      const params = new URLSearchParams(window.location.search);
      const queryRelay = params.get('relay');
      if (queryRelay) {
        const cleanRelay = queryRelay.replace(/^(ws|wss):\/\//, '');
        const protocol = cleanRelay.includes('localhost:') ? 'ws:' : 'wss:';
        setRelayHost(`${protocol}//${cleanRelay}/stream`);
      }
    } else if (action === 'reconnect') {
      handleStop();
      await new Promise(r => setTimeout(r, 500));
      handleStart();
    } else if (action === 'reinit-audio') {
      try { await initAudio(); updateDspGraph(); } catch (e) { console.warn('Reinit failed:', e); }
    } else if (action === 'sync-mictype') {
      micTypeRef.current = micType;
      updateDspGraph();
    } else if (action === 'reapply-dsp') {
      updateDspGraph();
    }
    // Re-run diagnostics after repair
    setTimeout(() => runDiagnostics(), 300);
  };
  // ─────────────────────────────────────────────────────────────────────────

  // SESSION AUDIO RECORDER & EXPORTER
  const startRecordingSession = () => {
    recordedChunksRef.current = [];
    isRecordingRef.current = true;
    setIsRecording(true);
    setAiAutoLogs(prev => [...prev, 'AI: Vocal Session Recording started. Buffering audio...']);
  };

  const stopRecordingSession = (shouldSave = true) => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;
    setIsRecording(false);

    if (!shouldSave || recordedChunksRef.current.length === 0) {
      recordedChunksRef.current = [];
      return;
    }

    setAiAutoLogs(prev => [...prev, 'AI: Session stopped. Compiling CD-quality WAV file...']);
    exportRecordedWav();
  };

  const exportRecordedWav = () => {
    const chunks = recordedChunksRef.current;
    const rate = diagnostics.hardwareSampleRate;
    
    let totalLength = 0;
    for (let i = 0; i < chunks.length; i++) {
      totalLength += chunks[i].length;
    }

    const mergedSamples = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      mergedSamples.set(chunks[i], offset);
      offset += chunks[i].length;
    }

    const wavBuffer = new ArrayBuffer(44 + totalLength * 2);
    const view = new DataView(wavBuffer);

    writeWavString(view, 0, 'RIFF');
    view.setUint32(4, 36 + totalLength * 2, true);
    writeWavString(view, 8, 'WAVE');
    writeWavString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeWavString(view, 36, 'data');
    view.setUint32(40, totalLength * 2, true);

    let fileOffset = 44;
    for (let i = 0; i < mergedSamples.length; i++, fileOffset += 2) {
      let s = Math.max(-1, Math.min(1, mergedSamples[i]));
      view.setInt16(fileOffset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    const blob = new Blob([view], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sourcery-session-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    
    recordedChunksRef.current = [];
    setAiAutoLogs(prev => [...prev, 'AI: WAV compilation success! Session file downloaded.']);
  };

  const writeWavString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  // TRANSCRIPT DOWNLOAD & MANAGEMENT
  const downloadTranscript = () => {
    if (!aiTranscript) return;
    const blob = new Blob([aiTranscript], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sourcery-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setAiAutoLogs(prev => [...prev, 'AI: Transcript log file exported successfully.']);
  };

  const clearTranscript = () => {
    setAiTranscript('');
    if (whisperWorkerRef.current) {
      whisperWorkerRef.current.postMessage({ type: 'clear' });
    }
    setAiAutoLogs(prev => [...prev, 'AI: Transcription terminal cleared.']);
  };

  const getStatusColorClass = () => {
    switch (connectionState) {
      case CONNECTION_STATES.STREAMING: return 'dot-active';
      case CONNECTION_STATES.CONNECTED: return 'dot-warn';
      case CONNECTION_STATES.CONNECTING: return 'dot-warn';
      case CONNECTION_STATES.ERROR: return 'dot-error';
      default: return '';
    }
  };

  const getShareUrl = () => {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // Check if we have a VITE_TUNNEL_URL compiled in
    const tunnelUrl = import.meta.env.VITE_TUNNEL_URL || '';
    
    if (isLocal && tunnelUrl) {
      // Return the gorgeous production-proxy query URL pointing to this specific secure SSH tunnel!
      return `https://sourcery-dbl.pages.dev/?relay=${tunnelUrl}&room=${encodeURIComponent(room)}`;
    }
    
    if (isLocal) {
      return `http://localhost:5173`;
    }
    
    const isPublicTunnel = window.location.hostname.includes('ngrok') || window.location.hostname.includes('tunnel') || window.location.hostname.includes('pinggy');
    if (isPublicTunnel) {
      return `https://sourcery-dbl.pages.dev/?relay=${window.location.host}&room=${encodeURIComponent(room)}`;
    }
    return `https://sourcery-dbl.pages.dev/?room=${encodeURIComponent(room)}`;
  };

  const shareUrl = getShareUrl();
  const isNgrok = window.location.hostname.includes('ngrok') || window.location.hostname.includes('tunnel') || window.location.hostname.includes('pinggy');
  const isSharedListener = new URLSearchParams(window.location.search).has('relay');

  if (isSharedListener && !forceFullSuite) {
    return (
      <>
        {/* Full-screen Tap to listen Overlay */}
        {!hasTappedStart && (
          <div className="tap-overlay" onClick={async () => {
            setHasTappedStart(true);
            await handleStart();
          }}>
            <div className="tap-overlay-icon">🎧</div>
            <h2 className="tap-overlay-title">Sourcery Station</h2>
            <p className="tap-overlay-subtitle">Live Broadcast Room: {room}</p>
            <button className="tap-overlay-button">
              🔊 Tap to Start Listening
            </button>
          </div>
        )}

        <div className="app-card" style={{ maxWidth: '560px' }}>
          <header style={{ textAlign: 'center', marginBottom: '1.5rem', position: 'relative' }}>
            <button 
              onClick={() => setForceFullSuite(true)}
              style={{
                position: 'absolute',
                top: '-0.5rem',
                right: 0,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.85)',
                fontSize: '0.65rem',
                padding: '0.35rem 0.75rem',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '700',
                transition: 'background 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                zIndex: 10
              }}
              onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.15)'}
              onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.05)'}
              title="Unlock full Studio Vocal Board controller"
            >
              🎛️ Unlock Full Suite
            </button>
            <span style={{ fontSize: '0.65rem', fontWeight: 'bold', color: 'hsl(185, 90%, 50%)', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
              📡 Sourcery Live Broadcast
            </span>
            <h1 className="app-title" style={{ marginTop: '0.2rem', marginBottom: '0.1rem', fontSize: '2rem' }}>Live Receiver</h1>
            <p className="app-subtitle" style={{ fontSize: '0.78rem' }}>Listening to station room: <code>{room}</code></p>
          </header>

          {/* Visualizer */}
          <div className="visualizer-wrapper" style={{ height: '140px', marginBottom: '1.5rem' }}>
            <canvas ref={canvasRef} />
            {!diagnostics.streamActive && (
              <div className="visualizer-placeholder">
                <div className="pulse-circle" style={{ 
                  background: connectionState === CONNECTION_STATES.STREAMING ? 'hsl(185, 90%, 50%)' : 'hsl(var(--text-muted))'
                }} />
                <span>
                  {connectionState === CONNECTION_STATES.DISCONNECTED 
                    ? 'Tap below to connect' 
                    : connectionState === CONNECTION_STATES.CONNECTING
                    ? 'Initializing audio link...'
                    : connectionState === CONNECTION_STATES.CONNECTED
                    ? '⏳ Connected — waiting for host to start broadcasting...'
                    : 'Waiting for voice broadcast...'}
                </span>
              </div>
            )}
          </div>

          {/* Connect / Disconnect Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.7rem' }}>
              {connectionState === CONNECTION_STATES.DISCONNECTED || connectionState === CONNECTION_STATES.ERROR ? (
                <button className="btn btn-primary" onClick={handleStart} id="btn-reconnect" style={{ padding: '0.8rem 2rem', flex: 1, borderRadius: '14px' }}>
                  ▶️ Start Listening
                </button>
              ) : (
                <button className="btn btn-success" onClick={handleStop} id="btn-disconnect" style={{ padding: '0.8rem 2rem', flex: 1, borderRadius: '14px' }}>
                  ❌ Stop Listening
                </button>
              )}
              <button
                id="btn-diagnose"
                onClick={runDiagnostics}
                disabled={diagRunning}
                style={{
                  padding: '0.8rem 1.2rem',
                  borderRadius: '14px',
                  background: showDiagPanel ? 'hsl(260, 80%, 50%)' : 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff',
                  cursor: diagRunning ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: '700',
                  whiteSpace: 'nowrap',
                  opacity: diagRunning ? 0.6 : 1,
                  transition: 'all 0.2s'
                }}
              >
                {diagRunning ? '⏳ Testing…' : '🔬 Diagnose'}
              </button>
            </div>

            {/* ── Diagnostics Panel ── */}
            {showDiagPanel && (
              <div style={{
                background: 'rgba(10, 5, 25, 0.9)',
                border: '1px solid rgba(150, 80, 255, 0.3)',
                borderRadius: '14px',
                padding: '1rem',
                fontSize: '0.78rem',
                fontFamily: 'monospace',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
                  <span style={{ fontWeight: '800', fontSize: '0.72rem', letterSpacing: '0.1em', color: 'hsl(260, 80%, 70%)', textTransform: 'uppercase' }}>
                    🔬 System Diagnostics
                  </span>
                  <button onClick={() => setShowDiagPanel(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
                </div>

                {diagRunning && (
                  <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', padding: '1rem' }}>
                    ⏳ Running system checks…
                  </div>
                )}

                {diagResults && diagResults.map((r, i) => {
                  const colors = { pass: 'hsl(145, 70%, 55%)', fail: 'hsl(0, 85%, 65%)', warn: 'hsl(40, 90%, 60%)' };
                  const icons  = { pass: '✅', fail: '❌', warn: '⚠️' };
                  return (
                    <div key={i} style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                      padding: '0.5rem 0.6rem',
                      borderRadius: '8px',
                      marginBottom: '0.35rem',
                      background: r.status === 'fail' ? 'rgba(255,50,50,0.07)' : r.status === 'warn' ? 'rgba(255,190,50,0.06)' : 'rgba(50,255,120,0.05)',
                      borderLeft: `3px solid ${colors[r.status]}`,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: '700', color: colors[r.status] }}>
                          {icons[r.status]} {r.label}
                        </span>
                        {r.repair && (
                          <button
                            onClick={() => repairAction(r.repair)}
                            style={{
                              background: 'hsl(260, 80%, 55%)',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#fff',
                              padding: '0.2rem 0.6rem',
                              fontSize: '0.68rem',
                              fontWeight: '700',
                              cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            🔧 Auto-Repair
                          </button>
                        )}
                      </div>
                      {r.detail && (
                        <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.72rem', lineHeight: '1.4' }}>{r.detail}</span>
                      )}
                    </div>
                  );
                })}

                <div style={{ marginTop: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '0.6rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button onClick={runDiagnostics} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', color: '#fff', padding: '0.3rem 0.8rem', fontSize: '0.72rem', cursor: 'pointer' }}>
                    🔄 Re-run Tests
                  </button>
                  <button onClick={() => repairAction('reconnect')} style={{ background: 'hsl(200, 80%, 40%)', border: 'none', borderRadius: '8px', color: '#fff', padding: '0.3rem 0.8rem', fontSize: '0.72rem', cursor: 'pointer', fontWeight: '700' }}>
                    ↺ Full Reconnect
                  </button>
                </div>
              </div>
            )}
          </div>


          <div className="diagnostics" style={{ margin: '0 0 1.5rem 0', display: 'flex', flexDirection: 'column', background: 'rgba(10, 8, 16, 0.55)', borderColor: 'rgba(270, 85%, 65%, 0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.5rem', marginBottom: '0.8rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.08em', color: 'hsl(270, 85%, 65%)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                📡 AI SPEECH DECIPHERER (LIVE SPEECH-TO-TEXT)
              </span>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                {aiTranscript && (
                  <button onClick={downloadTranscript} title="Download Transcript" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)' }}>📥</button>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                  <input 
                    type="checkbox" 
                    checked={aiDecipherActive} 
                    onChange={(e) => setAiDecipherActive(e.target.checked)} 
                    disabled={connectionState !== CONNECTION_STATES.STREAMING}
                    style={{ width: '14px', height: '14px', cursor: connectionState === CONNECTION_STATES.STREAMING ? 'pointer' : 'not-allowed' }} 
                  />
                  <span style={{ fontSize: '0.75rem', fontWeight: '700', color: aiDecipherActive ? 'hsl(var(--success))' : 'hsl(var(--text-muted))' }}>
                    {aiDecipherActive ? 'ON' : 'OFF'}
                  </span>
                </label>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.2rem', fontFamily: 'monospace', fontSize: '0.78rem', color: 'hsl(var(--text-primary))', overflowY: 'auto', minHeight: '120px', maxHeight: '180px', padding: '0.6rem 0.8rem', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.03)' }}>
              {!aiDecipherActive ? (
                <span style={{ color: 'rgba(255,255,255,0.3)', fontStyle: 'italic', fontSize: '0.72rem' }}>
                  {connectionState !== CONNECTION_STATES.STREAMING ? 'Connect stream to enable live transcription.' : 'Activate switch to load local AI speech transcription model.'}
                </span>
              ) : (
                <div style={{ lineHeight: '1.4' }}>
                  <span>{aiTranscript || 'AI: Loading model... Speak to begin local Whisper transcription.'}</span>
                </div>
              )}
            </div>
          </div>

          {/* Minimal Telemetry HUD */}
          <div className="diagnostics" style={{ margin: 0 }}>
            <div className="diagnostics-title" style={{ fontSize: '0.75rem', letterSpacing: '0.05em' }}>
              📡 Broadcast Reception Telemetry
              <span className="status-indicator">
                <span className={`dot ${getStatusColorClass()}`} />
                {connectionState}
              </span>
            </div>

            <div className="grid-stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
              <div className="stat-item" style={{ padding: '0.5rem 0.75rem' }}>
                <span className="stat-label" style={{ fontSize: '0.6rem' }}>Packets Streamed</span>
                <span className="stat-value" style={{ fontSize: '0.82rem' }}>{diagnostics.packetsReceived.toLocaleString()}</span>
              </div>

              <div className="stat-item" style={{ padding: '0.5rem 0.75rem' }}>
                <span className="stat-label" style={{ fontSize: '0.6rem' }}>Hardware Rate</span>
                <span className="stat-value" style={{ fontSize: '0.82rem' }}>{diagnostics.hardwareSampleRate.toLocaleString()} Hz</span>
              </div>

              <div className="stat-item" style={{ padding: '0.5rem 0.75rem' }}>
                <span className="stat-label" style={{ fontSize: '0.6rem' }}>Dynamic Preamp Boost</span>
                <span className="stat-value" style={{ fontSize: '0.82rem', color: preampGainDb > 0 ? 'hsl(320, 85%, 65%)' : 'inherit' }}>
                  {preampGainDb > 0 ? `+${preampGainDb.toFixed(1)} dB` : 'Unity (0 dB)'}
                </span>
              </div>

              <div className="stat-item" style={{ padding: '0.5rem 0.75rem' }}>
                <span className="stat-label" style={{ fontSize: '0.6rem' }}>Lag Latency</span>
                <span className="stat-value" style={{ fontSize: '0.82rem' }}>
                  {diagnostics.bufferSamples > 0 
                    ? `${Math.round((diagnostics.bufferSamples / diagnostics.hardwareSampleRate) * 1000)} ms` 
                    : '0 ms'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Full-screen Tap to listen Overlay for desktop full suite view */}
      {isSharedListener && !hasTappedStart && (
        <div className="tap-overlay" onClick={async () => {
          setHasTappedStart(true);
          await handleStart();
        }}>
          <div className="tap-overlay-icon">🎧</div>
          <h2 className="tap-overlay-title">Sourcery Studio</h2>
          <p className="tap-overlay-subtitle">Live Control & Broadcast Board</p>
          <button className="tap-overlay-button">
            🔊 Tap to Connect & Listen
          </button>
        </div>
      )}

      <div className="app-card">
      <header style={{ position: 'relative' }}>
        {isSharedListener && (
          <button 
            onClick={() => setForceFullSuite(false)}
            style={{
              position: 'absolute',
              top: '0.2rem',
              right: 0,
              background: 'rgba(185, 90, 50, 0.1)',
              border: '1px solid rgba(185, 90, 50, 0.25)',
              color: 'hsl(185, 90%, 50%)',
              fontSize: '0.65rem',
              padding: '0.35rem 0.75rem',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: '700',
              zIndex: 10
            }}
          >
            🎧 Switch to Receiver View
          </button>
        )}
        <h1 className="app-title">Sourcery</h1>
        <p className="app-subtitle">AI-Assisted Vocal Clarity Suite</p>
      </header>

      {/* Visualizer */}
      <div className="visualizer-wrapper">
        <canvas ref={canvasRef} />
        {!diagnostics.streamActive && (
          <div className="visualizer-placeholder">
            <div className="pulse-circle" style={{ 
              background: connectionState === CONNECTION_STATES.STREAMING ? 'hsl(185, 90%, 50%)' : 'hsl(var(--text-muted))'
            }} />
            <span>
              {connectionState === CONNECTION_STATES.DISCONNECTED 
                ? 'Ready to connect' 
                : connectionState === CONNECTION_STATES.CONNECTING
                ? 'Initializing session...'
                : 'Waiting for Sourcery microphone stream...'}
            </span>
          </div>
        )}
      </div>

      {/* Connection Row */}
      <div className="row-inputs">
        <div className="form-group">
          <label htmlFor="relayUrl">Relay WebSocket URL</label>
          <input 
            id="relayUrl" 
            type="text" 
            value={relayHost}
            onChange={(e) => setRelayHost(e.target.value)}
            disabled={connectionState !== CONNECTION_STATES.DISCONNECTED}
          />
        </div>

        <div className="form-group">
          <label htmlFor="roomCode">Room / Channel ID</label>
          <input 
            id="roomCode" 
            type="text" 
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={connectionState !== CONNECTION_STATES.DISCONNECTED}
          />
        </div>
      </div>

      {/* Expose & Sharing Dashboard */}
      {(() => {
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        return (
          <div className="share-dashboard">
            <div className="share-qr-wrapper">
              <img 
                src={`https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(shareUrl)}`} 
                alt="Scan to Connect"
                style={{ width: '100px', height: '100px', display: 'block' }}
              />
            </div>
            <div className="share-content">
              <h3 style={{ margin: '0 0 0.4rem 0', fontSize: '0.9rem', fontWeight: '800', letterSpacing: '0.05em', color: 'hsl(185, 90%, 50%)' }}>
                {isLocal ? '🎙️ LISTEN LIVE ON ANOTHER COMPUTER / PHONE' : (isNgrok ? '🌐 SHARE SECURE LIVE INTERNET STREAM' : '🌐 SOURCERY LIVE SHARING ENGINE')}
              </h3>
              <p style={{ margin: '0 0 0.6rem 0', fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4' }}>
                {isLocal 
                  ? 'Scan the QR code with your phone camera or enter this address on any computer in the same building (Wi-Fi) to receive the crystal-clear audio stream instantly:'
                  : 'Scan the QR code or share this secure public link. When opened on any device, it will automatically connect and play your live vocals with zero configuration!'
                }
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <code style={{ 
                  fontFamily: 'monospace',
                  fontSize: '0.82rem',
                  fontWeight: 'bold',
                  padding: '0.3rem 0.6rem',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '6px',
                  color: 'white',
                  wordBreak: 'break-all',
                  maxWidth: '100%'
                }}>
                  {shareUrl}
                </code>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(shareUrl);
                    setAiAutoLogs(prev => [...prev, 'AI: Sharing URL copied to clipboard.']);
                  }}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: 'none',
                    color: 'rgba(255,255,255,0.8)',
                    fontSize: '0.75rem',
                    padding: '0.3rem 0.6rem',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontWeight: '600',
                    transition: 'background 0.2s',
                    whiteSpace: 'nowrap'
                  }}
                  onMouseEnter={(e) => e.target.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseLeave={(e) => e.target.style.background = 'rgba(255,255,255,0.05)'}
                >
                  📋 Copy Link
                </button>
              </div>

              {!isLocal && (
                <div style={{ marginTop: '0.8rem', paddingTop: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: '800', color: 'hsl(185, 90%, 50%)', marginBottom: '0.3rem' }}>
                    💻 MAC APP DISPATCH ENDPOINT (LIVE VERSION)
                  </span>
                  <p style={{ margin: '0 0 0.4rem 0', fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)', lineHeight: '1.3' }}>
                    Copy and paste this WebSocket URL directly into your macOS Status Bar App's 'Relay Edge Endpoint' field to stream live to this room:
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                    <code style={{ 
                      fontFamily: 'monospace',
                      fontSize: '0.78rem',
                      fontWeight: 'bold',
                      padding: '0.3rem 0.6rem',
                      background: 'rgba(0,0,0,0.3)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: '6px',
                      color: 'hsl(185, 90%, 50%)',
                      wordBreak: 'break-all',
                      maxWidth: '100%'
                    }}>
                      {`wss://demo.piesocket.com/v3/${room}?api_key=oCdCMcMPQpbvNjUIzqtvF1d2X2okWpDQj4AwARJuAgtjhzKxVEjQU6IdCjwm&notify_self=0`}
                    </code>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(`wss://demo.piesocket.com/v3/${room}?api_key=oCdCMcMPQpbvNjUIzqtvF1d2X2okWpDQj4AwARJuAgtjhzKxVEjQU6IdCjwm&notify_self=0`);
                        setAiAutoLogs(prev => [...prev, 'AI: macOS dispatch URL copied to clipboard.']);
                      }}
                      style={{
                        background: 'rgba(185, 90, 50, 0.1)',
                        border: '1px solid rgba(185, 90, 50, 0.2)',
                        color: 'hsl(185, 90%, 50%)',
                        fontSize: '0.7rem',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: '600'
                      }}
                    >
                      📋 Copy URL
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <div className="action-buttons-row">
        {/* SESSION AUDIO RECORDER CONTROLS */}
        {connectionState === CONNECTION_STATES.STREAMING && (
          <>
            {!isRecording ? (
              <button 
                className="btn btn-primary" 
                onClick={startRecordingSession} 
                style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', padding: '0.8rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444' }} />
                Record Session
              </button>
            ) : (
              <button 
                className="btn btn-success" 
                onClick={() => stopRecordingSession(true)} 
                style={{ background: '#ef4444', color: 'white', padding: '0.8rem 1.5rem', width: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', animation: 'dot-pulse 0.8s infinite alternate' }}
              >
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'white' }} />
                Save Recording
              </button>
            )}
          </>
        )}

        {connectionState === CONNECTION_STATES.DISCONNECTED || connectionState === CONNECTION_STATES.ERROR ? (
          <button className="btn btn-primary" onClick={handleStart} style={{ padding: '0.8rem 2.5rem', width: 'auto' }}>
            ▶️ Start Listening
          </button>
        ) : (
          <button className="btn btn-success" onClick={handleStop} style={{ padding: '0.8rem 2.5rem', width: 'auto' }}>
            ❌ Stop Listening
          </button>
        )}
      </div>

      {/* AI AUTO-PILOT & DECIPHER LOG BOARD */}
      <div className="dashboard-grid-2col">
        
        {/* Left Side: AI Audio Auto-Pilot Control & Logs */}
        <div className="diagnostics" style={{ margin: 0, display: 'flex', flexDirection: 'column', background: 'rgba(10, 8, 16, 0.5)', borderColor: 'rgba(185, 90, 50, 0.12)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.5rem', marginBottom: '0.8rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.08em', color: 'hsl(185, 90%, 50%)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              🧠 AI AUTO-PILOT
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
              <input type="checkbox" checked={aiAutoPilot} onChange={(e) => setAiAutoPilot(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
              <span style={{ fontSize: '0.75rem', fontWeight: '700', color: aiAutoPilot ? 'hsl(var(--success))' : 'hsl(var(--text-muted))' }}>
                {aiAutoPilot ? 'ACTIVE' : 'OFF'}
              </span>
            </label>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.4rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'rgba(255,255,255,0.65)', overflowY: 'auto', maxHeight: '110px', padding: '0.4rem 0.6rem', background: 'rgba(0,0,0,0.25)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.02)' }}>
            {aiAutoLogs.map((log, idx) => (
              <div key={idx} style={{ borderLeft: '2px solid hsla(185, 90%, 50%, 0.3)', paddingLeft: '0.4rem', marginBottom: '0.2rem' }}>
                {log}
              </div>
            ))}
          </div>
        </div>

        {/* Right Side: AI Speech Decipherer (Live Transcription) */}
        <div className="diagnostics" style={{ margin: 0, display: 'flex', flexDirection: 'column', background: 'rgba(10, 8, 16, 0.5)', borderColor: 'rgba(270, 85%, 65%, 0.12)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.5rem', marginBottom: '0.8rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: '800', letterSpacing: '0.08em', color: 'hsl(270, 85%, 65%)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              📡 AI SPEECH DECIPHERER (LOCAL)
            </span>
            
            {/* Transcript Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              {aiTranscript && (
                <>
                  <button onClick={downloadTranscript} title="Download Transcript" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)' }}>📥</button>
                  <button onClick={clearTranscript} title="Clear Transcript" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)' }}>🧹</button>
                </>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', margin: 0 }}>
                <input 
                  type="checkbox" 
                  checked={aiDecipherActive} 
                  onChange={(e) => setAiDecipherActive(e.target.checked)} 
                  disabled={connectionState !== CONNECTION_STATES.STREAMING}
                  style={{ width: '14px', height: '14px', cursor: connectionState === CONNECTION_STATES.STREAMING ? 'pointer' : 'not-allowed' }} 
                />
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: aiDecipherActive ? 'hsl(var(--success))' : 'hsl(var(--text-muted))' }}>
                  {aiDecipherActive ? 'ON' : 'OFF'}
                </span>
              </label>
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.2rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'hsl(var(--text-primary))', overflowY: 'auto', maxHeight: '110px', padding: '0.4rem 0.6rem', background: 'rgba(0,0,0,0.25)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.02)' }}>
            {!aiDecipherActive ? (
              <span style={{ color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
                {connectionState !== CONNECTION_STATES.STREAMING ? 'Connect stream to enable transcription.' : 'Activate switch to load local OpenAI Whisper model.'}
              </span>
            ) : (
              <div>
                <span>{aiTranscript || 'AI: Model ready. Speak to begin local Whisper transcription...'}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MICROPHONE HARDWARE PROFILE & CALIBRATION */}
      <div className="diagnostics" style={{ marginBottom: '2rem', background: 'rgba(10, 8, 16, 0.45)', borderColor: 'rgba(185, 90, 50, 0.15)' }}>
        <div className="diagnostics-title" style={{ color: 'hsl(var(--secondary-glow))', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.6rem', marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🎙️ HARDWARE MICROPHONE STRIP</span>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <span style={{
              background: micCalibrationMode === 'AUTO' ? 'rgba(185, 90, 50, 0.15)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${micCalibrationMode === 'AUTO' ? 'rgba(185, 90, 50, 0.3)' : 'rgba(255,255,255,0.08)'}`,
              color: micCalibrationMode === 'AUTO' ? 'hsl(185, 90%, 50%)' : 'rgba(255,255,255,0.6)',
              padding: '0.15rem 0.5rem',
              borderRadius: '6px',
              fontSize: '0.65rem',
              fontWeight: '800',
              cursor: 'pointer'
            }} onClick={() => setMicCalibrationMode(micCalibrationMode === 'AUTO' ? 'MANUAL' : 'AUTO')}>
              {micCalibrationMode === 'AUTO' ? '⚙️ ACTIVE AUTO-CALIBRATION' : '🛠️ MANUAL PRESETS'}
            </span>
          </div>
        </div>

        {/* Dynamic Preamp Gain Meter Dial & Type Selector */}
        <div className="hardware-grid">
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
            {/* Mic Type Selector */}
            <div className="form-group" style={{ margin: 0 }}>
              <label htmlFor="micTypeSelector" style={{ fontSize: '0.72rem' }}>Hardware Capsule Type</label>
              <select 
                id="micTypeSelector"
                value={micType}
                onChange={(e) => {
                  setMicType(e.target.value);
                  setMicCalibrationMode('MANUAL');
                }}
                disabled={isMicCalibrating}
                style={{ 
                  background: 'rgba(20, 15, 30, 0.7)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                  padding: '0.6rem 0.9rem',
                  fontSize: '0.85rem'
                }}
              >
                <option value="BUILTIN">💻 Built-in Laptop Capsule</option>
                <option value="CONDENSER">🎙️ USB Studio Condenser</option>
                <option value="DYNAMIC">🎚️ Dynamic Broadcast (SM7B/RE20)</option>
                <option value="LAVALIER">🎧 Lavalier / Headset Mic</option>
              </select>
            </div>

            {/* Calibration trigger button for AUTO mode */}
            {micCalibrationMode === 'AUTO' ? (
              <div>
                <label style={{ fontSize: '0.72rem', display: 'block', marginBottom: '0.3rem' }}>Active Auto-Pilot Calibration</label>
                <button
                  onClick={startActiveMicCalibration}
                  disabled={isMicCalibrating || connectionState !== CONNECTION_STATES.STREAMING}
                  className="btn"
                  style={{
                    background: isMicCalibrating ? 'rgba(234, 179, 8, 0.1)' : 'rgba(185, 90, 50, 0.15)',
                    border: isMicCalibrating ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(185, 90, 50, 0.35)',
                    color: isMicCalibrating ? '#eab308' : 'hsl(185, 90%, 50%)',
                    padding: '0.6rem',
                    fontSize: '0.8rem',
                    fontWeight: '800',
                    borderRadius: '10px',
                    cursor: (isMicCalibrating || connectionState !== CONNECTION_STATES.STREAMING) ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isMicCalibrating ? '⏳ SCANNING CAPSULE...' : '🎙️ Run Active Calibration (5s)'}
                </button>
              </div>
            ) : (
              <div>
                <label style={{ fontSize: '0.72rem', display: 'block', marginBottom: '0.3rem' }}>Manual hardware calibration</label>
                <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontStyle: 'italic', display: 'block', lineHeight: '1.3' }}>
                  Acoustic baselines are automatically calibrated. Move slider on the right to manually dial physical analog gain.
                </span>
              </div>
            )}
          </div>

          {/* Emulated Preamp Gain Slider and DB display */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.8rem', background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.03)', borderRadius: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: '800', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Emulated Preamp Gain
              </span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 'bold', color: preampGainDb !== 0 ? 'hsl(320, 85%, 65%)' : 'inherit' }}>
                {preampGainDb > 0 ? '+' : ''}{preampGainDb.toFixed(1)} dB
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.4rem' }}>
              <input 
                type="range"
                min="-12.0"
                max="24.0"
                step="0.5"
                value={preampGainDb}
                onChange={(e) => {
                  setPreampGainDb(parseFloat(e.target.value));
                  setMicCalibrationMode('MANUAL');
                }}
                disabled={isMicCalibrating}
                style={{ flex: 1, height: '4px', cursor: 'pointer', outline: 'none' }}
              />
              <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', minWidth: '35px', textAlign: 'right', fontWeight: 'bold', color: 'rgba(255,255,255,0.6)' }}>
                {Math.pow(10, preampGainDb / 20).toFixed(1)}x
              </span>
            </div>

            {/* Quick calibration indicators */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginTop: '0.4rem', fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '0.4rem' }}>
              <div>
                <span>Low Cut (HPF):</span>
                <span style={{ display: 'block', fontWeight: 'bold', color: 'rgba(255,255,255,0.75)' }}>
                  {windCutEnabled ? ((vocalProfile === 'TUNNEL' || vocalProfile === 'EXTREME') ? '180 Hz' : (micType === 'BUILTIN' ? '120 Hz' : (micType === 'CONDENSER' ? '75 Hz' : (micType === 'DYNAMIC' ? '50 Hz' : '150 Hz')))) : 'Bypassed'}
                </span>
              </div>
              <div>
                <span>RNNoise Node:</span>
                <span style={{ display: 'block', fontWeight: 'bold', color: rnnoiseEnabled ? 'hsl(185, 90%, 50%)' : 'rgba(255,255,255,0.4)' }}>
                  {rnnoiseEnabled ? '🟢 Enabled' : '⚪ Bypassed'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Live Calibration Logs Console */}
        <div>
          <label style={{ fontSize: '0.7.2rem', fontWeight: '800', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.4rem' }}>
            🛰️ Microphone Calibration Console Logs
          </label>
          <div style={{
            height: '75px',
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.04)',
            borderRadius: '8px',
            padding: '0.4rem 0.6rem',
            fontFamily: 'monospace',
            fontSize: '0.7rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.2rem'
          }}>
            {micCalibrationLogs.map((log, idx) => (
              <div key={idx} style={{ 
                borderLeft: '2px solid rgba(185, 90, 50, 0.45)', 
                paddingLeft: '0.4rem',
                color: log.includes('✅') ? '#a7f3d0' : (log.includes('🔍') ? 'hsl(185, 90%, 50%)' : 'rgba(255,255,255,0.65)')
              }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* VOCAL STUDIO MANUAL BOARD CONTROLS */}
      <div className="diagnostics" style={{ marginBottom: '2rem', background: 'rgba(255, 255, 255, 0.015)', borderColor: 'rgba(255, 255, 255, 0.06)' }}>
        <div className="diagnostics-title" style={{ color: 'hsl(var(--secondary-glow))', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0.6rem', marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between' }}>
          <span>🎙️ VOCAL STUDIO MANUAL BOARD</span>
          {aiAutoPilot && (
            <span style={{ fontSize: '0.75rem', color: 'hsl(185, 90%, 50%)', fontWeight: 'bold', animation: 'dot-pulse 1s infinite alternate' }}>
              [AI AUTO-TUNING ACTIVE]
            </span>
          )}
        </div>

        {/* Profile Selector */}
        <div className="form-group" style={{ marginBottom: '1.5rem' }}>
          <label htmlFor="vocalProfile">Acoustic Setup Preset</label>
          <select 
            id="vocalProfile"
            value={vocalProfile}
            onChange={(e) => {
              setVocalProfile(e.target.value);
              setAiAutoPilot(false);
              setAiAutoLogs(prev => [...prev, 'AI: Auto-pilot disengaged due to manual preset override.']);
            }}
            style={{ 
              background: 'rgba(20, 15, 30, 0.8)',
              borderColor: 'rgba(185, 90, 50, 0.25)', 
              color: 'hsl(var(--text-primary))',
              fontWeight: '700'
            }}
          >
            {Object.entries(VOCAL_PROFILES).map(([key, name]) => (
              <option key={key} value={key}>{name}</option>
            ))}
          </select>
        </div>

        {/* Custom Overrides Grid */}
        <div className="overrides-grid">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '10px', padding: '0.6rem 0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={windCutEnabled} onChange={(e) => { setWindCutEnabled(e.target.checked); setAiAutoPilot(false); }} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>Wind Cut (De-Rumble)</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '10px', padding: '0.6rem 0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={clarityEqEnabled} onChange={(e) => { setClarityEqEnabled(e.target.checked); setAiAutoPilot(false); }} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>Vocal Articulation EQ</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '10px', padding: '0.6rem 0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={compressorEnabled} onChange={(e) => { setCompressorEnabled(e.target.checked); setAiAutoPilot(false); }} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: '600' }}>Studio Comp Leveler</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '10px', padding: '0.6rem 0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={vocalRecoveryEnabled} onChange={(e) => { setVocalRecoveryEnabled(e.target.checked); setAiAutoPilot(false); }} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: vocalRecoveryEnabled ? 'hsl(320, 85%, 65%)' : 'inherit' }}>Faint Vocal Recovery (AGC)</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'rgba(10, 8, 16, 0.4)', border: '1px solid rgba(185, 90, 50, 0.12)', borderRadius: '10px', padding: '0.6rem 0.8rem', cursor: 'pointer', gridColumn: 'span 2' }}>
            <input 
              type="checkbox" 
              checked={rnnoiseEnabled} 
              disabled={!rnnoiseLoaded}
              onChange={(e) => setRnnoiseEnabled(e.target.checked)} 
              style={{ width: '16px', height: '16px', cursor: 'pointer' }} 
            />
            <span style={{ fontSize: '0.85rem', fontWeight: '700', color: rnnoiseEnabled ? 'hsl(185, 90%, 50%)' : 'inherit', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              🧠 Neural Noise Suppression {rnnoiseLoaded ? '🟢 Active' : '⏳ Initializing...'}
            </span>
          </label>
        </div>

        {/* Dynamic AGC Gain Limits Selector */}
        {vocalRecoveryEnabled && (
          <div style={{ padding: '1rem', background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.02)', borderRadius: '14px', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'hsl(320, 85%, 65%)' }}>
                AGC Dynamic Recovery Limit
              </span>
              <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 'bold' }}>
                +{ (20 * Math.log10(vocalRecoveryMaxGain)).toFixed(1) } dB Max Boost
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input 
                type="range" 
                min="1.0" 
                max="16.0" 
                step="0.5" 
                value={vocalRecoveryMaxGain} 
                onChange={(e) => { setVocalRecoveryMaxGain(parseFloat(e.target.value)); setAiAutoPilot(false); }}
                style={{ flex: 1, height: '4px', cursor: 'pointer', outline: 'none' }}
              />
              <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', minWidth: '40px', textAlign: 'right', fontWeight: 'bold' }}>
                {vocalRecoveryMaxGain.toFixed(1)}x
              </span>
            </div>
          </div>
        )}

        {/* Noise Gate Controls */}
        <div style={{ padding: '1rem', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.03)', borderRadius: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', margin: 0 }}>
              <input type="checkbox" checked={gateEnabled} onChange={(e) => { setGateEnabled(e.target.checked); setAiAutoPilot(false); }} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
              <span style={{ fontSize: '0.8rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Smart Noise Gate</span>
            </label>
            <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: diagnostics.isGated ? 'hsl(var(--error))' : 'hsl(var(--success))', fontWeight: 'bold' }}>
              {diagnostics.isGated ? '❌ GATED (MUTED)' : '🔊 OPEN (ACTIVE)'}
            </span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <input 
              type="range" 
              min="0.001" 
              max="0.03" 
              step="0.001" 
              value={gateThreshold} 
              onChange={(e) => { setGateThreshold(parseFloat(e.target.value)); setAiAutoPilot(false); }}
              disabled={!gateEnabled}
              style={{ flex: 1, cursor: gateEnabled ? 'pointer' : 'not-allowed', height: '4px', outline: 'none' }}
            />
            <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', minWidth: '70px', textAlign: 'right', fontWeight: 'bold' }}>
              {(20 * Math.log10(gateThreshold)).toFixed(0)} dB
            </span>
          </div>
        </div>
      </div>

      {/* SECURITY HUD PANEL */}
      {vocalProfile === 'SECURITY' && (
        <div className="diagnostics" style={{ 
          marginBottom: '2rem', 
          background: 'rgba(10, 8, 16, 0.55)', 
          borderColor: securityAlertState === 'INTRUSION' 
            ? 'rgba(239, 68, 68, 0.4)' 
            : (securityAlertState === 'SNEAK' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(16, 185, 129, 0.25)'),
          animation: securityAlertState === 'INTRUSION' ? 'threat-pulse 1s infinite alternate' : 'none',
          transition: 'border-color 0.3s, box-shadow 0.3s',
          boxShadow: securityAlertState === 'INTRUSION' 
            ? '0 0 24px rgba(239, 68, 68, 0.25)' 
            : (securityAlertState === 'SNEAK' ? '0 0 16px rgba(234, 179, 8, 0.15)' : 'none')
        }}>
          <div className="diagnostics-title" style={{ 
            color: securityAlertState === 'INTRUSION' 
              ? '#ef4444' 
              : (securityAlertState === 'SNEAK' ? '#eab308' : '#10b981'),
            borderBottom: '1px solid rgba(255,255,255,0.06)', 
            paddingBottom: '0.6rem', 
            marginBottom: '1.25rem', 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'center',
            fontWeight: 'bold',
            letterSpacing: '0.08em'
          }}>
            <span>🔒 SECURITY MONITOR HUD</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span className={`status-pill ${
                securityAlertState === 'INTRUSION' 
                  ? 'threat-active' 
                  : (securityAlertState === 'SNEAK' ? 'threat-warn' : 'threat-secure')
              }`} style={{ padding: '0.2rem 0.6rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                {securityAlertState === 'INTRUSION' 
                  ? '🔴 THREAT DETECTED' 
                  : (securityAlertState === 'SNEAK' ? '🟡 SNEAK DETECTED' : '🟢 SYSTEM SECURE')}
              </span>
            </div>
          </div>

          <div className="security-grid">
            
            {/* Calibration & Sensitivity Control */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', fontWeight: '800', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.4rem' }}>
                  Intrusion Alarm Calibration
                </label>
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                  <button 
                    onClick={startRoomCalibration}
                    disabled={isCalibrating || connectionState !== CONNECTION_STATES.STREAMING}
                    className="btn"
                    style={{
                      flex: 1,
                      background: isCalibrating ? 'rgba(234, 179, 8, 0.1)' : 'rgba(16, 185, 129, 0.12)',
                      border: isCalibrating ? '1px solid rgba(234, 179, 8, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                      color: isCalibrating ? '#eab308' : '#10b981',
                      padding: '0.5rem 0.8rem',
                      fontSize: '0.78rem',
                      fontWeight: 'bold',
                      borderRadius: '8px',
                      cursor: (isCalibrating || connectionState !== CONNECTION_STATES.STREAMING) ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {isCalibrating ? '⏳ Calibrating (3s)...' : '⚙️ Calibrate Room Noise'}
                  </button>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', margin: 0, padding: '0.5rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px' }}>
                    <input 
                      type="checkbox" 
                      checked={isAlarmMuted} 
                      onChange={(e) => setIsAlarmMuted(e.target.checked)} 
                      style={{ cursor: 'pointer', width: '13px', height: '13px' }} 
                    />
                    <span style={{ fontSize: '0.7rem', fontWeight: '700', color: isAlarmMuted ? 'rgba(255,255,255,0.4)' : '#ef4444' }}>
                      🔇 MUTE
                    </span>
                  </label>
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: '800', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Detection Sensitivity
                  </label>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 'bold', color: 'hsl(185, 90%, 50%)' }}>
                    Level {securitySensitivity} / 10
                  </span>
                </div>
                <input 
                  type="range" 
                  min="1" 
                  max="10" 
                  step="1"
                  value={securitySensitivity}
                  onChange={(e) => setSecuritySensitivity(parseInt(e.target.value))}
                  style={{ width: '100%', height: '4px', outline: 'none', cursor: 'pointer' }}
                />
                <span style={{ display: 'block', fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                  Higher levels trigger alarms on quieter shuffling sounds.
                </span>
              </div>
            </div>

            {/* Calibration metrics HUD */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.03)', borderRadius: '12px', padding: '0.8rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: '800', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '0.2rem' }}>
                Acoustic Target HUD
              </span>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>Ambient Floor</span>
                  <span style={{ fontWeight: 'bold' }}>{(20 * Math.log10(ambientNoiseFloor)).toFixed(0)} dB</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>Active Room RMS</span>
                  <span style={{ fontWeight: 'bold', color: diagnostics.rawRms > ambientNoiseFloor * 3 ? '#eab308' : 'inherit' }}>
                    {(20 * Math.log10(diagnostics.rawRms || 0.0001)).toFixed(0)} dB
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>Sneak Threshold</span>
                  <span style={{ fontWeight: 'bold', color: '#eab308' }}>
                    {(20 * Math.log10(ambientNoiseFloor * (6.5 - securitySensitivity * 0.5))).toFixed(0)} dB
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.65rem' }}>Intrusion Limit</span>
                  <span style={{ fontWeight: 'bold', color: '#ef4444' }}>
                    {(20 * Math.log10(ambientNoiseFloor * (13.0 - securitySensitivity * 0.9))).toFixed(0)} dB
                  </span>
                </div>
              </div>

              {/* Threat Level visual bar */}
              <div style={{ marginTop: '0.2rem' }}>
                <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', display: 'block', marginBottom: '0.2rem' }}>Threat Alert Index</span>
                <div style={{ height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, Math.max(5, (diagnostics.rawRms / (ambientNoiseFloor * 10)) * 100))}%`,
                    background: securityAlertState === 'INTRUSION' ? '#ef4444' : (securityAlertState === 'SNEAK' ? '#eab308' : '#10b981'),
                    transition: 'width 0.1s ease-out, background-color 0.2s'
                  }} />
                </div>
              </div>
            </div>
          </div>

          {/* Security Alert Log Terminal */}
          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: '800', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.4rem' }}>
              📜 Real-Time Security Incident Log
            </label>
            <div style={{
              height: '90px',
              overflowY: 'auto',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.04)',
              borderRadius: '8px',
              padding: '0.5rem 0.75rem',
              fontFamily: 'monospace',
              fontSize: '0.72rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem'
            }}>
              {securityEvents.map((evt) => (
                <div key={evt.id} style={{
                  borderLeft: `2px solid ${
                    evt.type === 'intrusion' ? '#ef4444' : (evt.type === 'sneak' ? '#eab308' : (evt.type === 'calibrated' ? '#10b981' : 'rgba(255,255,255,0.2)'))
                  }`,
                  paddingLeft: '0.5rem',
                  color: evt.type === 'intrusion' ? '#fca5a5' : (evt.type === 'sneak' ? '#fef08a' : (evt.type === 'calibrated' ? '#a7f3d0' : 'rgba(255,255,255,0.6)'))
                }}>
                  <span style={{ color: 'rgba(255,255,255,0.35)', marginRight: '0.4rem' }}>[{evt.timestamp}]</span>
                  {evt.details}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Diagnostics HUD */}
      <div className="diagnostics">
        <div className="diagnostics-title">
          Edge Board Telemetry
          <span className="status-indicator">
            <span className={`dot ${getStatusColorClass()}`} />
            {connectionState}
          </span>
        </div>

        <div className="grid-stats">
          <div className="stat-item">
            <span className="stat-label">Packets Streamed</span>
            <span className="stat-value">{diagnostics.packetsReceived.toLocaleString()}</span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Matching Sample Rate</span>
            <span className="stat-value">{diagnostics.hardwareSampleRate.toLocaleString()} Hz</span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Dynamic Vocal AGC Boost</span>
            <span className="stat-value" style={{ color: diagnostics.appliedGain > 1.05 ? 'hsl(320, 85%, 65%)' : 'inherit' }}>
              {diagnostics.appliedGain > 1.05 ? `+${(20 * Math.log10(diagnostics.appliedGain)).toFixed(1)} dB` : 'Unity (0 dB)'}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Signal Level (RMS / Peak)</span>
            <span className="stat-value">
              {diagnostics.streamActive 
                ? `${(20 * Math.log10(diagnostics.volumeRms)).toFixed(1)} dB` 
                : '-∞ dB'}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Buffered Playback Lag</span>
            <span className="stat-value">
              {diagnostics.bufferSamples > 0 
                ? `${Math.round((diagnostics.bufferSamples / diagnostics.hardwareSampleRate) * 1000)} ms` 
                : '0 ms'}
            </span>
          </div>

          <div className="stat-item">
            <span className="stat-label">Buffer Sync Catchups</span>
            <span className="stat-value">{diagnostics.catchups}</span>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
