// Sehr leiser Tastenton, im Browser erzeugt: ein paar Millisekunden gefiltertes Rauschen.
let ctx;
let noise;

export function tick() {
  if (!ctx) {
    ctx = new AudioContext();
    const length = Math.floor(ctx.sampleRate * 0.018);
    noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noise.getChannelData(0);
    // Rauschen, das schnell ausklingt.
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  const source = ctx.createBufferSource();
  source.buffer = noise;
  // Leicht schwankende Tonhöhe, damit es nicht wie ein Maschinengewehr klingt.
  source.playbackRate.value = 0.85 + Math.random() * 0.3;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2200;
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.value = 0.035;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start();
}
