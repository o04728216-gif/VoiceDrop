import { parentPort, workerData } from 'node:worker_threads';

// Keep ONNX / OpenMP single-threaded inside the STT worker so it NEVER steals CPU
// from the main Node.js 20ms telephony audio streaming thread.
process.env.OMP_NUM_THREADS = process.env.OMP_NUM_THREADS || '1';
process.env.ORT_NUM_THREADS = process.env.ORT_NUM_THREADS || '1';

const HALLUCINATION_PATTERNS = [
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^(blank[_\s-]?audio|silence|inaudible|unintelligible|music|static|beep|beeping|ringing|applause|laughter|sigh|cough|breathing|no speech)$/i,
  /^(thanks for watching|thank you for watching|please subscribe|subtitles by|amara\.org)\.?$/i,
];

function cleanTranscriptText(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (!text || text.length < 2) return '';
  if (!/[a-z0-9]/i.test(text)) return '';
  for (const rx of HALLUCINATION_PATTERNS) {
    if (rx.test(text)) return '';
  }
  return text;
}

function normalizeFloat16kForWhisper(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  // Boost quiet PSTN/mobile voices up to 12x so -36dBFS callers transcribe clearly
  if (peak <= 0.004 || peak >= 0.72) return samples;
  const gain = Math.min(12.0, 0.78 / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

let pipelinePromise = null;
let loadFailedAt = 0;

async function getWhisperPipeline() {
  if (!pipelinePromise && loadFailedAt && Date.now() - loadFailedAt < 60_000) {
    return null;
  }
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const t0 = Date.now();
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir =
        (workerData && workerData.cacheDir) ||
        (process.env.STT_CACHE_DIR || '').trim() ||
        '/tmp/voicedrop-stt-cache';
      env.allowLocalModels = true;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }
      const modelId =
        (workerData && workerData.modelId) ||
        (process.env.VOICEDROP_STT_MODEL || '').trim() ||
        'Xenova/whisper-tiny.en';
      console.log(`[VoiceDrop STT Worker] Loading built-in zero-key local Whisper (${modelId})...`);
      const transcriber = await pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
      });
      console.log(`[VoiceDrop STT Worker] Ready in ${Date.now() - t0}ms (cache=${env.cacheDir})`);
      return transcriber;
    })().catch((err) => {
      console.error('[VoiceDrop STT Worker] Failed to initialize Whisper:', err?.message || err);
      pipelinePromise = null;
      loadFailedAt = Date.now();
      return null;
    });
  }
  return pipelinePromise;
}

if (parentPort) {
  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { id, type } = msg;

    if (type === 'warm') {
      try {
        const pipe = await getWhisperPipeline();
        parentPort.postMessage({ id, ok: Boolean(pipe) });
      } catch (err) {
        parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (type === 'transcribe') {
      try {
        const samples =
          msg.samples instanceof Float32Array
            ? msg.samples
            : new Float32Array(msg.samples.buffer || msg.samples);
        if (!samples || samples.length < 3800) {
          parentPort.postMessage({ id, ok: true, text: '' });
          return;
        }
        const transcriber = await getWhisperPipeline();
        if (!transcriber) {
          parentPort.postMessage({ id, ok: false, text: '' });
          return;
        }
        const normalized = normalizeFloat16kForWhisper(samples);
        const result = await transcriber(normalized);
        const rawText =
          typeof result === 'string'
            ? result
            : Array.isArray(result)
            ? result.map((r) => r?.text || '').join(' ')
            : String(result?.text || '');
        const cleaned = cleanTranscriptText(rawText);
        parentPort.postMessage({
          id,
          ok: true,
          text: cleaned,
          engine: 'local-whisper',
          confidence: 0.91,
        });
      } catch (err) {
        console.error('[VoiceDrop STT Worker] Inference error:', err?.message || err);
        parentPort.postMessage({ id, ok: false, text: '', error: err?.message || String(err) });
      }
    }
  });
}
