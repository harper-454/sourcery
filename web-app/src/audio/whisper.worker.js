// web-app/src/audio/whisper.worker.js
import { pipeline, env } from '@xenova/transformers';

// Configure transformers.js to load models from Hugging Face CDN (cached locally in browser)
env.allowLocalModels = false;

let transcriber = null;
let audioBuffer = new Float32Array(0);
let isProcessing = false;

// Initialize the local Whisper AI model
async function initWhisper() {
  try {
    postMessage({ type: 'status', message: 'AI: Bootstrapping local Whisper-Tiny engine (75MB)...' });
    
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (data) => {
        if (data.status === 'progress') {
          postMessage({ 
            type: 'progress', 
            file: data.file.split('/').pop(), // Short filename
            progress: data.progress.toFixed(0) 
          });
        }
      }
    });

    postMessage({ type: 'status', message: 'AI: Whisper Speech Decipherer fully loaded and active!' });
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'status', message: 'AI Error: Failed to load local Whisper: ' + err.message });
    console.error('Whisper worker init error:', err);
  }
}

// Start loading the model immediately inside the worker thread
initWhisper();

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'audio') {
    const incomingData = msg.data;

    // Concatenate incoming 16kHz float32 samples into our sliding audio buffer
    const temp = new Float32Array(audioBuffer.length + incomingData.length);
    temp.set(audioBuffer, 0);
    temp.set(incomingData, audioBuffer.length);
    audioBuffer = temp;

    // Only run transcription if the model is ready, we are not already processing, 
    // and we have accumulated at least 1.5 seconds of audio (24,000 samples at 16kHz)
    if (transcriber && !isProcessing && audioBuffer.length >= 24000) {
      isProcessing = true;

      try {
        // Keep a sliding window of the last 12 seconds of audio to keep transcription 
        // extremely fast, responsive, and prevent memory bloat.
        const maxSamples = 16000 * 12;
        let activeSlice = audioBuffer;
        if (audioBuffer.length > maxSamples) {
          activeSlice = audioBuffer.subarray(audioBuffer.length - maxSamples);
          audioBuffer = activeSlice; // Slide the buffer
        }

        // Run local ONNX Whisper inference
        const result = await transcriber(activeSlice, {
          chunk_length_s: 30,
          return_timestamps: false,
          force_decimal: true
        });

        if (result && result.text) {
          // Send deciphered text back to the main thread
          postMessage({ type: 'transcript', text: result.text.trim() });
        }
      } catch (err) {
        console.error('Whisper inference error:', err);
      } finally {
        isProcessing = false;
      }
    }
  } else if (msg.type === 'clear') {
    // Clear audio buffer cache
    audioBuffer = new Float32Array(0);
    isProcessing = false;
  }
};
