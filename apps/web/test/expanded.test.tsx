import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { PlantEventSchema, type Command, type PlantEvent, type PlantStatus } from '@desal/schema';
import type { ComponentType } from 'react';
import { App } from '../src/App';
import { Trend } from '../src/controls/Trend';
import { DEMO_GAME_ID, demoEvents, demoReadings, demoStatus, demoTarget, demoTrends } from '../src/demo';
import { eventText } from '../src/expanded/eventText';
import { ExpandedView } from '../src/expanded/ExpandedView';
import { FuelView } from '../src/expanded/FuelView';
import { HeaterView } from '../src/expanded/HeaterView';
import { IntakeView } from '../src/expanded/IntakeView';
import { ProductView } from '../src/expanded/ProductView';
import { ShiftView, shiftAccount } from '../src/expanded/ShiftView';
import { StagesView } from '../src/expanded/StagesView';
import type { ExpandedProps } from '../src/expanded/types';
import { RECIRC_SUCTION_MIN_M } from '../src/plantConstants';
import { TRIP_FIX } from '../src/expanded/labels';

afterEach(cleanup);

const sample = (over: Partial<PlantStatus> = {}): ExpandedProps => ({
  status: demoStatus(over), readings: demoReadings(), target: demoTarget, trends: demoTrends(), events: demoEvents(), alarms: [],
});
const empty: ExpandedProps = { status: null, readings: {}, target: null, trends: {}, events: [] };

const VIEWS: [string, ComponentType<ExpandedProps>, string[]][] = [
  ['IntakeView', IntakeView, ['P-101', 'P-103', 'Running', 'Stopped', '5,800 m³/h', '5,500 m³/h', '0.18', '4.1 µg/L', '28.0 °C', '31 %', '5 %']],
  ['HeaterView', HeaterView, ['93.5 °C', '72 %', '43.2 MW', '93 %', 'Gas']],
  ['StagesView', StagesView, ['92.1 °C', '0.80 mm', '1.45', '512 m³/h', 'Off']],
  ['ProductView', ProductView, ['512 m³/h', '18.0 ppm', '25 ppm', '2,380 / 3,900 m³', '61 %', 'Auto — to tank']],
  ['FuelView', FuelView, ['60 MW', '$8.00/GJ', '128 t', 'Standard', '$2.15/m³', '$5,120']],
  ['ShiftView', ShiftView, ['Shift 3', '3h 40m', '2,380 / 3,900 m³', '$12,450', 'Online', 'Auto', '$13,120', '$20,000']],
];

