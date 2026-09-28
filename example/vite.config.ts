import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      start: {
        command: 'oxnode ./src/index.ts',
        dependsOn: ['cyrenejs#build'],
      },
    },
  },
});
