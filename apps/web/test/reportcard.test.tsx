import { cleanup, render } from '@testing-library/react';
import { FIX } from '../src/expanded/labels';
import { ReportCard } from '../src/screens/ReportCard';
import { report } from './fixtures';

afterEach(cleanup);

describe('ReportCard', () => {
  it('shows the grade, one row per event with its outcome and verdict, and the pace sparkline', () => {
    const { getByRole, container } = render(<ReportCard report={report()} wait={null} />);
    const card = getByRole('region', { name: 'Report card' });
    expect(card.querySelector('[data-grade]')!.textContent).toBe('B');
    const rows = card.querySelectorAll('[aria-label="Graded events"] > li');
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('cleared by you');
    expect(rows[0]!.textContent).toContain('quick');
    expect(rows[1]!.textContent).toContain('fixed by crew');
    expect(rows[1]!.textContent).toContain('ok');
    expect(rows[2]!.textContent).toContain('slow');
    expect(rows[3]!.textContent).toContain('not cleared');
    expect(rows[3]!.textContent).toContain('missed');
    expect(rows[4]!.textContent).toContain('noted');
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('[data-pace-point]')).toHaveLength(8);
  });

  it('puts the FIX text under slow and missed verdicts only', () => {
    const { getByRole } = render(<ReportCard report={report()} wait={null} />);
    const rows = getByRole('region', { name: 'Report card' }).querySelectorAll('[aria-label="Graded events"] > li');
    expect(rows[2]!.textContent).toContain(FIX.vacuumLoss.text);
    expect(rows[3]!.textContent).toContain(FIX.storm.text);
    for (const i of [0, 1, 4]) expect(rows[i]!.textContent).not.toContain('What to do');
    expect(rows[0]!.textContent).not.toContain(FIX.pumpTrip.text);
    expect(rows[1]!.textContent).not.toContain(FIX.tubeLeak.text);
    expect(rows[4]!.textContent).not.toContain(FIX.earthquake.text);
  });

  it('tags a Hard run HARD, and a Normal one not', () => {
    const hard = render(<ReportCard report={report({ mode: 'hard' })} wait={null} />);
    expect(hard.queryByText('HARD')).not.toBeNull();
    cleanup();
    const normal = render(<ReportCard report={report()} wait={null} />);
    expect(normal.queryByText('HARD')).toBeNull();
  });

  it('compares with the last shift, and leaves it out when there is none (shift 1)', () => {
    const withPrev = render(<ReportCard report={report()} wait={null} />);
    expect(withPrev.container.textContent).toContain('vs last shift');
    cleanup();
    const first = render(<ReportCard report={report({ shiftId: 1, vsPrevious: null, vsBest: null })} wait={null} />);
    expect(first.container.textContent).not.toContain('vs last shift');
  });

  it('shows "Grading…" while waiting, nothing after the wait expires, and a late report when it comes', () => {
    const r = render(<ReportCard report={undefined} wait="waiting" />);
    expect(r.container.textContent).toContain('Grading…');
    r.rerender(<ReportCard report={undefined} wait="expired" />);
    expect(r.container.textContent).toBe('');
    r.rerender(<ReportCard report={report()} wait="expired" />);
    expect(r.getByRole('region', { name: 'Report card' })).toBeTruthy();
  });
});
