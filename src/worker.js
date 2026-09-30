import { expandInputs } from './imports.js';
import { analyzeMailbox } from './mailbox.js';

self.onmessage = async ({ data }) => {
  try {
    let result;
    if (data.operation === 'expand') {
      const inputs = data.files.map(({ file, path }) => Object.assign(file, { sourcePath: path }));
      const expanded = await expandInputs(inputs);
      result = { warnings: expanded.warnings, files: expanded.files.map(file => ({ blob: file, path: file.sourcePath || file.name, name: file.name, size: file.size, lastModified: file.lastModified || 0 })) };
    } else if (data.operation === 'analyze') {
      const seen = new Set(data.seen || []);
      let lastProgress = 0;
      result = await analyzeMailbox(data.file, { seen, sentHint: data.sentHint, onProgress: progress => {
        const now = Date.now();
        if (now - lastProgress >= 100 || progress.bytesRead === progress.totalBytes) {
          self.postMessage({ progress }); lastProgress = now;
        }
      } });
      result.seen = [...seen];
    } else throw new Error('Unknown worker operation');
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error.message }); }
};
