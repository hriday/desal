import { cleanup, fireEvent, render } from '@testing-library/react';
import type { PlantStatus } from '@desal/schema';
import type { ComponentType } from 'react';
import type { Alarm } from '../src/alarms/rules';
import { demoReadings, demoStatus, demoTarget } from '../src/demo';
import { BrineHeater } from '../src/equipment/BrineHeater';
import { FlashStages } from '../src/equipment/FlashStages';
import { Fuel } from '../src/equipment/Fuel';
import { Intake } from '../src/equipment/Intake';
import { Pipe } from '../src/equipment/Pipe';
import { ProductWater } from '../src/equipment/ProductWater';
import { ShiftAccount } from '../src/equipment/ShiftAccount';
import type { EquipmentProps } from '../src/equipment/types';
import { AlarmStrip } from '../src/wall/AlarmStrip';
import { Monitor } from '../src/wall/Monitor';
import { Wall } from '../src/wall/Wall';

afterEach(cleanup);

const EQUIPMENT: [string, ComponentType<EquipmentProps>, string[]][] = [
  ['Intake', Intake, ['5,800 m³/h', 'Chl-a 4.1', 'P-101', 'P-103']],
  ['BrineHeater', BrineHeater, ['93.5 °C', '72 %', 'burner health 93 %']],
  ['FlashStages', FlashStages, ['24 stages', 'Vac 0.94']],
  ['ProductWater', ProductWater, ['512 m³/h', '18 ppm', 'in spec']],
  ['Fuel', Fuel, ['60 MW', '$8.00/GJ', '128 t', 'standard', 'on gas']],
  ['ShiftAccount', ShiftAccount, ['Shift 3', '3h 40m left', '2,380 / 3,900 m³', '$12,450']],
];

