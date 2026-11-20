import { createInterface } from 'node:readline';

// Windows process-start helper's line protocol, with a stable fixture token.
process.stdout.write('R\n');
for await (const _pid of createInterface({ input: process.stdin })) {
  process.stdout.write(`S:${process.env.FIXTURE_PROCESS_START}\n`);
}
