// A dropped connection (Wi-Fi gone, the lid closed, a proxy hiccup) is not a
// failed job: wait until the network is back and carry on in the same session.

/** Errors that mean the request never got through or was cut, not that the model or the request was wrong. */
const NET =
  /fetch failed|network ?error|networkerror|load failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|socket hang up|other side closed|premature close|connection (error|reset|closed|lost|refused)|terminated|timed out|request timeout|\b(502|503|504)\b|bad gateway|service unavailable|gateway time-?out|overloaded|unable to connect|able to access the url|ConnectionRefused|ConnectionClosed/i;

export const isNetError = (message: string) => NET.test(message);

/** Wait from a few seconds up to five minutes (longer each try), and while offline until the network is back. */
export function waitOnline(tries: number): Promise<void> {
  const ms = Math.min(300_000, 5_000 * 2 ** Math.max(0, tries - 1));
  return new Promise((done) => {
    const after = () => setTimeout(done, 3_000);
    const timer = setTimeout(() => {
      if (navigator.onLine) done();
      else window.addEventListener("online", after, { once: true });
    }, ms);
    if (!navigator.onLine) {
      clearTimeout(timer);
      window.addEventListener("online", after, { once: true });
    }
  });
}
