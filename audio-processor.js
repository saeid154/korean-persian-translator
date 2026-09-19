// Runs on the real-time audio thread. Keeps this minimal: batch raw PCM
// samples into ~128ms chunks and hand them to the main thread, where the
// actual voice-activity detection and buffering logic lives.
class PCMBatcher extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._length = 0;
    this._chunkSize = 2048; // ~128ms at 16kHz
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this._chunks.push(channel.slice());
      this._length += channel.length;
      if (this._length >= this._chunkSize) {
        const merged = new Float32Array(this._length);
        let offset = 0;
        for (const chunk of this._chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.port.postMessage(merged, [merged.buffer]);
        this._chunks = [];
        this._length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-batcher', PCMBatcher);
