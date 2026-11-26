// Passkeys for the in-app browser: WebAuthn calls go to Ondra's own passkeys (see passkeys.rs)
// through the `ondraPasskey` message handler. Popups share the opener's scripts, so this may run
// twice in one page: the first run wins.
(() => {
  if (window.__ondraPasskeys || !window.PublicKeyCredential || !navigator.credentials) return;
  Object.defineProperty(window, '__ondraPasskeys', { value: true });

  const handler = () => window.webkit?.messageHandlers?.ondraPasskey;
  const bytes = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  const b64 = (v) => {
    let s = '';
    for (const c of bytes(v)) s += String.fromCharCode(c);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = (s) => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const own = (proto, props) => {
    const o = Object.create(proto);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: typeof v !== 'function' });
    return o;
  };
  const aborted = (signal) => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

  // what the page passed, in the shape passkeys.rs reads
  const request = (op, pk) =>
    op === 'create'
      ? {
          op,
          rpId: pk.rp?.id ?? null,
          userId: b64(pk.user.id),
          userName: pk.user.name ?? '',
          displayName: pk.user.displayName ?? '',
          challenge: b64(pk.challenge),
          algs: (pk.pubKeyCredParams ?? []).map((p) => p.alg),
          exclude: (pk.excludeCredentials ?? []).map((c) => b64(c.id)),
        }
      : { op, rpId: pk.rpId ?? null, challenge: b64(pk.challenge), allow: (pk.allowCredentials ?? []).map((c) => b64(c.id)) };

  const credential = (op, r, extensions) => {
    const ext = extensions?.credProps ? { credProps: { rk: true } } : {};
    const json = {
      id: r.id,
      rawId: r.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: ext,
      response:
        op === 'create'
          ? { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, transports: ['internal'], publicKey: r.publicKey, publicKeyAlgorithm: -7 }
          : { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle },
    };
    const response =
      op === 'create'
        ? own(AuthenticatorAttestationResponse.prototype, {
            clientDataJSON: unb64(r.clientDataJSON),
            attestationObject: unb64(r.attestationObject),
            getTransports: () => ['internal'],
            getAuthenticatorData: () => unb64(r.authenticatorData),
            getPublicKey: () => unb64(r.publicKey),
            getPublicKeyAlgorithm: () => -7,
          })
        : own(AuthenticatorAssertionResponse.prototype, {
            clientDataJSON: unb64(r.clientDataJSON),
            authenticatorData: unb64(r.authenticatorData),
            signature: unb64(r.signature),
            userHandle: r.userHandle ? unb64(r.userHandle) : null,
          });
    return own(PublicKeyCredential.prototype, {
      id: r.id,
      rawId: unb64(r.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => ext,
      toJSON: () => json,
    });
  };

  const run = (op, options) => {
    const pk = options.publicKey;
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(aborted(signal));
    // no passkey list in the page's autofill: a conditional request waits until the page drops it
    if (op === 'get' && options.mediation === 'conditional') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(aborted(signal)), { once: true }));
    }
    let message;
    try {
      message = JSON.stringify(request(op, pk));
    } catch {
      return Promise.reject(new TypeError('Invalid publicKey options'));
    }
    const asked = handler()
      .postMessage(message)
      .then((reply) => {
        const r = JSON.parse(reply);
        if (r.error) throw new DOMException(r.message, r.error);
        return credential(op, r, pk.extensions);
      });
    if (!signal) return asked;
    return Promise.race([asked, new Promise((_, reject) => signal.addEventListener('abort', () => reject(aborted(signal)), { once: true }))]);
  };

  const container = navigator.credentials;
  const original = { create: container.create.bind(container), get: container.get.bind(container) };
  for (const op of ['create', 'get']) {
    Object.defineProperty(container, op, {
      configurable: true,
      writable: true,
      value: (options) => (options?.publicKey && handler() ? run(op, options) : original[op](options)),
    });
  }
  const answer = (fn) => Object.defineProperty(PublicKeyCredential, fn.name, { configurable: true, writable: true, value: fn });
  answer(async function isUserVerifyingPlatformAuthenticatorAvailable() {
    return !!handler();
  });
  answer(async function isConditionalMediationAvailable() {
    return false;
  });
  answer(async function getClientCapabilities() {
    const on = !!handler();
    return { conditionalCreate: false, conditionalGet: false, hybridTransport: false, passkeyPlatformAuthenticator: on, userVerifyingPlatformAuthenticator: on, relatedOrigins: false, signalAllAcceptedCredentials: false, signalCurrentUserDetails: false, signalUnknownCredential: false };
  });
})();
