// A dropped connection (Wi-Fi gone, the lid closed, a proxy hiccup) is not a
// failed job: wait until the network is back and carry on in the same session.

/** Errors that mean the request never got through or was cut, not that the model or the request was wrong. */
const NET =
  /fetch failed|network ?error|networkerror|load failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|socket hang up|other side closed|premature close|connection (error|reset|closed|lost|refused)|terminated|timed out|request timeout|\b(502|503|504)\b|bad gateway|service unavailable|gateway time-?out|overloaded|unable to connect|able to access the url|ConnectionRefused|ConnectionClosed/i;

export const isNetError = (message: string) => NET.test(message);

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

/**
 * Whether the internet answers: GitHub's API root, which the app already talks to (the only
 * outside host its content policy lets it reach besides telemetry). Any answer counts (an opaque
 * one too); none within 4 s means not yet. Only asked while a job waits on a dropped connection.
 */
export async function reachable(): Promise<boolean> {
  if (!online()) return false;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 4_000);
  try {
    await fetch("https://api.github.com/", { mode: "no-cors", cache: "no-store", signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait until the network answers again, looking every few seconds: a Mac waking from sleep gets
 * it back within a minute, and a blind wait that doubles each try kept a job stuck for minutes
 * after it was back (the user typed "계속해"). Never longer than a few seconds up to five minutes
 * (longer each try), and while offline, until it is back.
 */
export function waitOnline(tries: number, probe: () => Promise<boolean> = reachable): Promise<void> {
  const most = Math.min(300_000, 5_000 * 2 ** Math.max(0, tries - 1));
  const start = Date.now();
  return new Promise((done) => {
    const look = async () => {
      if (online() && (await probe().catch(() => false))) return done();
      if (Date.now() - start >= most && online()) return done();
      setTimeout(() => void look(), 3_000);
    };
    setTimeout(() => void look(), 2_000);
  });
}
