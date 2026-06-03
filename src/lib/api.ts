import { isTauri } from './backend/detect';
import { tauriBackend } from './backend/tauri';
import { idbBackend } from './backend/idb';

export const api = isTauri() ? tauriBackend : idbBackend;

// Named export kept for existing callers in NotesEditor.svelte.
export const saveTaskNoteImage = (id: string, blob: Blob) => api.saveTaskNoteImage(id, blob);
