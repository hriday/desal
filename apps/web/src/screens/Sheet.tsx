/**
 * The top of a clipboard sheet (shift log, final report): the board's clip, a small kicker, the title
 * and the run's call sign, signed in the corner.
 */
export function SheetHead({ kicker, title, id, sign }: { kicker: string; title: string; id: string; sign?: string | null }) {
  return (
    <header className="sheet__head">
      <span className="sheet__clip" aria-hidden="true" />
      <p className="sheet__kicker">{kicker}</p>
      <h1 id={id}>{title}</h1>
      {sign && <p className="sheet__sign"><span className="sheet__signk">Operator</span> {sign}</p>}
    </header>
  );
}
