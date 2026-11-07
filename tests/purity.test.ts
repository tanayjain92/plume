import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AGENTS.md rule 1: the solver folder stays pure (no UI, DOM, worker globals,
// randomness or wall clock), so it is testable and portable to WebGPU.
const SOLVER_DIR = join(__dirname, '..', 'src', 'solver');

const FORBIDDEN: [RegExp, string][] = [
  [/from\s+['"]react(-dom)?(\/[^'"]*)?['"]/, 'React import'],
  [/from\s+['"]\.\.\/(ui|worker)\//, 'import from ui/ or worker/'],
  [/\b(document|window|navigator|localStorage)\s*\./, 'DOM global'],
  [/\bself\s*\.|\bpostMessage\s*\(|\bimportScripts\s*\(/, 'worker global'],
  [/\bMath\.random\s*\(/, 'Math.random (breaks determinism)'],
  [/\b(Date\.now|performance\.now)\s*\(/, 'wall clock (breaks determinism)'],
];

describe('solver purity', () => {
  const files = readdirSync(SOLVER_DIR).filter((f) => f.endsWith('.ts'));

  it('finds solver sources', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    it(`${file} has no UI, DOM, worker, random or clock dependencies`, () => {
      const src = readFileSync(join(SOLVER_DIR, file), 'utf8');
      const hits = FORBIDDEN.filter(([re]) => re.test(src)).map(([, why]) => why);
      expect(hits).toEqual([]);
    });
  }
});
