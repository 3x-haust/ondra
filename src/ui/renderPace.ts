/** When the next re-render of streaming text may come: twice as long after this one as it took, at most 2 s. */
export const nextRender = (doneAt: number, cost: number) => doneAt + Math.min(2000, Math.max(0, cost) * 2);
