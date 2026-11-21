import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import type { Command, LoopId, PlantStatus, ServerMsg } from '@desal/schema';
import { useReducer, type ComponentType } from 'react';
import { cmdMsg } from '../src/commands';
import { ActionButton } from '../src/controls/ActionButton';
import { Setpoint } from '../src/controls/Setpoint';
import { demoEvents, demoReadings, demoStatus, demoTarget, demoTrends } from '../src/demo';
import { FuelView } from '../src/expanded/FuelView';
import { HeaterView } from '../src/expanded/HeaterView';
import { IntakeView } from '../src/expanded/IntakeView';
import { ProductView } from '../src/expanded/ProductView';
import { ShiftView } from '../src/expanded/ShiftView';
import { StagesView } from '../src/expanded/StagesView';
import type { ExpandedProps } from '../src/expanded/types';
import { LOOP_RANGES, backupOrderCostUsd, loopRange } from '../src/limits';
import { initialState, reducer } from '../src/state/store';
import { Toast } from '../src/ui/Toast';

afterEach(cleanup);

/** Render a view with a recording send(); returns the sent commands. */
function withSend(View: ComponentType<ExpandedProps>, status: PlantStatus, extra: Partial<ExpandedProps> = {}) {
  const sent: Command[] = [];
  const send = (c: Command) => { sent.push(c); return true; };
  const utils = render(
    <View status={status} readings={demoReadings()} target={demoTarget} trends={demoTrends(5)} events={demoEvents()} send={send} pending={new Map()} {...extra} />,
  );
  return { ...utils, sent };
}

const manual = (over: Partial<PlantStatus> = {}): PlantStatus => {
  const st = demoStatus({ controlMode: 'manual', ...over });
  const loops = { ...st.loops };
  for (const id of ['tbt', 'intakeFlow', 'recirc', 'blowdown', 'vacuum'] as LoopId[]) loops[id] = { ...loops[id]!, mode: 'manual' };
  return { ...st, loops, ...over };
};

/** Type a value into the named field and press Enter. */
function enter(root: HTMLElement, name: RegExp, value: string) {
  const input = within(root).getByRole('spinbutton', { name });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input as HTMLInputElement;
}

describe('limits', () => {
  it('mirrors the simulator LOOP_RANGES', () => {
    expect(LOOP_RANGES.tbt).toEqual({ spMin: 85, spMax: 112, outMin: 0, outMax: 100 });
    expect(LOOP_RANGES.recirc).toEqual({ spMin: 2000, spMax: 6500, outMin: 0, outMax: 100 });
    expect(LOOP_RANGES.makeup).toEqual({ spMin: 0.15, spMax: 0.6, outMin: 0, outMax: 100 });
    expect(loopRange('makeup', 'setSetpoint')).toEqual({ min: 0.15, max: 0.6 });
    expect(loopRange('level7', 'setSetpoint')).toEqual({ min: 0.15, max: 0.6 });
    expect(loopRange('recirc', 'setOutput')).toEqual({ min: 0, max: 100 });
  });

  it('prices backup fuel as tonnes x LHV x the reported price, for the offered grade', () => {
    expect(backupOrderCostUsd(10, 'standard', 14)).toBeCloseTo(10 * 42.5 * 14);
    expect(backupOrderCostUsd(10, 'offgrade', 20)).toBeCloseTo(10 * 38 * 20);
    expect(backupOrderCostUsd(10, 'standard', NaN)).toBeUndefined();
  });
});

