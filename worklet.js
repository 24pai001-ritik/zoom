// Collects 20 ms frames (320 samples at 16 kHz) and posts them to the page.
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const a = ch[0];
    const b = ch[1];
    for (let i = 0; i < a.length; i++) {
      this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
      if (this.n === 320) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
