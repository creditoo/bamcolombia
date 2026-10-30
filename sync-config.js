/**
 * Cloud sync — HARDCODED default room (zero setup).
 *
 * Admin + flow always share `room` out of the box on GitHub Pages / ZIP / local.
 * No "Usar sala", no ?sala= required. Opening the site just works worldwide.
 *
 * Transport: public ntfy.sh topic bc-bam-{room} (no API keys).
 * Optional: set firebaseUrl to a Realtime Database REST root.
 */
window.BcSyncConfig = {
  /** Shared worldwide room — do not leave empty. */
  room: "bamcolombia",
  /** Force this room on every load (ignore stale localStorage). */
  lockRoom: true,
  ntfy: "https://ntfy.sh",
  /** Optional Firebase RTDB root (no trailing slash). Leave "" for ntfy only. */
  firebaseUrl: "",
  pollMs: 3500,
  maxRemoteRecords: 12,
};
