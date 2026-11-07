// Web Worker: runs the shared analysis core on decoded audio, off the main thread.
import { Analyzer } from './analysis-core.js';

self.onmessage = ({ data }) => {
  const { id, sampleRate, left, right } = data;
  try {
    const an = new Analyzer({ sampleRate, channels: 2 });
    const CHUNK = 65536;
    const buf = new Float32Array(CHUNK * 2);
    for (let i = 0; i < left.length; i += CHUNK) {
      const n = Math.min(CHUNK, left.length - i);
      for (let j = 0; j < n; j++) { buf[2 * j] = left[i + j]; buf[2 * j + 1] = right[i + j]; }
      an.push(n === CHUNK ? buf : buf.subarray(0, n * 2));
    }
    self.postMessage({ id, result: an.finish() });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
