import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | undefined;

/** One expanded view: the large drawing beside its detail, then trends, then controls. */
export function ViewLayout({ drawing, detail, trends, controls, children }: {
  drawing: ReactNode; detail: ReactNode; trends: ReactNode; controls?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="xv">
      <div className="xv__drawing">{drawing}</div>
      <div className="xv__detail">{detail}</div>
      {children && <div className="xv__wide">{children}</div>}
      <div className="xv__trends">{trends}</div>
      <section className="xv__controls" data-controls aria-label="Controls">{controls}</section>
    </div>
  );
}

/** A labelled list of readouts. */
export function Detail({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="detail">
      {title && <h3 className="detail__title">{title}</h3>}
      <dl className="detail__list">{children}</dl>
      {note && <p className="ctl__meta">{note}</p>}
    </section>
  );
}

/** One readout; `tone` colours the value by status. */
export function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: Tone }) {
  return (
    <div className="detail__row">
      <dt>{k}</dt>
      <dd className={tone && tone !== 'ok' ? `tone--${tone}` : undefined}>{v}</dd>
    </div>
  );
}
