import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Download, Sparkles } from 'lucide-react';

interface CompactAudioPlayerProps {
  src: string;
  durationHint?: number;
  sizeBytes?: number;
  compact?: boolean;
}

function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.round(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatAudioBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const CompactAudioPlayer: React.FC<CompactAudioPlayerProps> = ({
  src,
  durationHint,
  sizeBytes,
  compact = false,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceAttachedRef = useRef(false);
  const clarityGainRef = useRef<BiquadFilterNode | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(durationHint || 0);
  const [hdBoost, setHdBoost] = useState(true);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    if (durationHint && durationHint > 0) {
      setDuration(durationHint);
    }
  }, [src, durationHint]);

  useEffect(() => {
    if (clarityGainRef.current) {
      clarityGainRef.current.gain.value = hdBoost ? 3.5 : 0;
    }
  }, [hdBoost]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        void audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const ensureWebAudioClarityChain = () => {
    const el = audioRef.current;
    if (!el || sourceAttachedRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx: AudioContext = new AudioCtx();
      const source = ctx.createMediaElementSource(el);

      // Remove low-end PSTN line rumble below 85 Hz
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 85;

      // Boost vocal presence around 2.8 kHz for crisp speech clarity
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2800;
      presence.Q.value = 1.1;
      presence.gain.value = hdBoost ? 3.5 : 0;

      // Gentle leveling compressor so soft caller speech is clearly audible
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 18;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.18;

      source.connect(highpass);
      highpass.connect(presence);
      presence.connect(compressor);
      compressor.connect(ctx.destination);

      audioCtxRef.current = ctx;
      clarityGainRef.current = presence;
      sourceAttachedRef.current = true;
    } catch {
      // Fallback seamlessly to native HTML5 audio playback
    }
  };

  const togglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;

    ensureWebAudioClarityChain();
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume().catch(() => {});
    }

    if (el.paused) {
      try {
        await el.play();
        setIsPlaying(true);
      } catch (err) {
        console.error('Audio playback failed:', err);
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const el = audioRef.current;
    const next = parseFloat(e.target.value);
    setCurrentTime(next);
    if (el && Number.isFinite(next)) {
      el.currentTime = next;
    }
  };

  const effectiveDuration = duration > 0 ? duration : durationHint || 0;
  const progressPct =
    effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;
  const sizeLabel = formatAudioBytes(sizeBytes);
  const downloadHref = src.includes('?') ? `${src}&download=1` : `${src}?download=1`;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1.5 bg-slate-950/90 border border-slate-800 rounded-lg ${
        compact ? 'px-2 py-1 w-full max-w-[245px]' : 'px-2.5 py-1.5 w-full'
      }`}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) {
            setDuration(d);
          }
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      <button
        type="button"
        onClick={togglePlay}
        className={`${
          compact ? 'w-5 h-5' : 'w-6 h-6'
        } rounded-md bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center shrink-0 transition-colors cursor-pointer`}
        title={isPlaying ? 'Pause recording' : 'Play recording'}
      >
        {isPlaying ? (
          <Pause className="w-2.5 h-2.5 fill-current" />
        ) : (
          <Play className="w-2.5 h-2.5 fill-current ml-0.5" />
        )}
      </button>

      <div className="flex-1 min-w-[68px] flex flex-col justify-center gap-0.5">
        <input
          type="range"
          min={0}
          max={effectiveDuration > 0 ? effectiveDuration : 1}
          step={0.05}
          value={Math.min(currentTime, effectiveDuration || 1)}
          onChange={handleSeek}
          className="w-full h-1 accent-indigo-500 bg-slate-800 rounded-lg cursor-pointer"
          aria-label="Seek call recording"
          data-progress={Math.round(progressPct)}
        />
        <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 leading-none">
          <span>
            {formatSeconds(currentTime)} / {formatSeconds(effectiveDuration)}
          </span>
          {sizeLabel && <span className="text-emerald-400/90">{sizeLabel}</span>}
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setHdBoost((prev) => !prev);
        }}
        className={`px-1 py-0.5 rounded text-[9px] font-mono font-bold border transition-colors shrink-0 cursor-pointer flex items-center gap-0.5 ${
          hdBoost
            ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
            : 'bg-slate-900 text-slate-500 border-slate-800'
        }`}
        title="Toggle HD Voice Clarity Boost (24kHz wideband vocal enhancer)"
      >
        <Sparkles className="w-2.5 h-2.5" />
        <span>HD</span>
      </button>

      <a
        href={downloadHref}
        download
        onClick={(e) => e.stopPropagation()}
        className="p-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors shrink-0"
        title={`Download compact HD recording${sizeLabel ? ` (${sizeLabel})` : ''}`}
      >
        <Download className="w-3 h-3" />
      </a>
    </div>
  );
};
