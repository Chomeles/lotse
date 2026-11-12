// Leiser Tastenton, im Browser erzeugt: ein weiches „Tock“ aus einem reinen Ton,
// dessen Tonhöhe in wenigen Millisekunden abfällt (der Charakter einer Handy-Tastatur).
let ctx;

export function tick() {
  ctx ??= new AudioContext();
  const now = ctx.currentTime;
  // Leicht schwankende Tonhöhe, damit schnelles Tippen nicht maschinell klingt.
  const pitch = 0.96 + Math.random() * 0.08;

  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(880 * pitch, now);
  tone.frequency.exponentialRampToValueAtTime(420 * pitch, now + 0.03);

  // Sehr kurzer Anschlag, dann schnelles Ausklingen: kein Knacken, kein Nachhall.
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.05, now + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

  tone.connect(gain).connect(ctx.destination);
  tone.start(now);
  tone.stop(now + 0.06);
}
