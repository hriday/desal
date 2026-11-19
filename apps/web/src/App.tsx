// Placeholder screens; replaced by the real screens in later tasks.
export type Screen = 'start' | 'handover' | 'room' | 'over';

export function App({ screen = 'start' }: { screen?: Screen }) {
  return (
    <main>
      <h1>Desalination Control Room</h1>
      <p data-screen={screen}>Screen: {screen}</p>
    </main>
  );
}