describe('loop controls follow the mode', () => {
  it('in Auto a setpoint control sends setSetpoint', () => {
    const { container, sent } = withSend(HeaterView, demoStatus());
    enter(container, /tbt setpoint/i, '110');
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'tbt', value: 110 }]);
  });

  it('in Manual the same control sets the output (firing) with setOutput', () => {
    const { container, sent } = withSend(HeaterView, manual());
    expect(container.textContent).toContain('0–100 %');
    enter(container, /tbt output/i, '65');
    expect(sent).toEqual([{ type: 'setOutput', loop: 'tbt', value: 65 }]);
  });

  it('a loop switched to manual in Auto mode takes outputs', () => {
    const st = demoStatus();
    const { container, sent } = withSend(StagesView, { ...st, loops: { ...st.loops, recirc: { mode: 'manual', setpoint: 4180, output: 84 } } });
    enter(container, /recirc output/i, '70');
    expect(sent).toEqual([{ type: 'setOutput', loop: 'recirc', value: 70 }]);
  });

  it('stage levels stay setpoint-driven in Manual; all at once or per stage', () => {
    const { container, sent } = withSend(StagesView, manual());
    enter(container, /all stage levels/i, '0.4');
    expect(sent).toHaveLength(23);
    expect(sent.every((c) => c.type === 'setSetpoint' && c.value === 0.4)).toBe(true);
    const loops = sent.map((c) => (c as { loop: string }).loop);
    expect(loops).toContain('level23');
    expect(loops).not.toContain('level24');
    expect(loops).not.toContain('makeup');
    sent.length = 0;
    fireEvent.change(within(container).getByRole('combobox', { name: /stage/i }), { target: { value: '7' } });
    enter(container, /S7 level setpoint/i, '0.3');
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'level7', value: 0.3 }]);
  });

  it('shows the reported value and its range, and clamps to the range', () => {
    const { container, sent } = withSend(HeaterView, demoStatus());
    expect(container.textContent).toContain('reported 93.5 °C');
    expect(container.textContent).toContain('85–112 °C');
    enter(container, /tbt setpoint/i, '150');
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'tbt', value: 112 }]);
  });

  it('− and + step the field, Enter sends', () => {
    const { container, sent } = withSend(HeaterView, demoStatus());
    fireEvent.click(within(container).getByRole('button', { name: /increase tbt setpoint/i }));
    const input = within(container).getByRole('spinbutton', { name: /tbt setpoint/i }) as HTMLInputElement;
    expect(input.value).toBe('94.0');
    expect(sent).toEqual([]);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'tbt', value: 94 }]);
  });

  it('loop-mode toggles appear only in Auto mode', () => {
    const auto = withSend(HeaterView, demoStatus());
    fireEvent.click(within(auto.container).getByRole('button', { name: /tbt loop mode/i }));
    expect(auto.sent).toEqual([{ type: 'setLoopMode', loop: 'tbt', mode: 'manual' }]);
    cleanup();
    const man = withSend(HeaterView, manual());
    expect(within(man.container).queryByRole('button', { name: /loop mode/i })).toBeNull();
  });

  it('nothing can be sent without a status', () => {
    const { container } = render(<HeaterView status={null} readings={{}} trends={{}} events={[]} send={() => true} />);
    for (const b of container.querySelectorAll('[data-controls] button, [data-controls] input')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('restart', () => {
  const steps = (root: HTMLElement) =>
    ['vacuum', 'recirculation', 'ignition', 'ramp'].map((s) => (within(root).getByRole('button', { name: new RegExp(`^${s}`, 'i') }) as HTMLButtonElement).disabled);

  it('Auto shows one restart button, enabled when tripped', () => {
    const { container, sent } = withSend(ShiftView, demoStatus({ status: 'tripped', tripCause: 'manual' }));
    expect(within(container).queryByRole('button', { name: /^vacuum/i })).toBeNull();
    fireEvent.click(within(container).getByRole('button', { name: /^restart/i }));
    expect(sent).toEqual([{ type: 'restart' }]);
  });

  it.each([
    ['online, nothing to restart', { status: 'online' }, [true, true, true, true]],
    ['tripped: vacuum first', { status: 'tripped' }, [false, true, true, true]],
    ['restarting after vacuum', { status: 'restarting', restartStep: 'vacuum' }, [true, false, true, true]],
    ['restarting after recirc', { status: 'restarting', restartStep: 'recirc' }, [true, true, false, true]],
    ['restarting after ignition', { status: 'restarting', restartStep: 'ignition' }, [true, true, true, false]],
    ['in the ramp: nothing left', { status: 'restarting', restartStep: 'ramp' }, [true, true, true, true]],
    ['an automatic restart is running', { status: 'restarting', restartStep: 'vacuum', restartAuto: true }, [true, true, true, true]],
    ['acid cleaning', { status: 'acidCleaning' }, [true, true, true, true]],
  ] as [string, Partial<PlantStatus>, boolean[]][])('Manual: only the next valid step is enabled (%s)', (_n, over, disabled) => {
    const { container } = withSend(ShiftView, manual(over));
    expect(steps(container)).toEqual(disabled);
  });

  it('Manual: pressing the enabled step sends restartStep', () => {
    const { container, sent } = withSend(ShiftView, manual({ status: 'restarting', restartStep: 'recirc' }));
    fireEvent.click(within(container).getByRole('button', { name: /^ignition/i }));
    expect(sent).toEqual([{ type: 'restartStep', step: 'ignition' }]);
  });
});

describe('ShiftView controls', () => {
  it('manual trip and quit ask for confirmation', () => {
    const { container, sent } = withSend(ShiftView, demoStatus());
    fireEvent.click(within(container).getByRole('button', { name: /^manual trip/i }));
    expect(sent).toEqual([]);
    fireEvent.click(within(container).getByRole('button', { name: /confirm manual trip/i }));
    expect(sent).toEqual([{ type: 'manualTrip' }]);
    fireEvent.click(within(container).getByRole('button', { name: /^quit run/i }));
    fireEvent.click(within(container).getByRole('button', { name: /cancel/i }));
    expect(sent).toHaveLength(1);
    fireEvent.click(within(container).getByRole('button', { name: /^quit run/i }));
    fireEvent.click(within(container).getByRole('button', { name: /confirm quit run/i }));
    expect(sent.at(-1)).toEqual({ type: 'quitGame' });
  });

  it('pause and resume follow the phase', () => {
    const running = withSend(ShiftView, demoStatus());
    fireEvent.click(within(running.container).getByRole('button', { name: /^pause/i }));
    expect(running.sent).toEqual([{ type: 'pause' }]);
    cleanup();
    const paused = withSend(ShiftView, demoStatus({ phase: 'paused' }));
    fireEvent.click(within(paused.container).getByRole('button', { name: /^resume/i }));
    expect(paused.sent).toEqual([{ type: 'resume' }]);
  });
});

describe('IntakeView controls', () => {
  it('overhaul is hidden while the pump runs and offered with its cost when stopped', () => {
    const { container } = withSend(IntakeView, demoStatus());
    const row = (id: string) => container.querySelector(`[data-pump-control="${id}"]`) as HTMLElement;
    expect(within(row('P-101')).queryByRole('button', { name: /overhaul/i })).toBeNull();
    expect(within(row('P-102')).queryByRole('button', { name: /overhaul/i })).toBeNull();
    expect(within(row('P-103')).getByRole('button', { name: /overhaul/i }).textContent).toContain('$8,000');
  });

  it('overhaul confirms, then sends; disabled when unaffordable; hidden while under overhaul', () => {
    const { container, sent } = withSend(IntakeView, demoStatus());
    const row = container.querySelector('[data-pump-control="P-103"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /overhaul/i }));
    fireEvent.click(within(row).getByRole('button', { name: /confirm overhaul/i }));
    expect(sent).toEqual([{ type: 'overhaulPump', pumpId: 'P-103' }]);
    cleanup();
    const poor = withSend(IntakeView, demoStatus({ balanceUsd: 7999 }));
    const poorRow = poor.container.querySelector('[data-pump-control="P-103"]') as HTMLElement;
    expect((within(poorRow).getByRole('button', { name: /overhaul/i }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const pumps = { ...demoStatus().pumps, 'P-103': { running: false, overhaulRemainingTicks: 30 } };
    const busy = withSend(IntakeView, demoStatus({ pumps }));
    const busyRow = busy.container.querySelector('[data-pump-control="P-103"]') as HTMLElement;
    expect(within(busyRow).queryByRole('button', { name: /^overhaul/i })).toBeNull();
    expect((within(busyRow).getByRole('button', { name: /P-103/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('doses show the values the plant reports', () => {
    const { container } = withSend(IntakeView, demoStatus({ doses: { chlorineMgL: 1.5, antiscalantMgL: 3 } }));
    const chl = container.querySelector('[data-control="Chlorine dose"]')!;
    const anti = container.querySelector('[data-control="Antiscalant dose"]')!;
    expect(chl.textContent).toContain('reported 1.5 mg/L');
    expect(anti.textContent).toContain('reported 3.0 mg/L');
    expect((within(chl as HTMLElement).getByRole('spinbutton') as HTMLInputElement).value).toBe('1.5');
  });

  it('pump start/stop, intake flow and doses', () => {
    const { container, sent } = withSend(IntakeView, demoStatus());
    fireEvent.click(within(container).getByRole('button', { name: /P-101/ }));
    fireEvent.click(within(container).getByRole('button', { name: /P-103/ }));
    enter(container, /intake flow setpoint/i, '6000');
    enter(container, /chlorine/i, '1.5');
    enter(container, /antiscalant/i, '20');
    expect(sent).toEqual([
      { type: 'pump', pumpId: 'P-101', action: 'stop' },
      { type: 'pump', pumpId: 'P-103', action: 'start' },
      { type: 'setSetpoint', loop: 'intakeFlow', value: 6000 },
      { type: 'setDose', chemical: 'chlorine', mgL: 1.5 },
      { type: 'setDose', chemical: 'antiscalant', mgL: 10 },
    ]);
  });
});

describe('StagesView controls', () => {
  it('"All stage levels" does not show S1\'s pending edit as its own', () => {
    const pending = new Map([['setSetpoint:level1', { command: { type: 'setSetpoint', loop: 'level1', value: 0.3 } as Command, age: 0 }]]);
    const { container } = withSend(StagesView, demoStatus(), { pending });
    const all = container.querySelector('[data-control="All stage levels"]')!;
    const s1 = container.querySelector('[data-control="S1 level setpoint"]')!;
    expect(all.textContent).not.toContain('sending…');
    expect((within(all as HTMLElement).getByRole('spinbutton') as HTMLInputElement).value).toBe('0.35');
    expect(s1.textContent).toContain('sending…');
  });

  it('ball cleaning toggles; acid clean only when tripped, with its cost', () => {
    const online = withSend(StagesView, demoStatus());
    fireEvent.click(within(online.container).getByRole('button', { name: /ball cleaning/i }));
    expect(online.sent).toEqual([{ type: 'ballCleaning', on: true }]);
    expect(within(online.container).queryByRole('button', { name: /acid clean/i })).toBeNull();
    cleanup();
    const tripped = withSend(StagesView, demoStatus({ status: 'tripped' }));
    const btn = within(tripped.container).getByRole('button', { name: /acid clean/i });
    expect(btn.textContent).toContain('$6,000');
    fireEvent.click(btn);
    fireEvent.click(within(tripped.container).getByRole('button', { name: /confirm acid clean/i }));
    expect(tripped.sent).toEqual([{ type: 'acidClean' }]);
  });

  it('the stage picker lists the 23 level loops, S1–S23 (the brine pool is the makeup loop\'s)', () => {
    const { container } = withSend(StagesView, demoStatus());
    const options = [...within(container).getByRole('combobox', { name: /stage/i }).querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(Array.from({ length: 23 }, (_, i) => `S${i + 1}`));
  });

  it('the makeup loop has a pool-level setpoint (m) and, in Auto, a loop-mode toggle', () => {
    const { container, sent } = withSend(StagesView, demoStatus());
    expect(container.querySelector('[data-control="Makeup setpoint"]')!.textContent).toContain('0.15–0.6 m');
    enter(container, /makeup setpoint/i, '0.32');
    fireEvent.click(within(container).getByRole('button', { name: /makeup loop mode/i }));
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'makeup', value: 0.32 }, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' }]);
  });

  it('the makeup loop takes outputs when switched to manual', () => {
    const st = demoStatus();
    const { container, sent } = withSend(StagesView, { ...st, loops: { ...st.loops, makeup: { mode: 'manual', setpoint: 0.3, output: 50 } } });
    enter(container, /makeup output/i, '60');
    expect(sent).toEqual([{ type: 'setOutput', loop: 'makeup', value: 60 }]);
  });

  it('in Manual control mode the makeup loop keeps its setpoint and its mode toggle (a controller fault clears in Manual)', () => {
    const { container, sent } = withSend(StagesView, manual());
    enter(container, /makeup setpoint/i, '0.3');
    fireEvent.click(within(container).getByRole('button', { name: /makeup loop mode/i }));
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'makeup', value: 0.3 }, { type: 'setLoopMode', loop: 'makeup', mode: 'manual' }]);
    // The other Stages loops are plant-managed in Manual control mode: no toggles for them.
    expect(within(container).queryByRole('button', { name: /(recirc|blowdown|vacuum) loop mode/i })).toBeNull();
  });

  it('blowdown CF and vacuum use controlFor', () => {
    const { container, sent } = withSend(StagesView, demoStatus());
    enter(container, /blowdown setpoint/i, '1.5');
    enter(container, /vacuum setpoint/i, '0.9');
    expect(sent).toEqual([{ type: 'setSetpoint', loop: 'blowdown', value: 1.5 }, { type: 'setSetpoint', loop: 'vacuum', value: 0.9 }]);
  });
});

describe('ProductView controls', () => {
  it('divert to drain', () => {
    const { container, sent } = withSend(ProductView, demoStatus());
    fireEvent.click(within(container).getByRole('button', { name: /divert to drain/i }));
    expect(sent).toEqual([{ type: 'divertToDrain', on: true }]);
  });
});

describe('FuelView controls', () => {
  it('selects backup fuel; disabled during a changeover', () => {
    const { container, sent } = withSend(FuelView, demoStatus());
    expect((within(container).getByRole('button', { name: /use gas/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(container).getByRole('button', { name: /use backup/i }));
    expect(sent).toEqual([{ type: 'selectFuel', fuel: 'backup' }]);
    cleanup();
    const changing = withSend(FuelView, demoStatus({ fuel: { ...demoStatus().fuel, changeoverTo: 'backup' } }));
    expect((within(changing.container).getByRole('button', { name: /use backup/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(changing.container).getByRole('button', { name: /use gas/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the live order cost and orders backup fuel', () => {
    const { container, sent } = withSend(FuelView, demoStatus());
    const input = within(container).getByRole('spinbutton', { name: /tonnes/i });
    fireEvent.change(input, { target: { value: '20' } });
    expect(container.textContent).toContain('$11,900'); // 20 x 42.5 x 14
    fireEvent.click(within(container).getByRole('button', { name: /^order/i }));
    expect(sent).toEqual([{ type: 'orderFuel', tonnes: 20 }]);
  });

  it('the order button is disabled when unaffordable', () => {
    const { container } = withSend(FuelView, demoStatus({ balanceUsd: 5000 }));
    const input = within(container).getByRole('spinbutton', { name: /tonnes/i });
    fireEvent.change(input, { target: { value: '20' } }); // $11,900 > $5,000
    expect((within(container).getByRole('button', { name: /^order/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '5' } }); // $2,975
    expect((within(container).getByRole('button', { name: /^order/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Enter pressed twice in the tonnes field places one order (no status in between)', () => {
    const { container, sent } = withSend(FuelView, demoStatus());
    const input = within(container).getByRole('spinbutton', { name: /tonnes/i });
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(within(container).getByRole('button', { name: /^order/i }));
    expect(sent).toEqual([{ type: 'orderFuel', tonnes: 20 }]);
  });

  it('uses the backup price the plant reports; no price, no order', () => {
    const fuel = demoStatus().fuel;
    const dear = withSend(FuelView, demoStatus({ balanceUsd: 50000, fuel: { ...fuel, backupPriceUsdPerGJ: 20 } }));
    fireEvent.change(within(dear.container).getByRole('spinbutton', { name: /tonnes/i }), { target: { value: '20' } });
    expect(dear.container.textContent).toContain('$17,000'); // 20 x 42.5 x 20
    cleanup();
    const none = withSend(FuelView, demoStatus({ fuel: { ...fuel, backupPriceUsdPerGJ: NaN } }));
    fireEvent.change(within(none.container).getByRole('spinbutton', { name: /tonnes/i }), { target: { value: '20' } });
    expect((within(none.container).getByRole('button', { name: /^order/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('prices an off-grade offer at the off-grade LHV', () => {
    const { container } = withSend(FuelView, demoStatus({ offeredGrade: 'offgrade' }));
    fireEvent.change(within(container).getByRole('spinbutton', { name: /tonnes/i }), { target: { value: '20' } });
    expect(container.textContent).toContain('$10,640'); // 20 x 38 x 14
  });
});

describe('widgets', () => {
  it('Setpoint shows "sending…" while a value is pending', () => {
    const { container, rerender } = render(<Setpoint label="TBT setpoint" reported={108} min={90} max={118} step={0.5} unit="°C" digits={1} onCommit={() => {}} />);
    expect(container.textContent).not.toContain('sending…');
    rerender(<Setpoint label="TBT setpoint" reported={108} pending={110} min={90} max={118} step={0.5} unit="°C" digits={1} onCommit={() => {}} />);
    expect(container.textContent).toContain('sending…');
    expect((within(container).getByRole('spinbutton') as HTMLInputElement).value).toBe('110.0');
  });

  it('Esc in a field with an edit cancels the edit and does not close the view', () => {
    const { container } = render(<Setpoint label="TBT setpoint" reported={108} min={90} max={118} step={0.5} digits={1} onCommit={() => {}} />);
    const input = within(container).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '111' } });
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(input.value).toBe('108.0');
  });

  it('ActionButton shows its cost and confirms when asked', () => {
    const onAction = vi.fn();
    const { getByRole } = render(<ActionButton label="Acid clean" costUsd={6000} confirm onAction={onAction} />);
    expect(getByRole('button').textContent).toContain('$6,000');
    fireEvent.click(getByRole('button'));
    fireEvent.click(getByRole('button', { name: /confirm acid clean/i }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('ActionButton drops an armed confirm when it becomes disabled', () => {
    const onAction = vi.fn();
    const { getByRole, queryByRole, rerender } = render(<ActionButton label="Quit run" confirm onAction={onAction} />);
    fireEvent.click(getByRole('button', { name: /quit run/i }));
    expect(getByRole('button', { name: /confirm quit run/i })).toBeTruthy();
    rerender(<ActionButton label="Quit run" confirm disabled onAction={onAction} />);
    rerender(<ActionButton label="Quit run" confirm onAction={onAction} />);
    expect(queryByRole('button', { name: /confirm quit run/i })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('Esc while a confirm is open cancels the confirm and does not close the view', () => {
    const { getByRole, queryByRole } = render(<ActionButton label="Manual trip" confirm onAction={() => {}} />);
    fireEvent.click(getByRole('button', { name: /manual trip/i }));
    const cancel = getByRole('button', { name: /cancel/i });
    expect(document.activeElement).toBe(cancel);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { cancel.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    expect(queryByRole('button', { name: /confirm manual trip/i })).toBeNull();
  });

  it('Toast dismisses after 6 s even when onDismiss changes identity on every render', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const toast = { kind: 'rejected' as const, message: 'insufficient funds' };
      const { rerender } = render(<Toast toast={toast} onDismiss={() => onDismiss()} />);
      act(() => { vi.advanceTimersByTime(4000); });
      rerender(<Toast toast={toast} onDismiss={() => onDismiss()} />);
      act(() => { vi.advanceTimersByTime(2100); });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pending and rejection', () => {
  // The real store, a sending view and the toast, as the control room will wire them.
  function Room({ onSend, View = HeaterView }: { onSend: (msg: { commandId: string; command: Command }) => void; View?: ComponentType<ExpandedProps> }) {
    const [s, dispatch] = useReducer(reducer, undefined, () =>
      reducer(initialState(), { type: 'server', msg: { t: 'status', status: demoStatus() } }));
    (Room as unknown as { dispatch: typeof dispatch }).dispatch = dispatch;
    const send = (command: Command) => {
      const { commandId } = cmdMsg(command);
      onSend({ commandId, command });
      dispatch({ type: 'sent', command, commandId });
      return true;
    };
    return (
      <>
        <View status={s.status} readings={demoReadings()} target={demoTarget} trends={{}} events={[]} pending={s.pending} send={send} />
        <Toast toast={s.toast} onDismiss={() => dispatch({ type: 'dismissToast' })} />
      </>
    );
  }
  const dispatchServer = (msg: ServerMsg) =>
    act(() => (Room as unknown as { dispatch: (a: unknown) => void }).dispatch({ type: 'server', msg }));

  it('a rejection shows a toast with the reason and reverts the control to the reported value', () => {
    const sends: { commandId: string; command: Command }[] = [];
    const { container } = render(<Room onSend={(m) => sends.push(m)} />);
    const input = enter(container, /tbt setpoint/i, '112');
    expect(input.value).toBe('112.0');
    expect(container.textContent).toContain('sending…');
    const { gameId } = demoStatus();
    dispatchServer({ t: 'event', event: { gameId, epoch: 0, seq: 500, tick: 1, plantTime: 1, shiftId: 3, type: 'commandRejected', commandId: sends[0]!.commandId, reason: 'setpoint changes are Auto-mode only' } });
    expect(within(container).getByRole('alert').textContent).toContain('setpoint changes are Auto-mode only');
    expect(input.value).toBe('93.5');
    expect(container.textContent).not.toContain('sending…');
    expect(container.textContent).toContain('reported 93.5 °C');
  });

  it('a paid fuel order cannot repeat until a status arrives', () => {
    const sends: { commandId: string; command: Command }[] = [];
    const { container } = render(<Room View={FuelView} onSend={(m) => sends.push(m)} />);
    const input = within(container).getByRole('spinbutton', { name: /tonnes/i });
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sends.map((m) => m.command)).toEqual([{ type: 'orderFuel', tonnes: 20 }]);
    expect(container.textContent).toContain('sending…');
    dispatchServer({ t: 'status', status: demoStatus({ balanceUsd: 5000, tick: 1721 }) });
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sends).toHaveLength(2);
  });

  it('"All stage levels" shows its own pending state after sending to all stages', () => {
    const { container } = render(<Room View={StagesView} onSend={() => {}} />);
    enter(container, /all stage levels/i, '0.4');
    const all = container.querySelector('[data-control="All stage levels"]')!;
    expect(all.textContent).toContain('sending…');
    expect((within(all as HTMLElement).getByRole('spinbutton') as HTMLInputElement).value).toBe('0.40');
  });

  it('the next status reporting the new value clears the pending entry', () => {
    const sends: { commandId: string; command: Command }[] = [];
    const { container } = render(<Room onSend={(m) => sends.push(m)} />);
    const input = enter(container, /tbt setpoint/i, '112');
    const st = demoStatus();
    dispatchServer({ t: 'status', status: { ...st, loops: { ...st.loops, tbt: { mode: 'auto', setpoint: 112, output: 72 } } } });
    expect(container.textContent).not.toContain('sending…');
    expect(input.value).toBe('112.0');
    expect(container.textContent).toContain('reported 112.0 °C');
  });
});

describe('crew buttons', () => {
  const BUTTONS: [string, ComponentType<ExpandedProps>, string, string][] = [
    ['ProductView', ProductView, 'plugTubes', 'Send crew: plug tubes — $800, 60 min'],
    ['StagesView', StagesView, 'repairEjector', 'Send crew: repair ejector — $1,000, 45 min'],
    ['IntakeView', IntakeView, 'cleanScreens', 'Send crew: clean screens — $300, 30 min'],
    ['FuelView', FuelView, 'flushFuel', 'Send crew: flush fuel — $1,500, 60 min'],
    ['ShiftView', ShiftView, 'replaceSensor', 'Send crew: replace instrument — $400, 30 min'],
  ];
  it.each(BUTTONS)('%s sends the crew job on click, whatever the fault state', (_n, View, job, text) => {
    const { container, sent } = withSend(View, demoStatus());
    fireEvent.click(within(container).getByRole('button', { name: text }));
    expect(sent).toEqual([{ type: 'dispatchCrew', job }]);
  });
  it.each(BUTTONS)('%s disables the button while the crew is busy', (_n, View, _job, text) => {
    const { container, sent } = withSend(View, demoStatus({ crew: { job: 'cleanScreens', remainingTicks: 10 } }));
    const b = within(container).getByRole('button', { name: text }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(container.textContent).toContain('Crew busy: cleaning screens');
    fireEvent.click(b);
    expect(sent).toEqual([]);
  });
  it('is disabled outside a running shift and while the dispatch is pending', () => {
    const paused = withSend(ProductView, demoStatus({ phase: 'paused' }));
    expect((within(paused.container).getByRole('button', { name: /send crew/i }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const pending = new Map([['dispatchCrew', { command: { type: 'dispatchCrew', job: 'plugTubes' }, tick: 0 }]]);
    const p = withSend(ProductView, demoStatus(), { pending: pending as unknown as ExpandedProps['pending'] });
    expect((within(p.container).getByRole('button', { name: /send crew/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('the shift view shows the crew job and minutes left', () => {
    const { container } = withSend(ShiftView, demoStatus({ crew: { job: 'replaceSensor', remainingTicks: 0.1 } }));
    expect(container.textContent).toContain('Replacing sensor, 1 min left');
  });
});
