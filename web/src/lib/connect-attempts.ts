/** The one sentence for a connection that failed for a reason other than the person ending it. */
export const CONNECT_FAILED = "We couldn't connect to that wallet. Try again or pick another one.";

/** How long after this window is back in front a pending connection is given to finish before the list is let go: long
 * enough for a wallet that is just answering, short enough that a popup closed before it could say so (Base Account's,
 * closed before its page loaded: its SDK then never settles the request) doesn't hold the list. */
export const RELEASE_AFTER_MS = 1_500;

type Thrown = { name?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };

/** A wallet's own words for an end by the person, as whole phrases. Never a bare "rejected", "denied" or "closed":
 * a lost connection ("WebSocket connection closed"), a blocked browser permission ("Permission denied", "Access is denied
 * for this document"), an extension that went away ("The message port closed...") and a rate limit ("Request rejected due
 * to rate limiting") say those too, and each of them is a failure the person is owed a sentence for (review of 0cfc42d,
 * finding 5). "Request rejected" alone is Base Account's answer for a popup the person closed. */
const BY_THE_PERSON = /\buser (rejected|denied|cancell?ed|closed)\b|\b(rejected|denied|cancell?ed|closed) by (the )?user\b|\b(popup|window) (was )?closed\b|^request rejected\.?$/i;

/** Whether a failed connection was ended by the person on this device: they rejected or denied the request, or closed the
 * wallet's own window or popup. EIP-1193's 4001 and viem's UserRejectedRequestError, wherever in the error's causes (wagmi's
 * injected and Base Account connectors turn a rejection and a closed popup into these); else the wallet's own words, as
 * whole phrases (BY_THE_PERSON), in its message, short message or details. Such an end is said nowhere: the person knows,
 * and the list is simply there to pick from again. Anything else is a failure and gets its sentence. */
export function endedByUser(e: unknown): boolean {
  let err = e as Thrown | null | undefined;
  for (let depth = 0; err && typeof err === "object" && depth < 6; depth++) {
    if (err.name === "UserRejectedRequestError" || err.code === 4001) return true;
    for (const text of [err.message, err.shortMessage, err.details]) if (typeof text === "string" && BY_THE_PERSON.test(text.trim())) return true;
    err = err.cause === err ? undefined : (err.cause as Thrown | undefined);
  }
  return false;
}

/** What the wallet list shows of the connection being made: the connector waited on (its row says so and offers
 * Cancel; every other row stays open), and the sentence for a failure that wasn't the person's own doing. */
export interface AttemptsView {
  pending: string | null;
  error: string | null;
}

export interface AttemptsPort {
  /** Starts connecting to the connector with this uid; settles when (if ever) the wallet answers. */
  connect(uid: string): Promise<unknown>;
  /** The list was let go of an attempt that hadn't settled: the caller puts the wallet library's own "connecting"
   * state back to rest. */
  released(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** The wallet list's connection attempts. The list never waits on a wallet's promise, which may never settle: one
 * attempt is current at a time, and Cancel, another wallet, closing the list, or this window coming back in front for
 * RELEASE_AFTER_MS with the attempt still unanswered each let it go, with nothing said (the person ended it). An attempt
 * let go is only forgotten here: if its wallet answers after all, a success still connects (the wallet library does
 * that itself) and a failure shows nothing. */
export function createConnectAttempts(port: AttemptsPort, onChange: (view: AttemptsView) => void) {
  let view: AttemptsView = { pending: null, error: null };
  /** The current attempt's number: a result is heeded only while its attempt is still the current one. */
  let attempt = 0;
  let timer: unknown;

  const set = (next: AttemptsView) => {
    if (next.pending === view.pending && next.error === view.error) return;
    view = next;
    onChange(view);
  };
  const stopTimer = () => {
    if (timer !== undefined) port.clearTimer(timer);
    timer = undefined;
  };
  /** Lets go of the current attempt, if one is pending: nothing is said. */
  const release = () => {
    stopTimer();
    if (view.pending === null) return;
    attempt++;
    set({ pending: null, error: view.error });
    port.released();
  };

  return {
    view: () => view,
    /** A wallet was picked: any attempt still pending is let go, and this one starts. */
    choose(uid: string) {
      stopTimer();
      const mine = ++attempt;
      set({ pending: uid, error: null });
      port.connect(uid).then(
        () => {
          if (mine === attempt) set({ pending: null, error: null });
        },
        (e) => {
          if (mine === attempt) set({ pending: null, error: endedByUser(e) ? null : CONNECT_FAILED });
        },
      );
    },
    /** Cancel on the pending row. */
    cancel: release,
    /** The list was closed (or another way of connecting took over): the attempt is let go and any sentence cleared. */
    closed() {
      release();
      set({ pending: null, error: null });
    },
    /** This window has focus again, or is visible again: a pending attempt gets RELEASE_AFTER_MS more, then is let
     * go. Never a plain timeout: while the person is still in the wallet's window, nothing here counts down. */
    windowBack() {
      if (view.pending === null || timer !== undefined) return;
      const mine = attempt;
      timer = port.setTimer(() => {
        timer = undefined;
        if (mine === attempt) release();
      }, RELEASE_AFTER_MS);
    },
    /** The window went behind again before the wait was over (the person is back in the wallet's): the wait is off. */
    windowAway: stopTimer,
    /** The list is gone from the page: late answers change nothing here. */
    dispose() {
      stopTimer();
      attempt++;
    },
  };
}

export type ConnectAttempts = ReturnType<typeof createConnectAttempts>;
