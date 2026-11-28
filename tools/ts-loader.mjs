import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

const hook = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.\\w+$/.test(specifier)) {
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(specifier + suffix, context);
        }
      }
    }
    throw err;
  }
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`);
void existsSync;
void fileURLToPath;
