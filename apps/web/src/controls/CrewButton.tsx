import type { CrewJob } from '@desal/schema';
import { dispatchCrew } from '../commands';
import { usd } from '../equipment/format';
import { CREW_JOBS } from '../plantConstants';
import { ActionButton } from './ActionButton';
import { canSend, pendingCommand, type ControlCtx } from './ctx';

/**
 * Send the crew on one job. Never hidden by fault state (the player must diagnose it, and the plant
 * rejects a job with no fault); disabled only outside a running shift, while the crew is busy, or while sending.
 */
export function CrewButton({ job, ...ctl }: ControlCtx & { job: CrewJob }) {
  const j = CREW_JOBS[job];
  const busy = ctl.status?.crew;
  const running = ctl.status?.phase === 'running';
  return (
    <ActionButton
      label={`Send crew: ${j.plain} — ${usd(j.costUsd)}, ${j.minutes} min`}
      disabled={!canSend(ctl) || !running || !!busy}
      hint={busy ? `Crew busy: ${CREW_JOBS[busy.job]?.doing.toLowerCase() ?? busy.job}` : undefined}
      pending={pendingCommand(ctl, 'dispatchCrew') !== undefined}
      onAction={() => ctl.send?.(dispatchCrew(job))}
    />
  );
}
