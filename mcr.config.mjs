import { stripTypeScriptTypes } from 'node:module';

const strip = (entry) => {
  if (entry.url.endsWith('.ts')) entry.source = stripTypeScriptTypes(entry.source);
};

export default {
  name: 'slicc-kernel-unit',
  outputDir: 'coverage/unit',
  reports: ['lcovonly', 'console-details'],
  all: { dir: 'src', filter: '**/*.ts', transformer: strip },
  entryFilter: (entry) => entry.url.includes('/src/') && entry.url.endsWith('.ts'),
  onEntry: strip,
};
