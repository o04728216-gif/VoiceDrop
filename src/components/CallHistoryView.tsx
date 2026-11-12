import React, { useEffect, useState } from 'react';
import {
  PhoneCall,
  Search,
  Download,
  Mic,
  Voicemail,
  UserCheck,
  Volume2,
  RefreshCw,
} from 'lucide-react';
import { CallSession } from '../types/telephony';
import { CompactAudioPlayer, formatAudioBytes } from './CompactAudioPlayer';

interface CallHistoryViewProps {
  calls: CallSession[];
  onSelectCall: (call: CallSession) => void;
  onRefresh?: () => Promise<void> | void;
}

export const CallHistoryView: React.FC<CallHistoryViewProps> = ({
  calls,
  onSelectCall,
  onRefresh,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'completed' | 'voicemail' | 'recorded' | 'in-progress' | 'failed'
  >('all');
  const [inspectSession, setInspectSession] = useState<CallSession | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  // Auto-poll every 1s if any call is actively recording or finalizing right after hangup
  const hasPendingRecording = calls.some(
    (c) => c.recordingStatus === 'recording' && !c.recordingUrl
  );

  useEffect(() => {
    if (!hasPendingRecording || !onRefresh) return;
    const interval = setInterval(() => {
      void onRefresh();
    }, 1000);
    return () => clearInterval(interval);
  }, [hasPendingRecording, onRefresh]);

  // Keep inspectSession synced when calls list updates with newly finalized recordingUrl
  useEffect(() => {
    if (!inspectSession) return;
    const updated = calls.find((c) => c.id === inspectSession.id);
    if (updated && updated !== inspectSession) {
      setInspectSession(updated);
    }
  }, [calls, inspectSession]);

  const filteredCalls = calls.filter((call) => {
    const q = searchTerm.toLowerCase();
    const matchesSearch =
      call.to.toLowerCase().includes(q) ||
      call.script.toLowerCase().includes(q) ||
      (call.capturedDigits && call.capturedDigits.includes(searchTerm)) ||
      (call.capturedSpeech && call.capturedSpeech.toLowerCase().includes(q));

    if (!matchesSearch) return false;

    if (statusFilter === 'all') return true;
    if (statusFilter === 'completed') return call.status === 'completed';
    if (statusFilter === 'voicemail') return call.answeredBy === 'voicemail';
    if (statusFilter === 'recorded') return Boolean(call.recordingUrl);
    if (statusFilter === 'in-progress')
      return [
        'queued',
        'initiating',
        'ringing',
        'in-progress',
        'collecting-input',
        'awaiting-operator',
      ].includes(call.status);
    if (statusFilter === 'failed')
      return ['failed', 'busy', 'no-answer'].includes(call.status);
    return true;
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(calls, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voicedrop-telemetry-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Top Banner & Stats */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 lg:p-6 shadow-sm backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-400"></span>
              <h2 className="text-base font-bold text-white tracking-tight">
                Call History, Voice Recordings &amp; Voicemail Detection
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              Play recorded call audio anytime, review spoken caller transcripts, inspect DTMF codes, and see human vs. voicemail answers.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {onRefresh && (
              <button
                type="button"
                onClick={handleRefresh}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
                <span>Refresh</span>
              </button>
            )}
            <button
              type="button"
              onClick={exportJson}
              disabled={calls.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export JSON</span>
            </button>
          </div>
        </div>

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-slate-800">
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Total Dispatched</span>
            <span className="text-xl font-bold font-mono text-white">{calls.length}</span>
          </div>
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Codes Captured</span>
            <span className="text-xl font-bold font-mono text-emerald-400">
              {calls.filter((c) => Boolean(c.capturedDigits)).length}
            </span>
          </div>
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Voicemail Answered</span>
            <span className="text-xl font-bold font-mono text-orange-400">
              {calls.filter((c) => c.answeredBy === 'voicemail').length}
            </span>
          </div>
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Saved Recordings</span>
            <span className="text-xl font-bold font-mono text-cyan-400">
              {calls.filter((c) => Boolean(c.recordingUrl)).length}
            </span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 p-3 rounded-2xl">
        <div className="relative w-full sm:w-72">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search phone, spoken talk, code..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2 pointer-events-none" />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto text-xs">
          {(['all', 'recorded', 'voicemail', 'completed', 'in-progress', 'failed'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 rounded-lg font-medium capitalize transition-colors shrink-0 cursor-pointer ${
                statusFilter === filter
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {filter.replace('-', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Table of Records */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 border-b border-slate-800 text-[11px] font-semibold uppercase text-slate-400">
              <tr>
                <th className="py-3 px-4">Recipient &amp; Answered By</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Captured Code &amp; Spoken Voice</th>
                <th className="py-3 px-4">Recorded Audio Playback</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredCalls.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    <PhoneCall className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p className="font-medium">No telephony records match the query</p>
                  </td>
                </tr>
              ) : (
                filteredCalls.map((call) => {
                  const dateStr = new Date(call.createdAt).toLocaleString();
                  const transcripts = call.speechTranscripts || [];
                  const hasResponse =
                    call.capturedDigits || call.capturedSpeech || transcripts.length > 0;

                  return (
                    <tr
                      key={call.id}
                      className="hover:bg-slate-800/50 transition-colors cursor-pointer"
                      onClick={() => setInspectSession(call)}
                    >
                      <td className="py-3 px-4">
                        <div className="font-bold text-white font-mono">{call.to}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {call.answeredBy === 'voicemail' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-500/15 text-orange-300 border border-orange-500/30">
                              <Voicemail className="w-3 h-3 text-orange-400" />
                              <span>Voicemail Service</span>
                            </span>
                          ) : call.answeredBy === 'human' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                              <UserCheck className="w-3 h-3 text-emerald-400" />
                              <span>Human Answered</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500 font-mono">
                              {call.isSimulated
                                ? 'Simulator'
                                : (call.carrier || 'twilio').toUpperCase()}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold ${
                            call.status === 'completed'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : call.status === 'failed' || call.status === 'busy' || call.status === 'no-answer'
                              ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                              : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                          }`}
                        >
                          {call.status}
                        </span>
                      </td>

                      <td className="py-3 px-4 max-w-xs">
                        {call.capturedDigits && (
                          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold font-mono mb-1">
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30">
                              [{call.capturedDigits}]
                            </span>
                            <span className="text-[11px]">Verified</span>
                          </div>
                        )}
                        {(transcripts.length > 0 || call.capturedSpeech) && (
                          <div className="flex items-start gap-1 text-cyan-300 font-medium">
                            <Mic className="w-3 h-3 text-cyan-400 shrink-0 mt-0.5" />
                            <span className="line-clamp-2 text-[11px]">
                              "
                              {transcripts.length > 0
                                ? transcripts.map((t) => t.text).join(' • ')
                                : call.capturedSpeech}
                              "
                            </span>
                          </div>
                        )}
                        {!hasResponse && <span className="text-slate-500 text-[11px]">No input</span>}
                      </td>

                      <td
                        className="py-2.5 px-3.5 min-w-[235px]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {call.recordingUrl ? (
                          <CompactAudioPlayer
                            src={call.recordingUrl}
                            durationHint={call.recordingDuration || call.duration}
                            sizeBytes={call.recordingSizeBytes}
                            compact={true}
                          />
                        ) : call.recordingStatus === 'recording' ? (
                          ['completed', 'failed', 'busy', 'no-answer'].includes(call.status) ? (
                            call.completedAt &&
                            Date.now() - new Date(call.completedAt).getTime() > 9000 ? (
                              <span className="text-slate-500 text-[11px]">No audio file</span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-300 font-mono">
                                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
                                <span>Finalizing HD audio...</span>
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-[11px] text-rose-300 font-mono">
                              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
                              <span>Recording live...</span>
                            </span>
                          )
                        ) : (
                          <span className="text-slate-500 text-[11px]">No audio file</span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-slate-400 font-mono text-[11px] whitespace-nowrap">
                        {dateStr}
                      </td>

                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCall(call);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 font-medium transition-colors cursor-pointer"
                        >
                          Load in Feed
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspect Session Modal */}
      {inspectSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">Call Session Telemetry &amp; Recording</h3>
                {inspectSession.answeredBy === 'voicemail' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-500/15 text-orange-300 border border-orange-500/30">
                    <Voicemail className="w-3 h-3" />
                    <span>Voicemail</span>
                  </span>
                )}
                {inspectSession.answeredBy === 'human' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                    <UserCheck className="w-3 h-3" />
                    <span>Human</span>
                  </span>
                )}
              </div>
              <button
                onClick={() => setInspectSession(null)}
                className="text-xs px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <span className="text-slate-500 font-mono text-[10px] block">Session ID</span>
                  <span className="font-mono text-indigo-300 break-all">{inspectSession.id}</span>
                </div>
                <div>
                  <span className="text-slate-500 font-mono text-[10px] block">Target &amp; Carrier</span>
                  <span className="font-mono text-slate-200">
                    {inspectSession.to} ({(inspectSession.carrier || 'twilio').toUpperCase()})
                  </span>
                </div>
              </div>

              {/* Recorded Audio Player inside Modal */}
              {inspectSession.recordingUrl && (
                <div className="p-3 bg-slate-950 rounded-xl border border-indigo-500/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>
                        HD Voice Recording
                        {formatAudioBytes(inspectSession.recordingSizeBytes)
                          ? ` (${formatAudioBytes(inspectSession.recordingSizeBytes)})`
                          : ''}
                      </span>
                    </span>
                    <span className="text-[10px] font-mono text-emerald-400">
                      24kHz Wideband • Compact MP3
                    </span>
                  </div>
                  <CompactAudioPlayer
                    src={inspectSession.recordingUrl}
                    durationHint={inspectSession.recordingDuration || inspectSession.duration}
                    sizeBytes={inspectSession.recordingSizeBytes}
                  />
                </div>
              )}

              {/* Spoken Voice Transcripts inside Modal */}
              {((inspectSession.speechTranscripts && inspectSession.speechTranscripts.length > 0) ||
                inspectSession.capturedSpeech) && (
                <div className="p-3 bg-slate-950 rounded-xl border border-cyan-500/25 space-y-1.5">
                  <span className="font-semibold text-cyan-300 flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5" />
                    <span>Caller Spoken Voice &amp; Talks</span>
                  </span>
                  {inspectSession.speechTranscripts && inspectSession.speechTranscripts.length > 0 ? (
                    <div className="space-y-1 max-h-36 overflow-y-auto">
                      {inspectSession.speechTranscripts.map((t) => (
                        <div
                          key={t.id}
                          className="p-2 rounded bg-slate-900 border border-slate-800 flex items-start justify-between gap-2"
                        >
                          <span className="text-slate-200">"{t.text}"</span>
                          <span className="text-[10px] font-mono text-slate-500 shrink-0">
                            {new Date(t.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-200">"{inspectSession.capturedSpeech}"</p>
                  )}
                </div>
              )}

              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                <span className="font-semibold text-slate-300 block">Chronological Events:</span>
                {inspectSession.events.map((evt) => (
                  <div key={evt.id} className="p-2 bg-slate-950 rounded-lg border border-slate-850">
                    <div className="flex items-center justify-between text-[10px] text-slate-500">
                      <span className="font-bold text-slate-300 uppercase">[{evt.type}] {evt.title}</span>
                      <span>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-slate-400 text-xs mt-0.5">{evt.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
