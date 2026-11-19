import { cleanup, fireEvent, render } from '@testing-library/react';
import type { PlantStatus } from '@desal/schema';
import { demoStatus } from '../src/demo';
import { QuotaBar } from '../src/screens/QuotaBar';
import { Radio } from '../src/screens/Radio';
import { initialRadio, radioReducer } from '../src/state/radio';

afterEach(cleanup);

const target: PlantStatus['shiftTarget'] = { productM3: 2000, maxSalinityPpm: 25, fuelBudgetUsd: 10000 };
const behind = (over: Partial<PlantStatus> = {}) =>
  demoStatus({ phase: 'running', shiftTarget: target, shiftProductM3: 500, productFlowM3h: 100, shiftTicksRemaining: 360, shiftOffSpecM3: 0, crew: null, ...over });

describe('QuotaBar', () => {
  it('shows BEHIND for a behind fixture, with progress text and time left', () => {
    const { container, getByText } = render(<QuotaBar status={behind()} />);
    expect(getByText('BEHIND')).toBeTruthy();
    expect(container.textContent).toContain('500 / 2,000 m³');
    expect(container.textContent).toContain('4h 00m left');
  });
  it('shows the off-spec note only when off-spec water exists', () => {
    const a = render(<QuotaBar status={behind({ shiftOffSpecM3: 120 })} />);
    expect(a.container.textContent).toContain('+120 m³ off-spec, not counted');
    a.unmount();
    const b = render(<QuotaBar status={behind()} />);
    expect(b.container.textContent).not.toContain('off-spec');
  });
  it('shows the crew job with minutes left', () => {
    const { container } = render(<QuotaBar status={behind({ crew: { job: 'plugTubes', remainingTicks: 45 } })} />);
    expect(container.textContent).toContain('30 min left');
  });
  it('shows TARGET MET and handles a zero target and zero time without NaN', () => {
    const met = render(<QuotaBar status={behind({ shiftProductM3: 2500 })} />);
    expect(met.getByText('TARGET MET')).toBeTruthy();
    met.unmount();
    const edge = render(<QuotaBar status={behind({ shiftTicksRemaining: 0 })} />);
    expect(edge.getByText('OUT OF REACH')).toBeTruthy();
    expect(edge.container.textContent).not.toContain('NaN');
    edge.unmount();
    const zero = render(<QuotaBar status={behind({ shiftTarget: null })} />);
    expect(zero.container.textContent).not.toContain('NaN');
  });
  it('renders nothing in handover or without a status', () => {
    expect(render(<QuotaBar status={behind({ phase: 'handover' })} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<QuotaBar status={null} />).container.innerHTML).toBe('');
  });
});

describe('Radio', () => {
  it('shows the message and a click opens its monitor', () => {
    const radio = radioReducer(initialRadio, { type: 'push', eventId: 1, kind: 'tubeLeak', text: 'Salt in the product line' });
    const onOpen = vi.fn();
    const onExpire = vi.fn();
    const { getByText } = render(<Radio radio={radio} onExpire={onExpire} onOpen={onOpen} />);
    fireEvent.click(getByText(/Salt in the product line/));
    expect(onOpen).toHaveBeenCalledWith('product');
    expect(onExpire).toHaveBeenCalled();
  });
  it('expires after 6 s', () => {
    vi.useFakeTimers();
    const radio = radioReducer(initialRadio, { type: 'push', eventId: 1, kind: 'storm', text: 'x' });
    const onExpire = vi.fn();
    render(<Radio radio={radio} onExpire={onExpire} onOpen={() => {}} />);
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
