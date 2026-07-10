import { statusTone } from '../chartTheme';

// Status/category chip that maps any Striven status to the house pill tones
// (green ok / amber warn / red none / blue info). Uses the .pill-tag classes.
export function StatusPill({ status }: { status: string }) {
  if (!status) return <span className="pill-tag">—</span>;
  return <span className={`pill-tag tag-${statusTone(status)}`}>{status}</span>;
}
