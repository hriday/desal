import { useEffect } from 'react';
import type { MonitorId } from '../alarms/rules';
import { RADIO_MS, type RadioState } from '../state/radio';

export interface RadioProps {
  radio: RadioState;
  onExpire: () => void;
  onOpen: (id: MonitorId) => void;
}

/** The current radio call; clicking it opens the monitor it concerns. It clears itself after 6 s. */
export function Radio({ radio, onExpire, onOpen }: RadioProps) {
  const cur = radio.current;
  const id = cur?.key;
  useEffect(() => {
    if (id === undefined) return;
    const t = setTimeout(onExpire, RADIO_MS);
    return () => clearTimeout(t);
  }, [id, onExpire]);
  if (!cur) return null;
  return (
    <button type="button" className="radio" role="status" data-kind={cur.kind} onClick={() => { onOpen(cur.monitor); onExpire(); }}>
      <span className="radio__tag">RADIO</span> {cur.text}
    </button>
  );
}
