"use strict";

// A conservative signal gate, not a speech classifier. Keep any recording with
// a louder window or peak; quiet words remain recoverable through explicit bypass.
const WINDOW_SAMPLES = 320; // 20 ms at the browser's 16 kHz sample rate
const SILENCE_RMS = 0.001; // -60 dBFS
const SILENCE_PEAK = 0.004; // about -48 dBFS
const MAX_CHUNKS = 128;

/**
 * @typedef {object} AudioSignal
 * @property {boolean} silent Every window and peak is below the signal limits.
 * @property {number} samples Number of complete mono PCM samples.
 * @property {number} peak Maximum absolute sample, normalized to full scale.
 * @property {number} maxRms Maximum window RMS, normalized to full scale.
 */

/**
 * Recognize bounded RIFF/WAVE with one PCM format and one data chunk. Unsupported,
 * ambiguous, or malformed containers pass through to the provider, not to a guessed
 * silence result. Ancillary chunks and data-before-fmt are safe to inspect.
 * @param {Buffer} audio
 * @returns {{ offset: number, size: number } | null}
 */
function pcmData(audio) {
  if (audio.length < 44 || audio.toString("latin1", 0, 4) !== "RIFF" ||
      audio.toString("latin1", 8, 12) !== "WAVE" ||
      audio.readUInt32LE(4) !== audio.length - 8) return null;

  let format = false;
  /** @type {{ offset: number, size: number } | null} */
  let data = null;
  let offset = 12;
  let chunks = 0;
  while (offset < audio.length) {
    if (++chunks > MAX_CHUNKS || audio.length - offset < 8) return null;
    const id = audio.toString("latin1", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > audio.length) return null;

    if (id === "fmt ") {
      if (format || size < 16 ||
          audio.readUInt16LE(start) !== 1 || // integer PCM
          audio.readUInt16LE(start + 2) !== 1 || // mono
          audio.readUInt32LE(start + 4) !== 16000 ||
          audio.readUInt32LE(start + 8) !== 32000 ||
          audio.readUInt16LE(start + 12) !== 2 ||
          audio.readUInt16LE(start + 14) !== 16) return null;
      format = true;
    } else if (id === "data") {
      if (data || size % 2 !== 0) return null;
      data = { offset: start, size };
    }
    offset = next;
  }
  return format && data && data.size >= WINDOW_SAMPLES * 2 ? data : null;
}

/**
 * Inspect the whole take without trimming, splitting, or changing its bytes.
 * Use local windows rather than whole-take averages to preserve a short word
 * after a long silence. Null means unknown: the caller keeps normal transcription.
 * @param {Buffer} audio
 * @returns {AudioSignal | null}
 */
function analyzePcmWav(audio) {
  const data = pcmData(audio);
  if (!data) return null;
  const samples = data.size / 2;
  let peak = 0;
  let maxMeanSquare = 0;
  for (let first = 0; first < samples; first += WINDOW_SAMPLES) {
    const end = Math.min(first + WINDOW_SAMPLES, samples);
    let sumSquares = 0;
    for (let index = first; index < end; index += 1) {
      const sample = audio.readInt16LE(data.offset + index * 2);
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
    }
    maxMeanSquare = Math.max(maxMeanSquare, sumSquares / (end - first));
  }
  peak /= 32768;
  const maxRms = Math.sqrt(maxMeanSquare) / 32768;
  return { silent: maxRms <= SILENCE_RMS && peak <= SILENCE_PEAK, samples, peak, maxRms };
}

module.exports = { analyzePcmWav };
