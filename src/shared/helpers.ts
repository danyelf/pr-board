// Small helpers the Worker, the page and the Mac side all use.

/** The latest of some ISO times. */
export function newest(times: string[]): string {
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

/** An error as text: its message, or the thing itself when it isn't an Error. */
export const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
