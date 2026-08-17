/**
 * Typed errors.
 *
 * Everything the user could ever see must carry a code that maps to a written,
 * honest explanation — FrameScript never surfaces a stack trace and never
 * pretends a platform limitation is a transient glitch.
 */

export type FrameScriptErrorCode =
  | 'PLAYER_NOT_FOUND'
  | 'QUALITY_MENU_NOT_FOUND'
  | 'QUALITY_OPTION_NOT_FOUND'
  | 'QUALITY_VERIFICATION_FAILED'
  | 'CAPTION_CONTAINER_NOT_FOUND'
  | 'TAB_CAPTURE_FAILED'
  | 'AUDIO_SOURCE_UNAVAILABLE'
  | 'VIDEO_SOURCE_UNAVAILABLE'
  | 'PROTECTED_CONTENT'
  | 'OFFSCREEN_FAILED'
  | 'AI_PROVIDER_FAILED'
  | 'AI_RESPONSE_INVALID'
  | 'PLATFORM_UPDATED'
  | 'PERMISSION_DENIED'
  | 'STORAGE_FAILED'
  | 'MESSAGE_INVALID'
  | 'UNSUPPORTED';

export interface FrameScriptErrorInit {
  code: FrameScriptErrorCode;
  /** Internal, developer-facing detail. Never rendered verbatim to the user. */
  detail?: string;
  cause?: unknown;
  /** True when retrying the same operation could plausibly succeed. */
  recoverable?: boolean;
}

export class FrameScriptError extends Error {
  readonly code: FrameScriptErrorCode;
  readonly detail: string | undefined;
  readonly recoverable: boolean;

  constructor(init: FrameScriptErrorInit) {
    super(init.detail ? `${init.code}: ${init.detail}` : init.code, { cause: init.cause });
    this.name = 'FrameScriptError';
    this.code = init.code;
    this.detail = init.detail;
    this.recoverable = init.recoverable ?? false;
  }

  static is(value: unknown): value is FrameScriptError {
    return value instanceof FrameScriptError;
  }
}

/**
 * User-facing copy for every error code.
 *
 * These are deliberately specific about what stops working and what keeps
 * working, because a screenplay built from three of four sources is still
 * useful and the user needs to know which is which.
 */
const USER_MESSAGES: Record<FrameScriptErrorCode, string> = {
  PLAYER_NOT_FOUND:
    "FrameScript couldn't find the video player on this page. It will keep watching for one.",
  QUALITY_MENU_NOT_FOUND:
    'YouTube appears to have changed its quality controls. Automatic quality selection could not be verified.',
  QUALITY_OPTION_NOT_FOUND:
    'The requested quality is not offered for this video. FrameScript selected the closest available option.',
  QUALITY_VERIFICATION_FAILED:
    'FrameScript selected a quality but could not confirm the player applied it.',
  CAPTION_CONTAINER_NOT_FOUND:
    'No subtitle track is currently displayed, so subtitle evidence is unavailable. Turn subtitles on in the player to include them.',
  TAB_CAPTURE_FAILED:
    'Chrome declined to share this tab’s media with FrameScript. Analysis needs to be started from the FrameScript popup or side panel.',
  AUDIO_SOURCE_UNAVAILABLE:
    'Audio analysis is unavailable for this tab. The screenplay will continue from the remaining sources.',
  VIDEO_SOURCE_UNAVAILABLE:
    'Video analysis is unavailable for this tab. The screenplay will continue from the remaining sources.',
  PROTECTED_CONTENT:
    "FrameScript couldn't access the video image in this protected playback environment. Audio and subtitle analysis will continue.",
  OFFSCREEN_FAILED:
    'FrameScript could not start its media analysis document. Try stopping and restarting analysis.',
  AI_PROVIDER_FAILED:
    'The configured AI provider could not be reached. Local analysis continues; deep scene understanding is paused.',
  AI_RESPONSE_INVALID:
    'The AI provider returned a response FrameScript could not verify, so it was discarded rather than guessed at.',
  PLATFORM_UPDATED:
    'This streaming site appears to have changed. Some FrameScript features may be degraded until they are updated.',
  PERMISSION_DENIED: 'FrameScript needs permission for this action and it was not granted.',
  STORAGE_FAILED: 'FrameScript could not save to local storage. Your screenplay may not persist.',
  MESSAGE_INVALID: 'An internal FrameScript message was malformed and was ignored.',
  UNSUPPORTED: 'This is not supported in the current browser or on this page.',
};

export function userMessageFor(code: FrameScriptErrorCode): string {
  return USER_MESSAGES[code];
}

/** Converts anything thrown into a user-safe description. Never leaks a stack. */
export function describeError(error: unknown): { code: FrameScriptErrorCode; message: string } {
  if (FrameScriptError.is(error)) {
    return { code: error.code, message: userMessageFor(error.code) };
  }
  return { code: 'UNSUPPORTED', message: USER_MESSAGES.UNSUPPORTED };
}

/** Developer-facing detail extraction for diagnostics/logging only. */
export function errorDetail(error: unknown): string {
  if (FrameScriptError.is(error)) return error.detail ?? error.code;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
