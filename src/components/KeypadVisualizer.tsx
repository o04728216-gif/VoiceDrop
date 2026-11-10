import React from 'react';
import { playDtmfTone } from '../utils/audioTones';

interface KeypadVisualizerProps {
  activeDigit: string | null;
  keypadActions: Record<string, string>;
  soundEnabled: boolean;
  onKeyPress?: (digit: string) => void;
  interactive?: boolean;
}

interface KeyConfig {
  digit: string;
  sub: string;
  freq: string;
}

const KEYS: KeyConfig[] = [
  { digit: '1', sub: '', freq: '697/1209' },
  { digit: '2', sub: 'ABC', freq: '697/1336' },
  { digit: '3', sub: 'DEF', freq: '697/1477' },
  { digit: '4', sub: 'GHI', freq: '770/1209' },
  { digit: '5', sub: 'JKL', freq: '770/1336' },
  { digit: '6', sub: 'MNO', freq: '770/1477' },
  { digit: '7', sub: 'PQRS', freq: '852/1209' },
  { digit: '8', sub: 'TUV', freq: '852/1336' },
  { digit: '9', sub: 'WXYZ', freq: '852/1477' },
  { digit: '*', sub: '', freq: '941/1209' },
  { digit: '0', sub: '+', freq: '941/1336' },
  { digit: '#', sub: '', freq: '941/1477' },
];

export const KeypadVisualizer: React.FC<KeypadVisualizerProps> = ({
  activeDigit,
  keypadActions,
  soundEnabled,
  onKeyPress,
  interactive = true,
}) => {
  const handleKeyClick = (digit: string) => {
    if (soundEnabled) {
      playDtmfTone(digit);
    }
    if (onKeyPress) {
      onKeyPress(digit);
    }
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-sm backdrop-blur-md">
      <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
            DTMF Keypad Matrix
          </h3>
        </div>
        <span className="text-[11px] font-mono text-slate-400">
          Dual-Tone (697–1477 Hz)
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 max-w-xs mx-auto">
        {KEYS.map(({ digit, sub, freq }) => {
          const isPressed = activeDigit === digit;
          const configuredAction = keypadActions[digit];

          return (
            <button
              key={digit}
              type="button"
              onClick={() => handleKeyClick(digit)}
              disabled={!interactive}
              className={`relative rounded-xl p-2.5 flex flex-col items-center justify-between border transition-all duration-150 select-none ${
                isPressed
                  ? 'bg-gradient-to-b from-indigo-500 to-indigo-600 text-white border-indigo-400 shadow-md shadow-indigo-500/40 scale-105 ring-2 ring-indigo-400/50'
                  : configuredAction
                  ? 'bg-slate-800/90 hover:bg-slate-750 border-indigo-500/40 text-slate-100 shadow-sm'
                  : 'bg-slate-950/70 hover:bg-slate-800/80 border-slate-800 text-slate-300'
              } ${interactive ? 'cursor-pointer active:scale-95' : 'cursor-default'}`}
            >
              {/* Frequency and Sub */}
              <div className="w-full flex items-center justify-between px-0.5">
                <span className={`text-[9px] font-mono ${isPressed ? 'text-indigo-200' : 'text-slate-500'}`}>
                  {freq}
                </span>
                <span className={`text-[9px] font-semibold tracking-wider ${isPressed ? 'text-indigo-100' : 'text-slate-400'}`}>
                  {sub}
                </span>
              </div>

              {/* Central Key Digit */}
              <span className={`text-xl font-bold font-mono my-0.5 ${isPressed ? 'text-white' : 'text-slate-100'}`}>
                {digit}
              </span>

              {/* Action Tag if mapped */}
              {configuredAction ? (
                <div
                  className={`w-full text-center text-[9px] px-1 py-0.5 rounded truncate font-medium border ${
                    isPressed
                      ? 'bg-white text-indigo-900 border-white'
                      : 'bg-indigo-950/60 text-indigo-300 border-indigo-800/60'
                  }`}
                  title={configuredAction}
                >
                  {configuredAction}
                </div>
              ) : (
                <div className="h-4"></div>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
        <span>Mapped Key Actions:</span>
        <span className="font-mono text-indigo-400 font-semibold">
          {Object.keys(keypadActions).length} Key{Object.keys(keypadActions).length === 1 ? '' : 's'} Active
        </span>
      </div>
    </div>
  );
};
