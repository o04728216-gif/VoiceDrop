import React from 'react';
import {
  X,
  History,
  PhoneCall,
  Clock,
  ArrowRight,
} from 'lucide-react';
import { CallSession } from '../types/telephony';

interface CallHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  calls: CallSession[];
  onSelectCall: (call: CallSession) => void;
}

export const CallHistoryModal: React.FC<CallHistoryModalProps> = ({
  isOpen,
  onClose,
  calls,
  onSelectCall,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="bg-gradient-to-b from-[#16181e] to-[#0f1115] border border-zinc-700/80 rounded-2xl max-w-xl w-full p-6 relative shadow-2xl max-h-[85vh] flex flex-col text-zinc-100">
        {/* Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 shadow-sm">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold tracking-tight text-zinc-100">
                Call History &amp; Telemetry Logs
              </h2>
              <p className="text-xs text-zinc-400">
                {calls.length} Session{calls.length === 1 ? '' : 's'} Logged
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-850 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Call List */}
        <div className="flex-1 overflow-y-auto py-3 space-y-2.5 pr-1">
          {calls.length === 0 ? (
            <div className="text-center py-10 text-zinc-500">
              <PhoneCall className="w-7 h-7 mx-auto mb-2 opacity-60" />
              <p className="text-sm font-medium">No previous calls</p>
              <p className="text-xs text-zinc-500 mt-0.5">Dispatched calls will be archived here.</p>
            </div>
          ) : (
            calls.map((call) => {
              const dateStr = new Date(call.createdAt).toLocaleTimeString();
              const hasResponse = call.capturedDigits || call.capturedSpeech;

              return (
                <div
                  key={call.id}
                  onClick={() => {
                    onSelectCall(call);
                    onClose();
                  }}
                  className="p-3.5 rounded-xl bg-[#121418] hover:bg-[#181a20] border border-zinc-800/90 hover:border-zinc-650 transition-all cursor-pointer group shadow-sm"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-zinc-100 font-mono group-hover:text-white transition-colors">
                        {call.to}
                      </span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300 border border-zinc-700">
                        {call.status}
                      </span>
                      {call.isSimulated && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-850 text-zinc-400">
                          Simulator
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-zinc-500 font-mono">
                      {dateStr}
                    </span>
                  </div>

                  <p className="text-xs text-zinc-400 line-clamp-1 mb-2">
                    "{call.script}"
                  </p>

                  <div className="flex items-center justify-between text-xs pt-1.5 border-t border-zinc-850">
                    <div className="flex items-center gap-2">
                      {call.capturedDigits && (
                        <span className="text-zinc-200 font-semibold font-mono text-[11px]">
                          Key [{call.capturedDigits}]: {call.keypadActions[call.capturedDigits] || 'Confirmed'}
                        </span>
                      )}
                      {call.capturedSpeech && (
                        <span className="text-zinc-300 text-[11px]">
                          Voice: "{call.capturedSpeech}"
                        </span>
                      )}
                      {!hasResponse && (
                        <span className="text-zinc-500 text-[11px]">No user input received</span>
                      )}
                    </div>

                    <span className="flex items-center gap-1 text-[11px] text-zinc-400 group-hover:text-zinc-200 font-medium">
                      <span>Inspect</span>
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
