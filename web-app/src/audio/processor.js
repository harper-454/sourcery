// web-app/src/audio/processor.js

class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Dynamic buffer to store incoming float32 audio samples
    this.buffer = new Float32Array(0);
    
    // Playback buffering configuration
    this.targetLatencySamples = 2048; // ~46ms at 44.1kHz (smooth start buffer)
    this.maxLatencySamples = 16384;   // ~370ms latency clamp
    this.hasStartedPlayback = false;

    // Smart Noise Gate parameters
    this.gateEnabled = false;
    this.gateThreshold = 0.005; // RMS threshold below which we mute (noise gate)
    
    // Universal Faint Vocal Recovery & Upward AGC (Automatic Gain Control) parameters
    this.vocalRecoveryEnabled = false;
    this.vocalRecoveryMaxGain = 6.0; // Configurable max gain sweep (e.g. up to 16x)
    this.currentGain = 1.0;          // Smoothed gain to prevent sudden popping

    // Emulated Preamp Gain (applied before gates, compression, and AGC)
    this.preampGain = 1.0;
    
    // Listen for controls and incoming chunks from the main thread
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg instanceof Float32Array) {
        this.appendData(msg);
      } else if (msg && msg.type === 'control') {
        // Handle incoming DSP parameters in real-time
        if (msg.reset) {
          this.buffer = new Float32Array(0);
          this.hasStartedPlayback = false;
        }
        if (msg.gateEnabled !== undefined) this.gateEnabled = msg.gateEnabled;
        if (msg.gateThreshold !== undefined) this.gateThreshold = msg.gateThreshold;
        if (msg.vocalRecoveryEnabled !== undefined) this.vocalRecoveryEnabled = msg.vocalRecoveryEnabled;
        if (msg.vocalRecoveryMaxGain !== undefined) this.vocalRecoveryMaxGain = msg.vocalRecoveryMaxGain;
        if (msg.preampGain !== undefined) this.preampGain = msg.preampGain;
      }
    };
  }

  appendData(newData) {
    const temp = new Float32Array(this.buffer.length + newData.length);
    temp.set(this.buffer, 0);
    temp.set(newData, this.buffer.length);
    this.buffer = temp;

    // Auto-catchup: Keep the audio 100% real-time
    if (this.buffer.length > this.maxLatencySamples) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.targetLatencySamples);
      this.port.postMessage({ type: 'diagnostic', event: 'catchup_triggered', skipped: this.buffer.length });
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];

    if (!channel) return true;

    const numFrames = channel.length; // Typically 128 samples

    // Buffering guard
    if (!this.hasStartedPlayback) {
      if (this.buffer.length >= this.targetLatencySamples) {
        this.hasStartedPlayback = true;
        this.port.postMessage({ type: 'status', event: 'playing' });
      } else {
        channel.fill(0);
        return true;
      }
    }

    if (this.buffer.length >= numFrames) {
      // 1. Extract raw samples and apply emulated Preamp Gain immediately
      const rawChunk = this.buffer.subarray(0, numFrames);
      const preamplifiedChunk = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        preamplifiedChunk[i] = rawChunk[i] * this.preampGain;
      }
      
      // Calculate active base RMS (volume) of preamplified signal
      let sum = 0;
      for (let i = 0; i < numFrames; i++) {
        sum += preamplifiedChunk[i] * preamplifiedChunk[i];
      }
      const rawRms = Math.sqrt(sum / numFrames);

      // Initialize processed chunk
      const processedChunk = new Float32Array(numFrames);
      processedChunk.set(preamplifiedChunk);

      let targetGain = 1.0;
      let isGated = false;

      // 2. Smart Noise Gate (Pre-compression)
      if (this.gateEnabled && rawRms < this.gateThreshold) {
        targetGain = 0.0;
        isGated = true;
      } 
      // 3. Universal Faint Vocal Recovery & Upward AGC
      else if (this.vocalRecoveryEnabled && rawRms > 0.0005) {
        // Target RMS level for comfortable vocal intelligibility (e.g. ~ -29dB)
        const targetRms = 0.035;
        
        if (rawRms < targetRms) {
          // Quiet, distant, or whispered voice detected: calculate dynamic upward gain
          const idealGain = targetRms / rawRms;
          // Apply gain within the user-defined hardware limits
          targetGain = Math.min(idealGain, this.vocalRecoveryMaxGain);
        } else {
          // Standard/loud speaking level: pass through at unity gain
          targetGain = 1.0;
        }
      }

      // Smooth gain transitions to prevent audio popping (Attack / Release smoothing)
      const smoothingFactor = targetGain > this.currentGain ? 0.15 : 0.03;
      
      for (let i = 0; i < numFrames; i++) {
        this.currentGain += (targetGain - this.currentGain) * smoothingFactor;
        processedChunk[i] *= this.currentGain;
        
        // Prevent digital clipping
        if (processedChunk[i] > 0.98) processedChunk[i] = 0.98;
        if (processedChunk[i] < -0.98) processedChunk[i] = -0.98;
      }

      // Copy processed samples into output hardware
      channel.set(processedChunk);
      
      // Shift remaining samples in buffer
      this.buffer = this.buffer.subarray(numFrames);

      // Report volume levels to main thread (using post-gain RMS for metrics)
      let postSum = 0;
      for (let i = 0; i < numFrames; i++) {
        postSum += processedChunk[i] * processedChunk[i];
      }
      const postRms = Math.sqrt(postSum / numFrames);

      this.port.postMessage({ 
        type: 'volume', 
        rms: postRms, 
        rawRms: rawRms,
        bufferSize: this.buffer.length,
        appliedGain: this.currentGain,
        isGated: isGated
      });

    } else {
      channel.fill(0);
      if (this.hasStartedPlayback) {
        this.hasStartedPlayback = false;
        this.port.postMessage({ type: 'status', event: 'underflow' });
      }
    }

    return true;
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
