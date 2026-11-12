/** Ondra is in beta until 1.0: every 0.x version (and a "-beta" one) shows a 베타 mark. */
export const isBeta = (version: string) => /^v?0\./.test(version.trim()) || /-beta/i.test(version);
