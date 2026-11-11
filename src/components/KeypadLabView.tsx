import React, { useState, useEffect, useCallback } from 'react';
import {
  Trash2,
  Play,
  FileCode,
} from 'lucide-react';
import { playDtmfTone } from '../utils/audioTones';

interface KeypadLabViewProps {
  soundEnabled: boolean;
}

interface DtmfKeyData {
  digit: string;
  sub: string;
  lowFreq: number;
  highFreq: number;
}

const DTMF_KEYS: DtmfKeyData[] = [
  { digit: '1', sub: '', lowFreq: 697, highFreq: 1209 },
  { digit: '2', sub: 'ABC', lowFreq: 697, highFreq: 1336 },
  { digit: '3', sub: 'DEF', lowFreq: 697, highFreq: 1477 },
  { digit: '4', sub: 'GHI', lowFreq: 770, highFreq: 1209 },
  { digit: '5', sub: 'JKL', lowFreq: 770, highFreq: 1336 },
  { digit: '6', sub: 'MNO', lowFreq: 770, highFreq: 1477 },
  { digit: '7', sub: 'PQRS', lowFreq: 852, highFreq: 1209 },
  { digit: '8', sub: 'TUV', lowFreq: 852, highFreq: 1336 },
  { digit: '9', sub: 'WXYZ', lowFreq: 852, highFreq: 1477 },
  { digit: '*', sub: '', lowFreq: 941, highFreq: 1209 },
  { digit: '0', sub: '+', lowFreq: 941, highFreq: 1336 },
  { digit: '#', sub: '', lowFreq: 941, highFreq: 1477 },
];

