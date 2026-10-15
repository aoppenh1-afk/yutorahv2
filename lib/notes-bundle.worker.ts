import { createNotesBundlePdf, type NotesBundleDocument } from './notes-pdf';

self.onmessage = async (event: MessageEvent<NotesBundleDocument>) => {
  try {
    self.postMessage({ blob: await createNotesBundlePdf(event.data) });
  } catch {
    self.postMessage({ error: true });
  }
};
