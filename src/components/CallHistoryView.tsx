import React, { useState } from 'react';
import {
  History,
  PhoneCall,
  Search,
  Filter,
  Download,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Mic,
  ArrowRight,
  Eye,
  Activity,
} from 'lucide-react';
import { CallSession } from '../types/telephony';

interface CallHistoryViewProps {
  calls: CallSession[];
  onSelectCall: (call: CallSession) => void;
}

export const CallHistoryView: React.FC<CallHistoryViewProps> = ({
  calls,
  onSelectCall,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'in-progress' | 'failed'>('all');
  const [inspectSession, setInspectSession] = useState<CallSession | null>(null);

  const filteredCalls = calls.filter((call) => {
    const matchesSearch =
      call.to.toLowerCase().includes(searchTerm.toLowerCase()) ||
      call.script.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (call.capturedDigits && call.capturedDigits.includes(searchTerm));

    if (!matchesSearch) return false;

    if (statusFilter === 'all') return true;
    if (statusFilter === 'completed') return call.status === 'completed';
    if (statusFilter === 'in-progress')
      return ['queued', 'initiating', 'ringing', 'in-progress', 'collecting-input'].includes(
        call.status
      );
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
                Telephony Records &amp; DTMF Telemetry
              </h2>
            </div>
            <p className="text-xs text-slate-400">
              Audit logs, DTMF keypresses, speech recognition transcripts, and carrier handshakes.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={exportJson}
              disabled={calls.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium transition-colors disabled:opacity-50"
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
            <span className="text-[10px] uppercase font-bold text-slate-500 block">DTMF Captured</span>
            <span className="text-xl font-bold font-mono text-emerald-400">
              {calls.filter((c) => Boolean(c.capturedDigits)).length}
            </span>
          </div>
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Spoken Word Replies</span>
            <span className="text-xl font-bold font-mono text-cyan-400">
              {calls.filter((c) => Boolean(c.capturedSpeech)).length}
            </span>
          </div>
          <div className="p-3 bg-slate-950/80 rounded-xl border border-slate-800">
            <span className="text-[10px] uppercase font-bold text-slate-500 block">Completed Rate</span>
            <span className="text-xl font-bold font-mono text-indigo-400">
              {calls.length > 0
                ? `${Math.round((calls.filter((c) => c.status === 'completed').length / calls.length) * 100)}%`
                : '100%'}
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
            placeholder="Search by phone, script, digit..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2 pointer-events-none" />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto text-xs">
          {(['all', 'completed', 'in-progress', 'failed'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 rounded-lg font-medium capitalize transition-colors ${
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
                <th className="py-3 px-4">Recipient</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Captured DTMF / Voice</th>
                <th className="py-3 px-4">Mode</th>
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
                  const hasResponse = call.capturedDigits || call.capturedSpeech;

                  return (
                    <tr
                      key={call.id}
                      className="hover:bg-slate-800/50 transition-colors cursor-pointer"
                      onClick={() => setInspectSession(call)}
                    >
                      <td className="py-3 px-4">
                        <div className="font-bold text-white font-mono">{call.to}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-xs">{call.script}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold ${
                            call.status === 'completed'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : call.status === 'failed' || call.status === 'busy'
                              ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                              : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                          }`}
                        >
                          {call.status}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {call.capturedDigits && (
                          <div className="flex items-center gap-1.5 text-emerald-400 font-semibold font-mono">
                            <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 border border-emerald-500/30">
                              [{call.capturedDigits}]
                            </span>
                            <span>{call.keypadActions[call.capturedDigits] || 'Confirmed'}</span>
                          </div>
                        )}
                        {call.capturedSpeech && (
                          <div className="flex items-center gap-1 text-cyan-400 font-medium">
                            <Mic className="w-3 h-3" />
                            <span>"{call.capturedSpeech}"</span>
                          </div>
                        )}
                        {!hasResponse && <span className="text-slate-500 text-[11px]">No response</span>}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-[11px] font-medium text-slate-400">
                          {call.isSimulated ? 'Simulator' : 'Twilio Carrier'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                        {dateStr}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCall(call);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/30 font-medium transition-colors"
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
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
              <h3 className="text-sm font-bold text-white">Call Session Telemetry Audit</h3>
              <button
                onClick={() => setInspectSession(null)}
                className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                <span className="text-slate-500 font-mono text-[10px] block">Session ID:</span>
                <span className="font-mono text-indigo-300">{inspectSession.id}</span>
                <div className="mt-2 text-slate-300">Target: {inspectSession.to}</div>
                <div className="text-slate-300">Voice: {inspectSession.voice}</div>
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto">
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