export const KeypadLabView: React.FC<KeypadLabViewProps> = ({ soundEnabled }) => {
  const [dialedSequence, setDialedSequence] = useState<string>('1234');
  const [activeKey, setActiveKey] = useState<DtmfKeyData | null>(DTMF_KEYS[0]);
  const [isPlayingSeq, setIsPlayingSeq] = useState(false);

  const handleKeyPress = useCallback(
    (key: DtmfKeyData) => {
      setActiveKey(key);
      setDialedSequence((prev) => (prev.length < 20 ? prev + key.digit : prev));
      if (soundEnabled) {
        playDtmfTone(key.digit, 250);
      }
    },
    [soundEnabled]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Backspace') {
        setDialedSequence((prev) => prev.slice(0, -1));
        return;
      }

      const matched = DTMF_KEYS.find((k) => k.digit === e.key);
      if (matched) {
        e.preventDefault();
        handleKeyPress(matched);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleKeyPress]);

  const playSequence = async () => {
    if (!dialedSequence || isPlayingSeq) return;
    setIsPlayingSeq(true);
    for (let i = 0; i < dialedSequence.length; i++) {
      const char = dialedSequence[i];
      const match = DTMF_KEYS.find((k) => k.digit === char);
      if (match) {
        setActiveKey(match);
        if (soundEnabled) {
          playDtmfTone(char, 180);
        }
      }
      await new Promise((r) => setTimeout(r, 260));
    }
    setIsPlayingSeq(false);
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Intro Header */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm backdrop-blur-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-400"></span>
              <h2 className="text-base font-bold text-white tracking-tight">
                DTMF Dual-Tone Multi-Frequency Lab
              </h2>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Dual-Tone Multi-Frequency (DTMF) signaling mixes two sine waves (one Low Group row frequency and one High Group column frequency) across telephony switches to register digits without human audio interference.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-mono">ITU-T Q.23 Standard</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Interactive Keypad Matrix (5 cols) */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-sm">
          {/* Dialed Display Bar */}
          <div className="mb-4 p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-mono block">Dialed Digits Buffer</span>
              <span className="text-xl font-bold font-mono text-white tracking-widest min-h-[28px] block">
                {dialedSequence || <span className="text-slate-600">_ _ _ _</span>}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={playSequence}
                disabled={isPlayingSeq || !dialedSequence}
                className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors shadow-sm"
                title="Play Audio Sequence"
              >
                <Play className="w-4 h-4 fill-current" />
              </button>
              <button
                type="button"
                onClick={() => setDialedSequence('')}
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title="Clear Sequence"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 4x3 Telephone Dialpad Grid */}
          <div className="grid grid-cols-3 gap-2.5 max-w-xs mx-auto mb-4">
            {DTMF_KEYS.map((k) => {
              const isSelected = activeKey?.digit === k.digit;

              return (
                <button
                  key={k.digit}
                  type="button"
                  onClick={() => handleKeyPress(k)}
                  className={`relative p-3.5 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer active:scale-95 select-none ${
                    isSelected
                      ? 'bg-gradient-to-b from-indigo-500 to-indigo-600 text-white border-indigo-400 shadow-md shadow-indigo-500/30'
                      : 'bg-slate-950 hover:bg-slate-800/80 border-slate-800 text-slate-200'
                  }`}
                >
                  <span className="text-xl font-bold font-mono">{k.digit}</span>
                  <span className="text-[10px] tracking-widest text-slate-400 font-semibold h-3.5">
                    {k.sub || ' '}
                  </span>
                  <span className="text-[9px] font-mono opacity-60 mt-0.5">
                    {k.lowFreq}/{k.highFreq}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="text-center text-[11px] text-slate-500">
            Click keys or use physical keyboard to trigger dual-tone audio synthesis
          </div>
        </div>

        {/* Right: Frequency Breakdown & Twilio Gather Specs (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {/* Active Key Frequency Card */}
          {activeKey && (
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white font-bold font-mono text-xl flex items-center justify-center shadow-md">
                    {activeKey.digit}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      Key [{activeKey.digit}] Frequency Synthesizer
                    </h3>
                    <p className="text-xs text-slate-400">
                      Dual harmonic superposition breakdown
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 text-xs font-mono font-semibold">
                  <span>{activeKey.lowFreq} Hz + {activeKey.highFreq} Hz</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Row Frequency (Low Group)</span>
                  <span className="text-lg font-mono font-bold text-cyan-400">{activeKey.lowFreq} Hz</span>
                  <p className="text-[11px] text-slate-400 mt-1">Oscillator 1 (Sine wave)</p>
                </div>

                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                  <span className="text-[10px] uppercase font-bold text-slate-500 block">Column Frequency (High Group)</span>
                  <span className="text-lg font-mono font-bold text-indigo-400">{activeKey.highFreq} Hz</span>
                  <p className="text-[11px] text-slate-400 mt-1">Oscillator 2 (Sine wave)</p>
                </div>
              </div>

              {/* Graphical representation */}
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-300">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-slate-200">Combined Waveform Formula:</span>
                  <span className="font-mono text-slate-400 text-[11px]">
                    f(t) = sin(2π • {activeKey.lowFreq}t) + sin(2π • {activeKey.highFreq}t)
                  </span>
                </div>
                <div className="h-6 w-full flex items-center gap-0.5 overflow-hidden">
                  {Array.from({ length: 48 }).map((_, i) => {
                    const val = Math.sin((i / 48) * Math.PI * 4) * Math.cos((i / 48) * Math.PI * 8);
                    const height = Math.max(4, Math.abs(val) * 22);
                    return (
                      <span
                        key={i}
                        className="flex-1 bg-indigo-400 rounded-full"
                        style={{ height: `${height}px` }}
                      ></span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Twilio Gather Verb Integration Guide */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <FileCode className="w-4 h-4 text-indigo-400" />
              <h4 className="text-xs font-bold uppercase tracking-wider text-white">
                How Twilio Captures DTMF via TwiML &lt;Gather&gt;
              </h4>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed mb-3">
              When an outbound voice call is placed, Twilio Voice responds with instructions containing the <code className="text-indigo-400 font-mono">&lt;Gather&gt;</code> verb. While the text-to-speech message is being spoken, Twilio’s PSTN gateway continuously listens for Dual-Tone Multi-Frequency audio tones from the recipient’s phone dial pad.
            </p>

            <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-cyan-300 overflow-x-auto leading-relaxed">
{`<Gather input="dtmf speech" numDigits="1" timeout="10" action="/api/twiml/gather">
  <Say voice="Polly.Joanna">
    Please press 1 to confirm, or 2 to reschedule.
  </Say>
</Gather>`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
