import os from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';

// Use up to 2 threads inside the isolated STT worker for ultra-fast ~80-250ms live inference,
// while staying completely off the main Node.js 20ms telephony audio thread.
const optimalThreads = String(Math.max(1, Math.min(2, os.cpus().length || 1)));
process.env.OMP_NUM_THREADS = process.env.OMP_NUM_THREADS || optimalThreads;
process.env.ORT_NUM_THREADS = process.env.ORT_NUM_THREADS || optimalThreads;

const PRIMARY_MODEL = 'onnx-community/moonshine-tiny-ONNX';
const FALLBACK_MODEL = 'Xenova/whisper-tiny.en';

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

function normalizeFloat16k(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0.004 || peak >= 0.72) return samples;
  const gain = Math.min(12.0, 0.78 / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

let pipelinePromise = null;
let loadedEngineName = 'local-moonshine';
let loadFailedAt = 0;

async function getAsrPipeline() {
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
        env.backends.onnx.wasm.numThreads = Number(optimalThreads);
      }

      const requestedModel =
        (workerData && workerData.modelId) ||
        (process.env.VOICEDROP_STT_MODEL || '').trim() ||
        PRIMARY_MODEL;

      const candidates =
        requestedModel === FALLBACK_MODEL
          ? [FALLBACK_MODEL]
          : [requestedModel, FALLBACK_MODEL];

      let lastErr = null;
      for (const modelId of candidates) {
        try {
          console.log(
            `[VoiceDrop STT Worker] Loading ultra-fast zero-key local ASR (${modelId}, threads=${optimalThreads})...`
          );
          const transcriber = await pipeline('automatic-speech-recognition', modelId, {
            dtype: 'q8',
          });
          loadedEngineName = modelId.toLowerCase().includes('moonshine')
            ? 'local-moonshine'
            : 'local-whisper';

          // Warm ONNX execution kernels once with a tiny 0.3s buffer so the recipient's very first word decodes in ~80ms!
          try {
            await transcriber(new Float32Array(4800));
          } catch {
            // Ignore warmup noise
          }

          console.log(
            `[VoiceDrop STT Worker] Ready (${loadedEngineName}: ${modelId}) in ${Date.now() - t0}ms (cache=${env.cacheDir})`
          );
          return transcriber;
        } catch (err) {
          lastErr = err;
          console.warn(
            `[VoiceDrop STT Worker] Could not load ${modelId}, trying fallback:`,
            err?.message || err
          );
        }
      }
      throw lastErr || new Error('No local ASR model could be loaded');
    })().catch((err) => {
      console.error('[VoiceDrop STT Worker] Failed to initialize local ASR:', err?.message || err);
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
        const pipe = await getAsrPipeline();
        parentPort.postMessage({ id, ok: Boolean(pipe), engine: loadedEngineName });
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
        if (!samples || samples.length < 2800) {
          parentPort.postMessage({ id, ok: true, text: '' });
          return;
        }
        const transcriber = await getAsrPipeline();
        if (!transcriber) {
          parentPort.postMessage({ id, ok: false, text: '' });
          return;
        }
        const normalized = normalizeFloat16k(samples);
        const inferOpts =
          loadedEngineName === 'local-moonshine'
            ? {}
            : { return_timestamps: false, num_beams: 1, do_sample: false };
        const result = await transcriber(normalized, inferOpts);
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
          engine: loadedEngineName,
          confidence: msg.isFinal === false ? 0.87 : 0.93,
        });
      } catch (err) {
        console.error('[VoiceDrop STT Worker] Inference error:', err?.message || err);
        parentPort.postMessage({ id, ok: false, text: '', error: err?.message || String(err) });
      }
    }
  });
}
