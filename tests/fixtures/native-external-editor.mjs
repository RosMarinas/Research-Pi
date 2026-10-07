// Offline physical-terminal test: this replaces a real editor, without model calls.
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv.at(-1),'External editor returned through native client\n');
