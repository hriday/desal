/** The top of a clipboard sheet (shift log, final report): the board's clip, a small kicker and the title. */
export function SheetHead({ kicker, title, id }: { kicker: string; title: string; id: string }) {
  return (
    <header className="sheet__head">
      <span className="sheet__clip" aria-hidden="true" />
      <p className="sheet__kicker">{kicker}</p>
      <h1 id={id}>{title}</h1>
    </header>
  );
}
