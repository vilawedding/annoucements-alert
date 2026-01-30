// preload.js
if (globalThis.File === undefined) {
    class File extends Blob {
      constructor(chunks, filename, options = {}) {
        super(chunks, options);
        this.name = filename;
        this.lastModified = options.lastModified || Date.now();
      }
    }
    globalThis.File = File;
  }