describe('expanded views', () => {
  it.each(VIEWS)('%s shows its key values from a sample status and frame', (_n, View, expected) => {
    const { container } = render(<View {...sample()} />);
    for (const text of expected) expect(container.textContent).toContain(text);
    expect(container.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });

  it.each(VIEWS)('%s shows a large drawing, two or three trends and a controls region', (_n, View) => {
    const { container } = render(<View {...sample()} />);
    expect(container.querySelector('.xv__drawing svg')).not.toBeNull();
    const trends = container.querySelectorAll('[data-trend]').length;
    expect(trends).toBeGreaterThanOrEqual(2);
    // StagesView adds the motive steam trend to its three.
    expect(trends).toBeLessThanOrEqual(View === StagesView ? 4 : 3);
    expect(container.querySelector('[data-controls]')).not.toBeNull();
  });

  it.each(VIEWS)('%s renders with null status and nothing known, without throwing', (_n, View) => {
    const { container } = render(<View {...empty} />);
    expect(container.textContent).toContain('—');
    expect(container.innerHTML).not.toMatch(/NaN|undefined|null|Infinity/);
  });

  it.each(VIEWS)('%s survives malformed values', (_n, View) => {
    const weird = {
      ...demoStatus(), status: 'constructor', controlMode: 'hybrid', balanceUsd: null, shiftTicksRemaining: NaN, tripCause: 'gremlins',
      restartStep: '__proto__', loops: {}, pumps: {}, deliveries: null,
      fuel: { active: 'coal', changeoverTo: 'peat', backupGrade: 'sludge', gasCurtailmentNotice: 7 },
    } as unknown as PlantStatus;
    const readings = Object.fromEntries(Object.keys(demoReadings()).map((k) => [k, NaN]));
    const { container } = render(<View {...sample()} status={weird} readings={readings} trends={{ 'heater.tbtC': [{ t: 1, v: NaN }] }} />);
    expect(container.innerHTML).not.toMatch(/NaN|undefined|Infinity|function|\[object/);
  });

  it('StagesView lays out all 24 stages in two labelled groups, each cell with temperature, level and scale', () => {
    const { container } = render(<StagesView {...sample()} />);
    const groups = container.querySelectorAll('[data-stage-group]');
    expect(groups).toHaveLength(2);
    expect(container.querySelectorAll('[data-stage-cell]')).toHaveLength(24);
    const cells = (g: Element) => [...g.querySelectorAll('[data-stage-cell]')].map((c) => Number(c.getAttribute('data-stage-cell')));
    expect(groups[0]!.getAttribute('aria-label')).toBe('Heat recovery 1–21');
    expect(groups[0]!.textContent).toContain('Heat recovery 1–21');
    expect(cells(groups[0]!)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(groups[1]!.getAttribute('aria-label')).toBe('Heat rejection 22–24');
    expect(groups[1]!.textContent).toContain('Heat rejection 22–24');
    expect(cells(groups[1]!)).toEqual([22, 23, 24]);
    expect(container.querySelector('[data-stage-cell="24"]')!.textContent).toContain('Brine pool');
    expect(container.querySelector('[data-stage-cell="23"]')!.textContent).not.toContain('Brine pool');
    const s2 = container.querySelector('[data-stage-cell="2"]')!.textContent;
    expect(s2).toContain('S2');
    expect(s2).toContain('89.8 °C');
    expect(s2).toContain('0.314 m');
    expect(s2).toContain('0.05');
    expect(s2).toContain('0.80');
  });

  const detailValue = (root: HTMLElement, k: string) =>
    [...root.querySelectorAll('.detail__row')].find((r) => r.querySelector('dt')?.textContent === k)?.querySelector('dd');

  it('StagesView shows the makeup and cooling-water reject flows and the brine pool level', () => {
    const { container } = render(<StagesView {...sample()} />);
    expect(detailValue(container, 'Makeup to brine pool')?.textContent).toBe('1,714 m³/h');
    expect(detailValue(container, 'Cooling water reject')?.textContent).toBe('4,086 m³/h');
    expect(detailValue(container, 'Brine pool (S24) level')?.textContent).toBe('0.30 m');
  });

  it('StagesView marks the brine pool low on the brine-pool alarm\'s thresholds', () => {
    const tone = (v: number) => {
      const { container } = render(<StagesView {...sample()} readings={demoReadings({ 'stages.s24.levelM': v })} />);
      const cls = detailValue(container, 'Brine pool (S24) level')!.className;
      cleanup();
      return cls;
    };
    expect(tone(RECIRC_SUCTION_MIN_M - 0.01)).toBe('tone--bad');
    expect(tone(RECIRC_SUCTION_MIN_M)).toBe('tone--bad');
    expect(tone(RECIRC_SUCTION_MIN_M + 0.01)).toBe('tone--warn');
    expect(tone(1.5 * RECIRC_SUCTION_MIN_M)).toBe('tone--warn');
    expect(tone(1.5 * RECIRC_SUCTION_MIN_M + 0.01)).toBe('');
    expect(tone(0.3)).toBe('');
    expect(tone(0.66)).toBe('tone--bad'); // flooding, like any stage
  });

  it('trip advice sends the player to Makeup when the brine pool (S24) empties or floods', () => {
    // An empty pool starves the recirc pump and trips on TBT; a full one trips as a stage flood. Only Makeup moves it.
    expect(TRIP_FIX.tbtHighHigh).toContain('TBT setpoint');
    expect(TRIP_FIX.tbtHighHigh).toMatch(/recirculation.*Brine pool \(S24\).*raise Makeup/);
    expect(TRIP_FIX.stageFlood).toMatch(/level valves/);
    expect(TRIP_FIX.stageFlood).toMatch(/Brine pool \(S24\).*lower Makeup/);
    expect(TRIP_FIX.noIntakeFlow).toMatch(/Makeup refill the Brine pool \(S24\)/);
    for (const k of ['tbtHighHigh', 'stageFlood', 'noIntakeFlow']) expect(TRIP_FIX[k]).toMatch(/then press Restart\.$/);
    // The controls the advice names are on the Stages view under those labels.
    const { container } = render(<StagesView {...sample()} />);
    expect(container.textContent).toContain('Makeup setpoint');
    expect(container.textContent).toContain('Brine pool (S24) level');
  });

  it('IntakeView compares intake flow with the required flow for the seawater temperature', () => {
    const r = { ...demoReadings(), 'intake.seawaterTempC': 35 };
    const { container } = render(<IntakeView {...sample()} readings={r} />);
    expect(container.textContent).toContain('6,325 m³/h'); // 5500 x (1 + 0.03 x 5)
  });

  it('HeaterView shows changeover progress from the reported ticks remaining', () => {
    const st = demoStatus({ fuel: { ...demoStatus().fuel, changeoverTo: 'backup', changeoverRemainingTicks: 4 } });
    const { container } = render(<HeaterView {...sample()} status={st} />);
    expect(container.textContent).toContain('Changing over to backup, 3 min left'); // 4 ticks x 40 s
    const unknown = demoStatus({ fuel: { ...demoStatus().fuel, changeoverTo: 'backup', changeoverRemainingTicks: null } });
    cleanup();
    expect(render(<HeaterView {...sample()} status={unknown} />).container.textContent).toContain('Changing over to backup, — left');
  });

  it('HeaterView explains a trip lockout, says what to do and offers Restart', () => {
    const { container, getByRole } = render(<HeaterView {...sample({ status: 'tripped', tripCause: 'noIntakeFlow' })} />);
    expect(container.textContent).toContain('Plant tripped: no intake flow');
    expect(container.textContent).toContain('The burner is locked out until the plant restarts.');
    expect(container.textContent).toContain('clean the intake screens');
    expect(getByRole('button', { name: 'Restart' })).toBeTruthy();
    cleanup();
    const online = render(<HeaterView {...sample()} />);
    expect(online.container.textContent).not.toContain('locked out');
    expect(online.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('FuelView lists deliveries in transit with their arrival in plant-minutes, and the curtailment notice', () => {
    const st = demoStatus({
      deliveries: [{ arrivesInTicks: 45, tonnes: 50, grade: 'standard' }, { arrivesInTicks: 90, tonnes: 20, grade: 'offgrade' }],
      fuel: { ...demoStatus().fuel, gasCurtailmentNotice: 'Gas capped at 40 MW from minute 200' },
      offeredGrade: 'offgrade',
    });
    const { container } = render(<FuelView {...sample()} status={st} />);
    const text = container.textContent;
    expect(text).toContain('50 t standard, arrives in 30 plant-min');
    expect(text).toContain('20 t off-grade, arrives in 60 plant-min');
    expect(text).toContain('Gas capped at 40 MW from minute 200');
    expect(text).toContain('Off-grade');
  });

  it('ShiftView shows the trip cause and restart step', () => {
    const st = demoStatus({ status: 'restarting', tripCause: 'tbtHighHigh', restartStep: 'recirc' });
    const { container } = render(<ShiftView {...sample()} status={st} />);
    expect(container.textContent).toContain('Restarting');
    expect(container.textContent).toContain('TBT high-high');
    expect(container.textContent).toContain('Recirculation');
  });

  it('ShiftView shows the last 20 events in plain language, newest first, skipping unknown types', () => {
    const base = { gameId: DEMO_GAME_ID, epoch: 0, tick: 1, plantTime: 3600, shiftId: 3 };
    const many: PlantEvent[] = Array.from({ length: 25 }, (_, i) => ({ ...base, seq: i, type: 'deliveryArrived', tonnes: i, grade: 'standard' }));
    const unknown = { ...base, seq: 99, type: 'meteorStrike', crater: 3 } as unknown as PlantEvent;
    const { container } = render(<ShiftView {...sample()} events={[...many, unknown]} />);
    const items = [...container.querySelectorAll('[data-event-log] li')].map((li) => li.textContent);
    expect(items).toHaveLength(20);
    expect(items[0]).toContain('24 t');
    expect(items[19]).toContain('5 t');
    expect(container.textContent).not.toMatch(/meteor/i);
  });
});

describe('divert and steam controls', () => {
  const withSend = (View: ComponentType<ExpandedProps>, props: ExpandedProps) => {
    const sent: Command[] = [];
    const utils = render(<View {...props} send={(c) => { sent.push(c); return true; }} pending={new Map()} />);
    return { ...utils, sent };
  };
  const rowValue = (root: HTMLElement, k: string) =>
    [...root.querySelectorAll('.detail__row')].find((r) => r.querySelector('dt')?.textContent === k)?.querySelector('dd');

  it('ProductView routing reads mode and direction for the four combinations', () => {
    const text = (divertMode: 'auto' | 'manual', divertToDrain: boolean) => {
      const { container } = render(<ProductView {...sample({ divertMode, divertToDrain })} />);
      const v = rowValue(container, 'Routing')!.textContent;
      cleanup();
      return v;
    };
    expect(text('auto', false)).toBe('Auto — to tank');
    expect(text('auto', true)).toBe('Auto — diverting');
    expect(text('manual', false)).toBe('Manual — to tank');
    expect(text('manual', true)).toBe('Manual — diverting');
  });

  it('ProductView: Divert mode toggle (on = Manual, like the loop mode toggles) sends setDivertMode; Divert to drain sends divertToDrain', () => {
    const { container, sent } = withSend(ProductView, sample({ divertMode: 'auto' }));
    const modeBtn = within(container).getByRole('button', { name: 'Divert mode' });
    expect(modeBtn.getAttribute('aria-pressed')).toBe('false');
    expect(modeBtn.textContent).toBe('Auto');
    fireEvent.click(within(container).getByRole('button', { name: 'Divert mode' }));
    fireEvent.click(within(container).getByRole('button', { name: 'Divert to drain' }));
    expect(sent).toEqual([{ type: 'setDivertMode', mode: 'manual' }, { type: 'divertToDrain', on: true }]);
    cleanup();
    const manual = withSend(ProductView, sample({ divertMode: 'manual' }));
    expect(within(manual.container).getByRole('button', { name: 'Divert mode' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(manual.container).getByRole('button', { name: 'Divert mode' }).textContent).toBe('Manual');
    fireEvent.click(within(manual.container).getByRole('button', { name: 'Divert mode' }));
    expect(manual.sent).toEqual([{ type: 'setDivertMode', mode: 'auto' }]);
  });

  it('StagesView shows Motive steam in bar with warn below 13 and bad below 11, and the ejector valve output', () => {
    const steam = (v: number) => {
      const { container } = render(<StagesView {...sample()} readings={demoReadings({ 'vacuum.motiveSteamBar': v })} />);
      const d = rowValue(container, 'Motive steam')!;
      cleanup();
      return [d.textContent, d.className];
    };
    expect(steam(14.5)).toEqual(['14.5 bar', '']);
    expect(steam(12.9)[1]).toBe('tone--warn');
    expect(steam(10.9)[1]).toBe('tone--bad');
    const { container } = render(<StagesView {...sample()} />);
    expect(rowValue(container, 'Ejector steam valve')!.textContent).toBe(`${Math.round(sample().status!.loops.vacuum!.output)} %`);
  });

  it('StagesView draws a Motive steam trend', () => {
    const { container } = render(<StagesView {...sample()} />);
    expect(container.querySelector('[data-trend="Motive steam"]')).not.toBeNull();
  });

  it('StagesView labels the manual vacuum control "Ejector steam valve", and the Standby steam line toggle sends standbySteam', () => {
    const st = sample();
    const vac = { ...st.status!.loops.vacuum!, mode: 'manual' as const };
    const { container, sent } = withSend(StagesView, { ...st, status: { ...st.status!, controlMode: 'manual', loops: { ...st.status!.loops, vacuum: vac } } });
    expect(container.querySelector('[data-control="Ejector steam valve"]')).not.toBeNull();
    expect(container.querySelector('[data-control="Vacuum output"]')).toBeNull();
    fireEvent.click(within(container).getByRole('button', { name: 'Standby steam line' }));
    expect(sent).toEqual([{ type: 'standbySteam', on: true }]);
    expect(container.querySelector('[data-control="Standby steam line"]')!.textContent).toContain('$150/h while on');
  });
});

describe('eventText', () => {
  const base = { gameId: DEMO_GAME_ID, epoch: 0, seq: 1, tick: 1, plantTime: 3600, shiftId: 3 };
  const SAMPLES: { [K in PlantEvent['type']]: Extract<PlantEvent, { type: K }> } = {
    shiftStart: { ...base, type: 'shiftStart', scenarioId: 'x', mode: 'auto', target: demoTarget, hell: false, orders: { targetM3: 1, maxSalinityPpm: 25, budgetUsd: 1, lines: [], briefing: [] } },
    shiftEnd: {
      ...base, type: 'shiftEnd',
      summary: {
        productM3: 3800, targetM3: 3900, offSpecMinutes: 0, offSpecM3: 0, fuelCostUsd: 9000, fuelBudgetUsd: 12000, trips: 0,
        spentUsd: 9500, nextAllocationUsd: 19000, balanceUsd: 12000, damage: { maxHardScaleMm: 0.2, pumpWear: { 'P-101': 0.1, 'P-102': 0.2, 'P-103': 0.1 }, burnerCondition: 0.9 }, hell: false, events: [],
      },
    },
    trip: { ...base, type: 'trip', cause: 'lossOfVacuum' },
    restartProgress: { ...base, type: 'restartProgress', step: 'ignition', ok: false, reason: 'TBT did not rise' },
    online: { ...base, type: 'online' },
    scenario: { ...base, type: 'scenario', eventId: 1, kind: 'bloom', message: 'Algal bloom in the intake water: chlorophyll rising toward 8 ug/L.', radio: 'Algal bloom.' },
    eventCleared: { ...base, type: 'eventCleared', eventId: 1, kind: 'bloom', how: 'player' },
    fuelChangeover: { ...base, type: 'fuelChangeover', from: 'gas', to: 'backup', phase: 'done' },
    deliveryArrived: { ...base, type: 'deliveryArrived', tonnes: 50, grade: 'offgrade' },
    commandRejected: { ...base, type: 'commandRejected', commandId: 'c', reason: 'insufficient funds' },
    damage: { ...base, type: 'damage', component: 'burner', value: 0.6 },
    gameStart: { ...base, type: 'gameStart', callSign: 'Kestrel-42', mode: 'normal' },
    gameRejected: { ...base, type: 'gameRejected', reason: 'capacity' },
    gameEnd: { ...base, type: 'gameEnd', callSign: 'Kestrel-42', mode: 'normal', reason: 'outOfFuel', score: { shiftsCompleted: 2, totalProductM3: 7000, balanceUsd: 100 } },
    accountChange: { ...base, type: 'accountChange', deltaUsd: -8000, balanceUsd: 4450, cause: 'overhaul' },
  };

  it('has a sample for every PlantEvent type in the schema', () => {
    const types = PlantEventSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(SAMPLES).sort()).toEqual(types);
  });

  it.each(Object.values(SAMPLES))('maps $type to a plain sentence', (e) => {
    const s = eventText(e);
    expect(s).toMatch(/^[A-Z].{8,}/);
    expect(s).not.toMatch(/NaN|undefined|null|\[object|[a-z][A-Z]/); // no camelCase ids leak through
  });

  it('eventCleared names the kind and how it ended', () => {
    expect(eventText({ ...SAMPLES.eventCleared, kind: 'pumpTrip', how: 'crew' })).toBe('Pump trip cleared: fixed by crew');
    expect(eventText({ ...SAMPLES.eventCleared, kind: 'tubeLeak', how: 'player' })).toBe('Tube leak cleared: cleared by you');
    expect(eventText({ ...SAMPLES.eventCleared, kind: 'storm', how: 'expired' })).toBe('Storm cleared: passed');
    expect(eventText({ ...SAMPLES.eventCleared, kind: 'sensorFailure', how: 'noted' })).toContain('Instrument failure');
  });
  it('an account change by the crew reads naturally', () => {
    expect(eventText({ ...SAMPLES.accountChange, cause: 'crew' })).toBe('Paid $8,000 for a crew job; balance $4,450');
  });
  it('the hourly standing cost reads as staff and standby, and counts toward the shift spend', () => {
    const standing = { ...SAMPLES.accountChange, deltaUsd: -90, cause: 'standing' as const };
    expect(eventText(standing)).toBe('Paid $90 for staff and standby; balance $4,450');
    expect(PlantEventSchema.parse(standing)).toEqual(standing);
    const shiftId = standing.shiftId!;
    expect(shiftAccount([standing, standing, SAMPLES.accountChange], shiftId)).toMatchObject({ standingUsd: 180, repairsUsd: 8000 });
  });
  it('the standby steam line cost reads as such and counts toward the shift spend, on its own line', () => {
    const steam = { ...SAMPLES.accountChange, deltaUsd: -150, cause: 'standbySteam' as const };
    expect(eventText(steam)).toBe('Paid $150 for the standby steam line; balance $4,450');
    expect(PlantEventSchema.parse(steam)).toEqual(steam);
    const shiftId = steam.shiftId!;
    expect(shiftAccount([steam, steam, SAMPLES.accountChange], shiftId)).toMatchObject({ standbySteamUsd: 300, standingUsd: 0, repairsUsd: 8000 });
    const status = { ...demoStatus(), shiftId } as PlantStatus;
    const { getByText } = render(<ShiftView {...empty} status={status} readings={{ 'fuel.shiftCostUsd': 1000 }} events={[steam]} />);
    expect(getByText('of which standby steam').nextSibling?.textContent).toBe('$150');
    expect(getByText('Spent this shift').nextSibling?.textContent).toBe('$1,150');
  });
  it('crew charges count toward the shift spend, on their own line', () => {
    const crew = { ...SAMPLES.accountChange, deltaUsd: -800, cause: 'crew' as const };
    const shiftId = crew.shiftId!;
    expect(shiftAccount([crew, crew, SAMPLES.accountChange], shiftId)).toMatchObject({ crewUsd: 1600, repairsUsd: 8000 });
    const status = { ...demoStatus(), shiftId } as PlantStatus;
    const { getByText } = render(<ShiftView {...empty} status={status} readings={{ 'fuel.shiftCostUsd': 1000 }} events={[crew]} />);
    expect(getByText('of which crew').nextSibling?.textContent).toBe('$800');
    expect(getByText('Spent this shift').nextSibling?.textContent).toBe('$1,800');
  });

  it('reads the way an operator would say it', () => {
    expect(eventText(SAMPLES.scenario)).toBe('Algal bloom in the intake water: chlorophyll rising toward 8 µg/L.');
    expect(eventText(SAMPLES.trip)).toBe('Plant tripped: loss of vacuum');
    expect(eventText(SAMPLES.accountChange)).toBe('Paid $8,000 for a pump overhaul; balance $4,450');
    expect(eventText(SAMPLES.restartProgress)).toBe('Restart step ignition failed: TBT did not rise');
    expect(eventText(SAMPLES.deliveryArrived)).toBe('Backup fuel delivery arrived: 50 t off-grade');
  });

  it('skips unknown types and survives malformed fields', () => {
    expect(eventText({ ...base, type: 'meteorStrike' } as unknown as PlantEvent)).toBeNull();
    expect(eventText(null as unknown as PlantEvent)).toBeNull();
    const bad = { ...base, type: 'trip', cause: 'constructor' } as unknown as PlantEvent;
    expect(eventText(bad)).toBe('Plant tripped');
    const bad2 = { ...base, type: 'accountChange', deltaUsd: NaN, balanceUsd: null, cause: 'toString' } as unknown as PlantEvent;
    expect(eventText(bad2)).not.toMatch(/NaN|null|undefined|function/);
  });
});

describe('Trend', () => {
  it('draws a sparkline over the points with the latest value', () => {
    const data = [{ t: 0, v: 1 }, { t: 1, v: 3 }, { t: 2, v: 2 }];
    const { container } = render(<Trend label="TBT" unit="°C" digits={1} data={data} />);
    expect(container.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(3);
    expect(container.textContent).toContain('2.0 °C');
  });

  it('skips non-finite points and shows "—" with no data', () => {
    const { container } = render(<Trend label="TBT" data={[{ t: 0, v: NaN }, { t: 1, v: 5 }]} />);
    expect(container.querySelector('polyline')!.getAttribute('points')!.split(' ')).toHaveLength(1);
    cleanup();
    const none = render(<Trend label="TBT" data={undefined} />).container;
    expect(none.textContent).toContain('—');
    expect(none.querySelector('polyline')).toBeNull();
  });
});

describe('ExpandedView', () => {
  it('opens the view for its monitor, and Back and Esc return to the wall', () => {
    const onClose = vi.fn();
    const { getByRole, container } = render(<ExpandedView id="stages" {...sample()} onClose={onClose} />);
    expect(container.querySelector('[data-expanded="stages"]')).not.toBeNull();
    expect(container.textContent).toContain('Flash Stages');
    fireEvent.click(getByRole('button', { name: /back/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('colours its frame by the monitor\'s worst alarm', () => {
    const alarms = [{ id: 'tbt', monitor: 'heater' as const, level: 'bad' as const, text: 'TBT high' }];
    const { container } = render(<ExpandedView id="heater" {...sample()} alarms={alarms} onClose={() => {}} />);
    expect(container.querySelector('[data-expanded]')!.className).toContain('expanded--bad');
  });
});

describe('?demo&open=', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('renders that expanded view with the fixture, and Back returns to the wall', () => {
    window.history.replaceState(null, '', '/?demo&open=stages');
    const { container, getByRole } = render(<App />);
    expect(container.querySelector('[data-expanded="stages"]')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: /back/i }));
    expect(container.querySelector('[data-expanded]')).toBeNull();
    expect(container.querySelectorAll('[data-monitor]')).toHaveLength(6);
  });

  it('ignores an unknown monitor name', () => {
    window.history.replaceState(null, '', '/?demo&open=constructor');
    const { container } = render(<App />);
    expect(container.querySelector('[data-expanded]')).toBeNull();
    expect(container.querySelectorAll('[data-monitor]')).toHaveLength(6);
  });
});
