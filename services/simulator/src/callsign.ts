import { nextRandom } from './rng.js';

/** The words of a call sign: 40 sea and shore birds, 24 weather and sea adjectives. */
export const CALL_SIGN_WORDS: readonly string[] = Object.freeze([
  'Kestrel', 'Petrel', 'Heron', 'Osprey', 'Tern', 'Gannet', 'Plover', 'Curlew',
  'Egret', 'Falcon', 'Merlin', 'Harrier', 'Shrike', 'Swift', 'Martin', 'Puffin',
  'Fulmar', 'Shearwater', 'Albatross', 'Cormorant', 'Sandpiper', 'Dunlin', 'Godwit', 'Avocet',
  'Ibis', 'Crane', 'Stork', 'Pelican', 'Skua', 'Kittiwake', 'Guillemot', 'Razorbill',
  'Lapwing', 'Oriole', 'Wren', 'Robin', 'Finch', 'Lark', 'Starling', 'Kingfisher',
  'Brisk', 'Steady', 'Calm', 'Clear', 'Bright', 'Gusty', 'Misty', 'Salty',
  'Breezy', 'Sunny', 'Stormy', 'Balmy', 'Crisp', 'Coastal', 'Tidal', 'Northern',
  'Southern', 'Azure', 'Silver', 'Golden', 'Rapid', 'Bold', 'Keen', 'Hardy',
]);

/** Mixed into the seed so the call sign's draws are not the game's own first draws. */
const CALL_SIGN_SALT = 0x5eed5;

/**
 * A run's public name, e.g. `Kestrel-42` (a word and a number in 10..99), derived from the game seed.
 * It runs its own RNG from a salted copy of the seed and never writes back to the state, so the
 * game's own draws (s.seed) are unchanged by it.
 */
export function callSignFor(seed: number): string {
  const [w, next] = nextRandom((seed ^ CALL_SIGN_SALT) >>> 0);
  const [n] = nextRandom(next);
  const word = CALL_SIGN_WORDS[Math.floor(w * CALL_SIGN_WORDS.length)]!;
  return `${word}-${10 + Math.floor(n * 90)}`;
}