describe('equipment drawings', () => {
  it.each(EQUIPMENT)('%s renders "—" without throwing when readings and status are missing', (_n, C) => {
    const { container } = render(<C status={null} readings={{}} target={null} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toContain('—');
  });

  // Readings and status as they might arrive malformed: non-finite or null values, unknown enum values.
  const weirdReadings = (v: unknown) =>
    Object.fromEntries(Object.keys(demoReadings()).map((k) => [k, v])) as unknown as Record<string, number>;
  const weirdStatus = {
    ...demoStatus(),
    status: 'melting', controlMode: 'hybrid', balanceUsd: null, shiftNumber: null, shiftTicksRemaining: NaN,
    fuel: { active: 'coal', changeoverTo: null, backupGrade: 'sludge', gasCurtailmentNotice: null },
  } as unknown as PlantStatus;

  it.each(EQUIPMENT.flatMap(([n, C]) => [NaN, Infinity, null].map((v) => [n, C, v] as const)))(
    '%s renders "—" and no NaN/undefined/null for %s readings and unknown status values',
    (_n, C, v) => {
      const { container } = render(<C status={weirdStatus} readings={weirdReadings(v)} target={{ ...demoTarget, productM3: 0 }} />);
      expect(container.textContent).toContain('—');
      expect(container.innerHTML).not.toMatch(/NaN|undefined|null|Infinity/);
    },
  );

  it.each(EQUIPMENT)('%s shows no NaN/undefined/null with nothing known', (_n, C) => {
    const { container } = render(<C status={null} readings={{}} target={null} />);
    expect(container.innerHTML).not.toMatch(/NaN|undefined|null|Infinity/);
  });

  it.each(EQUIPMENT)('%s draws no NaN with a zero target', (_n, C) => {
    const { container } = render(<C status={demoStatus()} readings={demoReadings()} target={{ ...demoTarget, productM3: 0 }} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('unknown status, mode and fuel values render "—", not raw or blank', () => {
    const shift = render(<ShiftAccount status={weirdStatus} readings={demoReadings()} target={demoTarget} />).container.textContent;
    expect(shift).not.toMatch(/melting|hybrid|Manual mode|Auto mode/);
    expect(shift).toContain('Balance—');
    cleanup();
    const fuel = render(<Fuel status={weirdStatus} readings={demoReadings()} target={null} />).container.textContent;
    expect(fuel).not.toMatch(/coal|sludge/);
    expect(fuel).toContain('on —');
  });

  it('prototype keys as enum values render "—", not inherited properties', () => {
    const proto = {
      ...demoStatus(),
      status: 'constructor', controlMode: 'toString',
      fuel: { active: '__proto__', changeoverTo: null, backupGrade: 'hasOwnProperty', gasCurtailmentNotice: null },
    } as unknown as PlantStatus;
    const shift = render(<ShiftAccount status={proto} readings={demoReadings()} target={demoTarget} />).container;
    expect(shift.innerHTML).not.toMatch(/function|native code|\[object/);
    expect(shift.textContent).not.toMatch(/ONLINE|TRIPPED|Auto mode|Manual mode/);
    cleanup();
    const fuel = render(<Fuel status={proto} readings={demoReadings()} target={null} />).container;
    expect(fuel.innerHTML).not.toMatch(/function|native code|\[object/);
    expect(fuel.textContent).toContain('on —');
  });

  it('an unknown changeoverTo shows "→ —" in warn colour', () => {
    const st = { ...demoStatus(), fuel: { ...demoStatus().fuel, changeoverTo: 'coal' } } as unknown as PlantStatus;
    const { container } = render(<Fuel status={st} readings={demoReadings()} target={null} />);
    const t = [...container.querySelectorAll('text')].find((e) => e.textContent === '→ —');
    expect(t?.getAttribute('fill')).toBe('var(--warn)');
  });

  it('ProductWater falls back to the default limit for a NaN target limit', () => {
    const { container } = render(<ProductWater status={demoStatus()} readings={demoReadings()} target={{ ...demoTarget, maxSalinityPpm: NaN }} />);
    expect(container.textContent).toContain('limit 25 ppm');
  });

  it.each(EQUIPMENT)('%s shows its key values from a sample frame', (_n, C, expected) => {
    const { container } = render(<C status={demoStatus()} readings={demoReadings()} target={demoTarget} />);
    for (const text of expected) expect(container.textContent).toContain(text);
  });

  it('tints each stage by its hard scale', () => {
    const r = demoReadings({ 'stages.s03.hardScaleMm': 0.3, 'stages.s04.hardScaleMm': 0.299 });
    const { container } = render(<FlashStages status={demoStatus()} readings={r} target={null} />);
    const tint = (n: number) => container.querySelector(`[data-stage="${n}"]`)?.getAttribute('data-scale');
    expect([tint(1), tint(2), tint(3), tint(4)]).toEqual(['ok', 'bad', 'warn', 'ok']);
  });

  it('draws 24 stages: heat recovery 1–21, then a separate heat-rejection section 22–24', () => {
    const { container } = render(<FlashStages status={demoStatus()} readings={demoReadings()} target={null} />);
    const stages = [...container.querySelectorAll('[data-stage]')];
    expect(stages.map((g) => Number(g.getAttribute('data-stage')))).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    const section = (n: number) => stages[n - 1]!.closest('[data-section]')?.getAttribute('data-section');
    expect([section(1), section(21), section(22), section(24)]).toEqual(['recovery', 'recovery', 'reject', 'reject']);
    // The reject section stands apart: the gap between S21 and S22 is wider than between neighbours.
    const x = (n: number) => Number(stages[n - 1]!.querySelector('rect')!.getAttribute('x'));
    expect(x(22) - x(21)).toBeGreaterThan(x(21) - x(20));
  });

  it('pipes: seawater through the reject tubes, makeup to the pool, cooling reject to sea, recycle from S24 through S21 → S1', () => {
    const r = demoReadings({ 'brine.makeupM3h': 0 });
    const { container } = render(<FlashStages status={demoStatus()} readings={r} target={null} />);
    const pipe = (name: string) => container.querySelector(`[data-pipe="${name}"]`);
    for (const name of ['seawater', 'makeup', 'coolingReject', 'recycle', 'distillate']) expect(pipe(name), name).not.toBeNull();
    expect(pipe('condenser')).toBeNull();
    expect(pipe('makeup')!.getAttribute('data-flowing')).toBe('false');
    expect(pipe('seawater')!.getAttribute('data-flowing')).toBe('true');
    expect(pipe('coolingReject')!.getAttribute('data-flowing')).toBe('true');
    expect(pipe('recycle')!.getAttribute('data-flowing')).toBe('true');
    // Recycle starts under the S24 pool and ends at S1's tubes (on to the heater).
    const shell = (n: number) => container.querySelector(`[data-stage="${n}"] rect`)!;
    const left = (n: number) => Number(shell(n).getAttribute('x'));
    const right = (n: number) => left(n) + Number(shell(n).getAttribute('width'));
    const d = pipe('recycle')!.querySelector('path')!.getAttribute('d')!;
    const start = Number(/^M\s*([\d.]+)/.exec(d)![1]);
    const end = Number(/H\s*([\d.]+)\s*$/.exec(d)![1]);
    expect(start).toBeGreaterThanOrEqual(left(24));
    expect(start).toBeLessThanOrEqual(right(24));
    expect(end).toBeLessThanOrEqual(left(1));
  });

  it('fills a stage by its brine level', () => {
    const { container } = render(<FlashStages status={demoStatus()} readings={demoReadings({ 'stages.s01.levelM': 0.5 })} target={null} />);
    const h = (n: number) => Number(container.querySelector(`[data-stage="${n}"] .brine`)?.getAttribute('height'));
    expect(h(1)).toBeGreaterThan(h(2));
  });

  it('shows pumps running or stopped', () => {
    const { container } = render(<Intake status={demoStatus()} readings={demoReadings()} target={null} />);
    const state = (id: string) => container.querySelector(`[data-pump="${id}"]`)?.getAttribute('data-running');
    expect([state('P-101'), state('P-102'), state('P-103')]).toEqual(['true', 'true', 'false']);
  });

  it('draws more algae as chlorophyll rises', () => {
    const algae = (chl: number) => {
      const { container, unmount } = render(<Intake status={demoStatus()} readings={demoReadings({ 'pretreat.chlorophyllUgL': chl })} target={null} />);
      const n = container.querySelectorAll('.algae circle').length;
      unmount();
      return n;
    };
    expect(algae(0)).toBe(0);
    expect(algae(2)).toBeGreaterThan(0);
    expect(algae(8)).toBeGreaterThan(algae(2));
  });

  it('scales the flame with firing', () => {
    const scale = (firing: number) => {
      const { container, unmount } = render(<BrineHeater status={demoStatus()} readings={demoReadings({ 'heater.firingPct': firing })} target={null} />);
      const s = Number(container.querySelector('[data-flame]')?.getAttribute('data-flame'));
      unmount();
      return s;
    };
    expect(scale(0)).toBe(0);
    expect(scale(100)).toBeGreaterThan(scale(30));
  });
});

const alarm = (monitor: Alarm['monitor'], level: Alarm['level'], id = `${monitor}-${level}`): Alarm => ({ id, monitor, level, text: `${monitor} ${level}` });

describe('Monitor', () => {
  const props = { status: demoStatus(), readings: demoReadings(), target: demoTarget };

  it.each([
    [[], 'monitor--ok'],
    [[alarm('heater', 'warn')], 'monitor--warn'],
    [[alarm('heater', 'warn'), alarm('heater', 'bad')], 'monitor--bad'],
    [[alarm('stages', 'bad')], 'monitor--ok'],
  ] as [Alarm[], string][])('border follows the worst alarm on the monitor', (alarms, cls) => {
    const { getByRole } = render(<Monitor id="heater" {...props} alarms={alarms} onOpen={() => {}} />);
    expect(getByRole('button').className).toContain(cls);
  });

  it('is a button that opens its monitor', () => {
    const onOpen = vi.fn();
    const { getByRole } = render(<Monitor id="fuel" {...props} alarms={[]} onOpen={onOpen} />);
    fireEvent.click(getByRole('button', { name: /fuel/i }));
    expect(onOpen).toHaveBeenCalledWith('fuel');
  });
});

describe('living wall (Task 11)', () => {
  const props = { readings: demoReadings(), target: demoTarget };
  const pumpStatus = (running: boolean) => {
    const st = demoStatus();
    return { ...st, pumps: { ...st.pumps, 'P-101': { ...st.pumps['P-101'], running } } };
  };

  it('a running pump has class is-running; a stopped one does not', () => {
    const cls = (running: boolean) => {
      const { container, unmount } = render(<Intake status={pumpStatus(running)} {...props} />);
      const c = container.querySelector('[data-pump="P-101"]')!.getAttribute('class') ?? '';
      unmount();
      return c;
    };
    expect(cls(true)).toMatch(/\bis-running\b/);
    expect(cls(false)).not.toMatch(/\bis-running\b/);
  });

  it('a pipe with zero flow is not flowing; with flow it is, and its speed follows the flow', () => {
    const pipe = (flow: number | undefined) => {
      const { container, unmount } = render(<svg><Pipe d="M0 0 H10" stroke="red" width={2} flow={flow} /></svg>);
      const el = container.querySelector('[data-flowing]')!;
      const out = { flowing: el.getAttribute('data-flowing'), speed: (el as SVGElement).style.getPropertyValue('--flow-speed') };
      unmount();
      return out;
    };
    expect(pipe(0).flowing).toBe('false');
    expect(pipe(undefined).flowing).toBe('false');
    expect(pipe(1).flowing).toBe('true');
    expect(parseFloat(pipe(1).speed)).toBeLessThan(parseFloat(pipe(0.3).speed));
    expect(pipe(0).speed).not.toMatch(/NaN|Infinity/);
  });

  it('the intake header stops flowing at zero intake flow', () => {
    const { container } = render(<Intake status={demoStatus()} readings={demoReadings({ 'intake.flowM3h': 0 })} target={null} />);
    expect(container.querySelector('[data-pipe="header"]')!.getAttribute('data-flowing')).toBe('false');
  });

  it('a Monitor with an unseen high alarm has data-alert="high"; once seen it is gone', () => {
    const alarms = [alarm('heater', 'bad', 'tbt-high')];
    const onOpen = vi.fn();
    const { getByRole, rerender } = render(<Monitor id="heater" status={demoStatus()} {...props} alarms={alarms} seen={new Set()} onOpen={onOpen} />);
    expect(getByRole('button').getAttribute('data-alert')).toBe('high');
    fireEvent.click(getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('heater');
    rerender(<Monitor id="heater" status={demoStatus()} {...props} alarms={alarms} seen={new Set(['tbt-high:bad'])} onOpen={onOpen} />);
    expect(getByRole('button').hasAttribute('data-alert')).toBe(false);
  });

  it('a seen warning that escalates to high pulses again', () => {
    const { getByRole } = render(<Monitor id="heater" status={demoStatus()} {...props} alarms={[alarm('heater', 'bad', 'tbt')]} seen={new Set(['tbt:warn'])} onOpen={() => {}} />);
    expect(getByRole('button').getAttribute('data-alert')).toBe('high');
  });

  it('a warn alarm alone does not make the frame pulse as high', () => {
    const { getByRole } = render(<Monitor id="heater" status={demoStatus()} {...props} alarms={[alarm('heater', 'warn')]} seen={new Set()} onOpen={() => {}} />);
    expect(getByRole('button').getAttribute('data-alert')).toBe('warn');
  });

  it('a Monitor is down (data-down="true") while the plant is tripped, not while online', () => {
    const down = (status: 'tripped' | 'online') => {
      const { getByRole, unmount } = render(<Monitor id="intake" status={demoStatus({ status })} {...props} alarms={[]} onOpen={() => {}} />);
      const v = getByRole('button').getAttribute('data-down');
      unmount();
      return v;
    };
    expect(down('tripped')).toBe('true');
    expect(down('online')).not.toBe('true');
  });

  it.each([
    ['intake', 'acidCleaning', 'true'],
    ['stages', 'restarting', null],
    ['shift', 'tripped', null],
    ['shift', 'acidCleaning', null],
  ] as const)('%s monitor with plant %s: data-down is %s', (id, status, expected) => {
    const { getByRole } = render(<Monitor id={id} status={demoStatus({ status })} {...props} alarms={[]} onOpen={() => {}} />);
    expect(getByRole('button').getAttribute('data-down')).toBe(expected);
  });
});

describe('Wall', () => {
  it('lays out the six monitors in order', () => {
    const { getAllByRole } = render(<Wall status={demoStatus()} readings={demoReadings()} target={demoTarget} alarms={[]} onOpen={() => {}} />);
    expect(getAllByRole('button').map((b) => b.getAttribute('data-monitor'))).toEqual(['intake', 'heater', 'stages', 'product', 'fuel', 'shift']);
  });

  it('renders with nothing known yet', () => {
    expect(() => render(<Wall status={null} readings={{}} target={null} alarms={[]} onOpen={() => {}} />)).not.toThrow();
  });
});

describe('AlarmStrip', () => {
  it('lists every alarm, worst first, and opens its monitor on click', () => {
    const onOpen = vi.fn();
    const { getAllByRole } = render(<AlarmStrip alarms={[alarm('intake', 'warn'), alarm('stages', 'bad')]} onOpen={onOpen} />);
    const items = getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([expect.stringContaining('stages bad'), expect.stringContaining('intake warn')]);
    fireEvent.click(items[1]!);
    expect(onOpen).toHaveBeenCalledWith('intake');
  });

  it('says so when there are no alarms', () => {
    const { container } = render(<AlarmStrip alarms={[]} onOpen={() => {}} />);
    expect(container.textContent).toMatch(/no active alarms/i);
  });
});
