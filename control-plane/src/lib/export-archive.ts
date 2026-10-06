import type { Archiver } from "archiver";
import type { Readable } from "node:stream";

// Archiver queues streams; append() alone does not consume the R2 response.
// Waiting for entry completion bounds open sockets and propagates read errors.
export function appendExportFile(
  archive: Archiver,
  source: Readable,
  name: string,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      archive.off("entry", complete);
      archive.off("error", fail);
      source.off("error", fail);
    };
    const fail = (error: Error) => {
      cleanup();
      source.destroy();
      reject(error);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    archive.once("entry", complete);
    archive.once("error", fail);
    source.once("error", fail);
    try {
      archive.append(source, { name });
    } catch (error) {
      fail(error as Error);
    }
  });
}
